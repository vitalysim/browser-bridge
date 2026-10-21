/// <reference types="chrome" />

import { NetRing, applyRedirectResponse, capBody, Semaphore, type NetEntry } from "./net-capture.js";
// Self-contained injected page helpers, kept in their own files so the two hot files stay small:
// bbAct is the ONE find-and-act helper the interaction tools share; bbAxSnapshot is the ARIA walker.
import { bbAct, type BbActParams } from "./dom-act";
import { CDP_MODS, keyInfo, parseKeyCombo, pickFocusedFrame, matchCdpFrame, type FocusProbe } from "./act-logic";
import { bbAxSnapshot } from "./ax";
import { buildReplayHeaders } from "./replay-headers";
import { bbWatchMainShim } from "./watch-main-shim";
import { allocateFrameBudgets, assignAxRefs, clampLimit, frameOffsets, pickSelectorTarget, routeRef, SNAPSHOT_DEFAULT_LIMIT, SNAPSHOT_MAX_LIMIT, type LocateMatch, type RefRoute } from "./snapshot-plan";
import { emulateDevice, emulateNetwork, emulateCpu, emulateLocale, emulateGeolocation, emulateReset, hasEmulation, emulationState, forgetEmulation } from "./emulate.js";
import { WsAuthClient, WS_AUTH_FAILED_CLOSE_CODE, WS_AUTH_TIMEOUT_CLOSE_CODE } from "./ws-auth";

// Injected at build time by build.mjs (esbuild define) from extension/package.json - single
// source of truth shared with manifest.json, so the version can't drift.
declare const __BB_VERSION__: string;
declare const __BB_BUILD__: string;
const VERSION = __BB_VERSION__;
const BUILD_AT = __BB_BUILD__;
const PING_INTERVAL_MS = 20_000; // WS traffic resets the MV3 service-worker idle timer (Chrome 116+)
// Capped low: the server waits only ~3s for a reconnect before failing a call, and most SW restarts
// reconnect within ~1s, so a long backoff just turned a server blip into minutes of NO_EXTENSION.
const RECONNECT_MAX_MS = 5_000;
// The server closes the OLDER socket with 4000 when another connection with the same token arrives
// (e.g. two Chrome profiles both configured). Reconnecting immediately would just evict the other one
// again, forever - so back off for a long while instead.
const REPLACED_CLOSE_CODE = 4000;
const RECONNECT_REPLACED_MS = 60_000;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Synchronous in-flight guard for connect(). The OPEN/CONNECTING check below runs BEFORE an await, so
// two callers in the same tick (storage.onChanged + a reconnect message, onStartup + an alarm) would
// each open a second socket - a race that leaves a superseded socket flipping status underneath the
// live one. Setting this before the await closes that window.
let connecting = false;

// A reply frame larger than the server's maxPayload (256 MiB) would close the socket with 1009 and
// fail every in-flight call, so anything past this threshold is refused with a structured error
// instead. Generous enough for a full-page screenshot / MHTML / HAR, far under the server's cap.
const REPLY_MAX_BYTES = 64 * 1024 * 1024;

function setStatus(status: string, detail = "") {
  chrome.storage.local.set({ bbStatus: status, bbDetail: detail, bbUpdated: Date.now() });
}

// ---- timeouts ----
// No chrome.* call is guaranteed to settle: executeScript blocks while the page shows a JS dialog
// (alert/confirm/prompt/beforeunload) or its renderer is hung, and debugger commands can wedge the same
// way. Every such call goes through withTimeout so the agent gets an actionable error instead of a hang.

class TimeoutError extends Error {
  code = "TIMEOUT";
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string | (() => string)): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(typeof label === "function" ? label() : label)), ms);
  });
  p.catch(() => undefined); // the loser of the race must not surface as an unhandled rejection
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

const isTimeout = (e: unknown): boolean => e instanceof TimeoutError;

const INJECT_TOP_MS = 10_000; // top frame of a tab
const INJECT_CHILD_MS = 3_000; // child frames: best-effort, a wedged ad/embed is skipped and reported
const CDP_CMD_MS = 15_000; // default per debugger command
const ATTACH_MS = 10_000; // debugger attach + DOM/Page enable
const CAPTURE_STEP_MS = 10_000; // one captureVisibleTab grab inside the per-window queue

// JavaScript dialogs currently open, per tab. Only observable while the debugger is attached with
// Page.enable (ensureAttached does that); recorded from Page.javaScriptDialogOpening/Closed.
interface PendingDialog {
  type: string;
  message: string;
  url?: string;
  defaultPrompt?: string;
  at: number;
}
const pendingDialogs = new Map<number, PendingDialog>();

function onDialogEvent(tabId: number, method: string, params: any): void {
  if (method === "Page.javaScriptDialogOpening") {
    pendingDialogs.set(tabId, {
      type: String(params?.type ?? "alert"),
      message: String(params?.message ?? ""),
      url: params?.url,
      defaultPrompt: params?.defaultPrompt,
      at: Date.now(),
    });
  } else if (method === "Page.javaScriptDialogClosed") {
    pendingDialogs.delete(tabId);
  }
}

function dialogHint(tabId: number | undefined): string {
  const d = tabId != null ? pendingDialogs.get(tabId) : undefined;
  if (d) {
    const msg = d.message.length > 120 ? d.message.slice(0, 120) + "…" : d.message;
    return `the page is showing a JavaScript ${d.type} dialog ("${msg}") - call handle_dialog (accept:true/false) to close it`;
  }
  return (
    "the page may be showing a JavaScript dialog (alert/confirm/prompt/beforeunload) - try handle_dialog, and if it reports " +
    "none it must be closed by the user in Chrome (pass onDialog to click/press_key to avoid this) - or the tab may be hung or still loading"
  );
}

/** The actionable message every bounded tab operation throws on timeout. */
function tabTimeoutMsg(tabId: number | undefined, ms: number, what = ""): string {
  const who = tabId != null ? `tab ${tabId}` : "the tab";
  return `${who} did not respond${what ? ` to ${what}` : ""} within ${Math.round(ms / 100) / 10}s - ${dialogHint(tabId)}`;
}

// Server-side timeouts send {type:"cancel", id}. Long-running loops check isCancelled(params) and stop;
// the eventual reply for a cancelled id is dropped rather than sent or queued.
const cancelledCalls = new Map<string, number>(); // id -> cancelledAt
const callIds = new WeakMap<object, string>(); // dispatch params object -> call id

function markCancelled(id: string): void {
  cancelledCalls.set(id, Date.now());
  // Bounded: an id whose reply never comes (dispatch still wedged) must not leak forever.
  while (cancelledCalls.size > 500) {
    const oldest = cancelledCalls.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cancelledCalls.delete(oldest);
  }
}

/** True once the server gave up on the call these params belong to (pass dispatch's `params`). */
function isCancelled(paramsOrId: object | string | null | undefined): boolean {
  if (!paramsOrId) return false;
  const id = typeof paramsOrId === "string" ? paramsOrId : callIds.get(paramsOrId);
  return !!id && cancelledCalls.has(id);
}

// While > now, keepalive/alarm-driven connect() calls stand down (we were replaced - see onclose).
// A token/port change or an explicit reconnect request clears it.
let replacedUntil = 0;

// A socket that is open (or opening) but has NOT finished the mutual challenge-response yet. Kept out
// of `ws` on purpose: everything that sends (shipOrQueue, pumpOutbox, replies) goes through `ws`, so
// nothing - no hello, no capture batch, no reply - can reach an unverified peer.
let pendingWs: WebSocket | null = null;
// How long the server has to complete the handshake, and how long to hold off after a failed one.
const AUTH_TIMEOUT_MS = 10_000;
const AUTH_FAILED_RETRY_MS = 15_000;

async function connect() {
  if (connecting) return;
  if (Date.now() < replacedUntil) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (pendingWs && (pendingWs.readyState === WebSocket.OPEN || pendingWs.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  try {
    await connectNow();
  } finally {
    connecting = false;
  }
}

/** True when something answers the bridge's /health on the port - used to tell "server down" from
 *  "a server is up but refused the WebSocket" (an older server that requires ?token=, i.e. version skew). */
async function healthAnswers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
    const j: any = await r.json();
    return j?.ok === true;
  } catch {
    return false;
  }
}

async function connectNow() {
  const { token, port } = await chrome.storage.local.get({ token: "", port: 8765 });
  if (!token) {
    setStatus("no-token", "Set the server token in the extension options.");
    return;
  }
  setStatus("connecting");
  // No token in the URL: the server must first prove it knows it (see ws-auth.ts).
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  pendingWs = socket;
  const auth = new WsAuthClient(String(token));
  let authed = false;
  let opened = false;
  let authError: string | null = null;
  // Pre-auth frames are processed strictly in order (HMAC is async): a call the server sends right
  // after auth-ok must not be judged while auth-ok is still being verified.
  let preAuth: Promise<void> = Promise.resolve();
  const authTimer = setTimeout(() => {
    if (authed) return;
    authError = "the server did not complete authentication in time";
    socket.close();
  }, AUTH_TIMEOUT_MS);

  const handshakeStep = async (event: MessageEvent) => {
    if (authed || authError || pendingWs !== socket) return;
    try {
      const out = await auth.step(JSON.parse(String(event.data)));
      if (out !== "ok") {
        if (socket.readyState === WebSocket.OPEN) socket.send(out);
        return;
      }
      authed = true;
      clearTimeout(authTimer);
      pendingWs = null;
      ws = socket;
      await onAuthenticated();
    } catch (e) {
      authError = e instanceof Error ? e.message : String(e);
      console.warn(`[bb] closing connection: ${authError}`);
      socket.close();
    }
  };

  socket.onopen = () => {
    opened = true; // wait for the server's challenge; send nothing until it has proven itself
  };

  const onAuthenticated = async () => {
    if (ws !== socket) return; // superseded by a newer connect() before we opened; don't touch globals
    reconnectDelay = 1_000;
    setStatus("connected");
    // Re-announce live watch state on every connect. One mechanism covers both a server restart and
    // a service-worker respawn: the server rebinds its sessions instead of capturing into nothing.
    await ready();
    const gapMs = lastAliveAt ? Date.now() - lastAliveAt : 0;
    socket.send(
      JSON.stringify({
        type: "hello",
        version: VERSION,
        build: BUILD_AT,
        watch: {
          groups: serializeWatch().map((g) => ({
            watchId: g.watchId,
            rootTabId: g.rootTabId,
            tabs: g.tabs.map((t: WatchTab) => t.tabId),
            swRestarted: gapMs > 45_000,
            gapMs,
          })),
        },
        // The sinks the server held open across the drop are re-adopted only for what is still live
        // here; the rest are finalized. After a worker respawn the debugger sessions (and so every
        // persisted net capture) are gone, while session recordings are restored from storage.session.
        recordings: [...sessionRecordings.keys()],
        captures: [...sessions.entries()].filter(([, s]) => s.netOn && s.persist).map(([tabId]) => tabId),
      })
    );
    pumpOutbox(); // whatever was held while the socket was down
    void markAlive();
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL_MS);
  };

  socket.onmessage = (event) => {
    if (!authed) {
      // Handshake frames - and anything that races in right behind auth-ok - go through one ordered
      // chain. Nothing reaches dispatch until the server has proven it holds the token.
      preAuth = preAuth.then(() => (authed ? onCommand(event) : handshakeStep(event)));
      return;
    }
    void onCommand(event);
  };

  const onCommand = async (event: MessageEvent) => {
    if (ws !== socket) return; // never act on frames from a socket that isn't the authenticated live one
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "cancel") {
      if (typeof msg.id === "string") markCancelled(msg.id);
      return;
    }
    if (!msg.id || !msg.method) return;
    let reply: any;
    const params = msg.params ?? {};
    if (params && typeof params === "object") callIds.set(params, msg.id);
    try {
      const result = await dispatch(msg.method, params);
      reply = { id: msg.id, ok: true, result };
    } catch (err) {
      reply = { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Serialize once (this is the hot path). A frame larger than the server's maxPayload closes the
    // socket (1009) and fails EVERY in-flight call, so refuse it with a structured error instead.
    let json = JSON.stringify(reply);
    if (reply.ok && json.length > REPLY_MAX_BYTES) {
      reply = {
        id: msg.id,
        ok: false,
        code: "RESULT_TOO_LARGE",
        bytes: json.length,
        error: `Result too large to return (${json.length} bytes > ${REPLY_MAX_BYTES}). Narrow the query (limit/filter) or fetch a subset.`,
      };
      json = JSON.stringify(reply);
    }
    // The server already gave up on this call (and failed it to the agent) - don't ship a late reply.
    if (cancelledCalls.delete(msg.id)) return;
    replyOrQueue(socket, json);
  };

  socket.onclose = (ev) => {
    clearTimeout(authTimer);
    if (pendingWs === socket) {
      // Closed before mutual authentication completed. Nothing was sent to this peer but our proof.
      pendingWs = null;
      void onPreAuthClose(ev);
      return;
    }
    if (ws !== socket) return; // a superseded/replaced socket closing must not disturb the live one
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    ws = null;
    if (ev?.code === REPLACED_CLOSE_CODE) {
      // Another connection with this token took over (a second browser/profile). Don't fight it.
      console.warn(
        `[bb] server replaced this connection with another one (close ${ev.code}). Is the token configured in ` +
          `two browsers/profiles? Backing off ${RECONNECT_REPLACED_MS / 1000}s instead of reconnecting immediately.`
      );
      setStatus("replaced", "Another browser/profile with the same token took over the connection. Retrying in 60s.");
      replacedUntil = Date.now() + RECONNECT_REPLACED_MS - 1_000; // the keepalive alarm must not undercut it
      reconnectDelay = RECONNECT_REPLACED_MS;
      scheduleReconnect();
      return;
    }
    setStatus("disconnected", "Will retry automatically.");
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose fires next; nothing to do here (and a superseded socket must never touch globals)
  };

  const holdOff = () => {
    // Don't hammer a peer that failed (or failed us) authentication; the keepalive alarm must not
    // undercut the hold. A token/port change or an explicit reconnect clears it.
    replacedUntil = Date.now() + AUTH_FAILED_RETRY_MS - 1_000;
    reconnectDelay = AUTH_FAILED_RETRY_MS;
  };

  const onPreAuthClose = async (ev: CloseEvent) => {
    if (ws || pendingWs) return; // a newer connect() already took over
    if (authError) {
      setStatus(
        "auth-failed",
        `Server failed authentication (${authError}). Whatever answered on 127.0.0.1:${port} could not prove it ` +
          `knows the token, so nothing was sent to it. Check the bridge server is running, is the same version as ` +
          `this extension (v${VERSION}), and that no other program holds the port. Retrying in ${AUTH_FAILED_RETRY_MS / 1000}s.`
      );
      holdOff();
    } else if (ev.code === WS_AUTH_TIMEOUT_CLOSE_CODE) {
      // Not a token problem: our reply didn't reach the server in time. Normal backoff, no hold-off.
      setStatus("handshake-timeout", "The server's authentication handshake timed out. Retrying automatically.");
    } else if (ev.code === WS_AUTH_FAILED_CLOSE_CODE) {
      setStatus(
        "token-rejected",
        `The server rejected this extension's token. Paste the current token from ~/.browser-bridge/token into ` +
          `the options. Retrying in ${AUTH_FAILED_RETRY_MS / 1000}s.`
      );
      holdOff();
    } else if (!opened && (await healthAnswers(Number(port)))) {
      // /health answers but the WebSocket upgrade was refused without a challenge: a pre-v2 server that
      // still requires ?token=. We will not send the token in the clear, so the versions must match.
      setStatus(
        "version-skew",
        `A bridge server is running on port ${port} but refused the connection - it is probably older than this ` +
          `extension (v${VERSION}) and doesn't support the token challenge-response. Update/rebuild the server ` +
          `(cd server && npm run build) and restart it; extension and server versions must match.`
      );
      holdOff();
    } else {
      setStatus("disconnected", "Will retry automatically.");
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// ---------- outbox ----------
// Every streamed batch goes out through here. The point is the ORDER of operations: the old
// flushRecord/flushCapture emptied their queue into a local and only then checked ws.readyState, so
// a socket blip (server restart, laptop sleep) silently ate the batch. Reconnect backs off to 30s,
// so that was up to 30s of capture lost with no trace. Now a closed socket means the batch is held.

const OUTBOX_MAX_ENVELOPES = 1_500;
const OUTBOX_MAX_BYTES = 4 * 1024 * 1024;

let outbox: { json: string; bytes: number }[] = [];
let outboxBytes = 0;
let outboxDropped = 0;

/**
 * Send now if the socket is up, otherwise hold in the outbox. Returns whether it reached the wire.
 *
 * `queue:false` means "send or tell me you didn't" - used for watch events, where the PAGE holds the
 * only copy until it is acked. Queueing those here too would deliver every event twice: once from the
 * outbox on reconnect and once from the page's own retry. There is exactly one buffer of record per
 * stream, and for watch mode it lives in the page.
 */
function shipOrQueue(obj: any, queue = true): boolean {
  let json: string;
  try {
    json = JSON.stringify(obj);
  } catch {
    return false; // unserializable payload - nothing to hold
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(json);
      return true;
    } catch {
      /* fall through and hold it */
    }
  }
  if (!queue) return false;
  outbox.push({ json, bytes: json.length });
  outboxBytes += json.length;
  // Bounded, and drops are COUNTED. An unbounded backlog would OOM the service worker on a long
  // outage, which is a worse failure than a reported gap.
  while (outbox.length > OUTBOX_MAX_ENVELOPES || outboxBytes > OUTBOX_MAX_BYTES) {
    const o = outbox.shift();
    if (!o) break;
    outboxBytes -= o.bytes;
    outboxDropped++;
  }
  return false;
}

function pumpOutbox(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (outbox.length) {
    const o = outbox[0];
    try {
      ws.send(o.json);
    } catch {
      return; // socket went away mid-drain; keep the rest for the next open
    }
    outbox.shift();
    outboxBytes -= o.bytes;
  }
}

// Send a dispatch reply on the socket it arrived on. When that socket is no longer OPEN the reply is
// DROPPED, not queued: the server rejects every call pending on a socket the moment it closes, so
// nobody awaits it - and one huge late reply (screenshot, MHTML) in the outbox would evict every
// queued capture/watch event to fit under the outbox byte cap.
function replyOrQueue(socket: WebSocket, json: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(json);
  } catch {
    /* socket going away - the server already failed this call */
  }
}

// ---------- watch mode ----------
// The content script is registered on <all_urls> and is therefore present everywhere, including on
// tabs opened while the service worker was dead. Scope is enforced by ARMING (the hello handshake
// below), not by injection - which is what makes watch mode survive SW eviction with no rehydration
// race: the page keeps its own buffer and re-asks.

interface WatchTab {
  tabId: number;
  openerTabId?: number;
  addedAt: number;
}
interface WatchGroup {
  watchId: string;
  rootTabId: number;
  /** Only "calls" registers the MAIN-world console wrapper. Passive error capture needs nothing:
   *  it lives in the isolated content script and touches no page global. */
  consoleMode: "off" | "passive" | "calls";
  startedAt: number;
  tabs: Map<number, WatchTab>;
}

const watchGroups = new Map<string, WatchGroup>();
const tabToWatch = new Map<number, string>();
/** Why the debugger last detached from a tab, so a capture that died is legible instead of silent.
 *  "canceled_by_user" means the human dismissed the banner - never auto-reattach over that. */
const lastDetach = new Map<number, { reason: string; at: number }>();
/** Result of the last watch-script injection per tab, surfaced through watch_start / watch_status. */
const lastInject = new Map<number, { isolated: string; main: string; at: number }>();
let swStartedAt = Date.now();
let lastAliveAt = 0;

const WATCH_KEY = "bb.watch.v1";
// A persisted watch older than this is treated as abandoned on the next service-worker start.
const WATCH_MAX_AGE_MS = 12 * 60 * 60_000;
const HEALTH_KEY = "bb.health.v1";

function serializeWatch() {
  return [...watchGroups.values()].map((g) => ({
    watchId: g.watchId,
    rootTabId: g.rootTabId,
    consoleMode: g.consoleMode,
    startedAt: g.startedAt,
    tabs: [...g.tabs.values()],
  }));
}

// storage.LOCAL, not .session: session storage is wiped when the extension is reloaded or toggled,
// which is precisely when the watch group most needs to survive. Verified the hard way - after an
// off/on toggle the group vanished, every page disarmed itself on the hello handshake, and capture
// was dead while the server still reported "live". Local storage survives that and a browser restart;
// hydrate() expires anything stale so a forgotten group can't linger forever.
async function persistWatch(): Promise<void> {
  try {
    await chrome.storage.local.set({ [WATCH_KEY]: serializeWatch() });
  } catch {
    /* best-effort; the page-side buffer is the real durability */
  }
}

// Hydration gate. Module top-level, NOT onStartup: onStartup fires once per browser launch and never
// after an eviction, which is exactly the case that matters.
let hydrateP: Promise<void> | null = null;
const ready = (): Promise<void> => (hydrateP ??= hydrate());

async function hydrate(): Promise<void> {
  try {
    const got = await chrome.storage.local.get({ [WATCH_KEY]: [], [HEALTH_KEY]: { starts: 0, lastAliveAt: 0 } });
    const groups = got[WATCH_KEY] as any[];
    const now = Date.now();
    for (const g of groups ?? []) {
      // A watch nobody stopped shouldn't outlive the browsing session it belonged to.
      if (now - (g.startedAt ?? 0) > WATCH_MAX_AGE_MS) continue;
      const grp: WatchGroup = {
        watchId: g.watchId,
        rootTabId: g.rootTabId,
        consoleMode: g.consoleMode ?? "passive",
        startedAt: g.startedAt,
        tabs: new Map((g.tabs ?? []).map((t: WatchTab) => [t.tabId, t])),
      };
      watchGroups.set(grp.watchId, grp);
      for (const tabId of grp.tabs.keys()) tabToWatch.set(tabId, grp.watchId);
    }
    const health = got[HEALTH_KEY] as any;
    lastAliveAt = health?.lastAliveAt ?? 0;
    const starts = (health?.starts ?? 0) + 1;
    await chrome.storage.local.set({ [HEALTH_KEY]: { starts, lastAliveAt: Date.now() } });
    if (watchGroups.size) {
      console.log(`[bb] watch rehydrated: ${watchGroups.size} group(s), ${tabToWatch.size} tab(s)`);
      // Drop tabs that are gone, and RE-INJECT into the ones still open. Registration only covers
      // future document loads, so without this an already-open page stays dormant until it happens
      // to navigate - which after an extension reload means indefinitely.
      for (const g of [...watchGroups.values()]) {
        for (const tabId of [...g.tabs.keys()]) {
          try {
            await chrome.tabs.get(tabId);
          } catch {
            g.tabs.delete(tabId);
            tabToWatch.delete(tabId);
            continue;
          }
          void injectWatchNow(tabId, g.consoleMode).catch(() => undefined);
        }
        if (!g.tabs.size) {
          watchGroups.delete(g.watchId);
        }
      }
      await registerWatchScripts([...watchGroups.values()].some((g) => g.consoleMode !== "off"));
      void persistWatch();
    }
    // Identities and active session recordings survive an SW eviction the same way the watch group
    // does; the debugger reconcile cleans up any attach the evicted worker left dangling. Kept in
    // storage.SESSION (cleared on browser close) - these are credential snapshots and live-page state.
    await restoreIdentities();
    await restoreRecordings();
    await reconcileDebuggerTargets();
  } catch {
    /* first run / storage unavailable */
  }
}
void ready();

async function markAlive(): Promise<void> {
  lastAliveAt = Date.now();
  try {
    const got = await chrome.storage.local.get({ [HEALTH_KEY]: { starts: 1 } });
    await chrome.storage.local.set({ [HEALTH_KEY]: { ...(got[HEALTH_KEY] as any), lastAliveAt } });
  } catch {
    /* best-effort */
  }
}

const WATCH_SCRIPT_ID = "bb-watch";
const WATCH_MAIN_SCRIPT_ID = "bb-watch-main";

async function registerWatchScripts(withConsole: boolean): Promise<void> {
  // `withConsole` means "any error capture at all" - the MAIN-world shim is required even for the
  // passive listeners, because an isolated-world listener never sees page errors. Whether it also
  // WRAPS console is decided at runtime via arm(mode), not by registering a different bundle.
  const want: chrome.scripting.RegisteredContentScript[] = [
    {
      id: WATCH_SCRIPT_ID,
      js: ["vendor/bb-watch.js"],
      matches: ["<all_urls>"],
      allFrames: true,
      runAt: "document_start",
      persistAcrossSessions: true,
    },
  ];
  // The MAIN-world shim loader runs at document_start, before any page script, so it captures pristine
  // primitives and pairs with the isolated watcher through a handshake the page never sees (see
  // watch-main-entry.ts). It stays inert until the watcher arms it, so registering it regardless of the
  // console mode is harmless; documents already open when the watch starts get the inline fallback
  // (injectWatchMain), which is best-effort - see docs/WATCH.md.
  void withConsole;
  want.push({
    id: WATCH_MAIN_SCRIPT_ID,
    js: ["vendor/bb-watch-main.js"],
    matches: ["<all_urls>"],
    allFrames: true,
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: true,
  } as chrome.scripting.RegisteredContentScript);
  let existing: chrome.scripting.RegisteredContentScript[] = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts();
  } catch {
    /* none registered yet */
  }
  const have = new Set(existing.map((s) => s.id));
  const add = want.filter((s) => !have.has(s.id));
  if (add.length) await chrome.scripting.registerContentScripts(add);
}

async function unregisterWatchScripts(): Promise<void> {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ids = existing.filter((s) => s.id === WATCH_SCRIPT_ID || s.id === WATCH_MAIN_SCRIPT_ID).map((s) => s.id);
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  } catch {
    /* already gone */
  }
}

/** Registration only covers FUTURE document loads. Sweep the tabs already open so watch mode starts
 *  working on the page the human is looking at, without asking them to reload it. */

/** Inject the MAIN-world shim into specific frames, each with the secret its isolated watcher chose. */
async function injectWatchMain(tabId: number, frames: { frameId: number; nonce: string }[], mode: string): Promise<string> {
  const errs: string[] = [];
  await Promise.all(
    frames.map(({ frameId, nonce }) =>
      chrome.scripting
        .executeScript({
          target: { tabId, frameIds: [frameId] },
          func: bbWatchMainShim,
          args: [mode, nonce],
          world: "MAIN",
          injectImmediately: true,
        } as chrome.scripting.ScriptInjection<any, any>)
        .catch((e) => {
          errs.push(String(e?.message ?? e).slice(0, 200));
        })
    )
  );
  return errs.length ? errs[0] : "ok";
}

async function injectWatchNow(tabId: number, consoleMode: "off" | "passive" | "calls"): Promise<void> {
  // Report what failed rather than swallowing it. A silently-failed injection looks exactly like a
  // quiet user, which is the failure mode this whole feature is built to avoid.
  const isolated = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ["vendor/bb-watch.js"] })
    .then(() => "ok")
    .catch((e) => String(e?.message ?? e).slice(0, 200));
  let main = "skipped";
  if (consoleMode !== "off") {
    // The MAIN-world shim needs each frame's own channel secret, which only its isolated watcher has.
    try {
      const rs = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        // A frame whose document_start shim already paired is armed through the watcher (arm below).
        func: () => {
          const b = (window as any).__bbWatch;
          return b ? { nonce: b.mainNonce ?? null, paired: !!b.mainPaired } : null;
        },
      } as chrome.scripting.ScriptInjection<any, any>);
      const all = ((rs ?? []) as any[]).filter((r: any) => typeof r?.result?.nonce === "string");
      const frames = all.filter((r: any) => !r.result.paired).map((r: any) => ({ frameId: r.frameId as number, nonce: r.result.nonce as string }));
      main = frames.length ? await injectWatchMain(tabId, frames, consoleMode) : all.length ? "ok (document_start shim)" : "no watcher to pair with";
    } catch (e) {
      main = String((e as any)?.message ?? e).slice(0, 200);
    }
  }
  lastInject.set(tabId, { isolated, main, at: Date.now() });
  // Arm EXPLICITLY. The content script is registered on <all_urls> and persists, so on any tab that
  // loaded before this watch existed it already ran its hello handshake, was told "not armed", and
  // went dormant. Re-injecting does not revive it - the idempotence guard makes that a no-op - so
  // without this, watch_start silently captures nothing on every already-open tab.
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: (mode: string) => (window as any).__bbWatch?.arm(true, mode),
      args: [consoleMode],
    } as chrome.scripting.ScriptInjection<any, any>)
    .catch(() => undefined);
}

function watchForTab(tabId: number): WatchGroup | undefined {
  const id = tabToWatch.get(tabId);
  return id ? watchGroups.get(id) : undefined;
}

/** Add a tab to a group and tell the server, so the timeline shows the new tab appearing. */
function addTabToGroup(g: WatchGroup, tabId: number, openerTabId?: number): void {
  if (g.tabs.has(tabId)) return;
  g.tabs.set(tabId, { tabId, openerTabId, addedAt: Date.now() });
  tabToWatch.set(tabId, g.watchId);
  // queue:true - the SW is the ONLY source of this event (unlike page events, which the page holds a
  // copy of), so if the socket is down it must go to the outbox or the followed tab is never
  // registered server-side and its whole timeline/network is lost.
  shipOrQueue({ type: "watch", watchId: g.watchId, tabId, entries: [{ t: Date.now(), k: "opened" }] }, true);
  void persistWatch();
  // The new tab's content script may have run its hello handshake before this membership existed
  // (onCreated and the first document load race), in which case it is sitting dormant. Arm it.
  void injectWatchNow(tabId, g.consoleMode).catch(() => undefined);
}

// ---------- command handlers ----------

const RESTRICTED = /^(chrome|chrome-extension|edge|devtools|about|view-source):/;

async function targetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId !== undefined) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id ${tabId}`);
    return tab;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("No active tab found");
  return active;
}

function assertScriptable(tab: chrome.tabs.Tab) {
  if (!tab.url || RESTRICTED.test(tab.url)) {
    throw new Error(`Cannot script this page (${tab.url ?? "unknown url"}). Browser-internal pages are off-limits.`);
  }
}

// chrome.scripting.executeScript rejects `undefined` in args ("Value is unserializable");
// coalesce to null (which the injected funcs treat the same via `!= null` / falsy checks).
const clean = (args: any[]) => args.map((a) => (a === undefined ? null : a));

// opts.timeoutMs bounds the call (default INJECT_TOP_MS); opts.immediate sets injectImmediately for
// read-only funcs that need not wait for document_idle (the tab may be stuck loading).
interface InjectOpts {
  timeoutMs?: number;
  immediate?: boolean;
  skipTop?: boolean; // injectAllFrames: child frames only
}

async function inject<T>(
  tab: chrome.tabs.Tab,
  func: (...args: any[]) => T,
  args: any[] = [],
  world: "ISOLATED" | "MAIN" = "ISOLATED",
  opts: InjectOpts = {}
): Promise<T> {
  assertScriptable(tab);
  const ms = opts.timeoutMs ?? INJECT_TOP_MS;
  const [result] = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      world,
      func: func as any,
      args: clean(args),
      injectImmediately: !!opts.immediate,
    }),
    ms,
    () => tabTimeoutMsg(tab.id, ms)
  );
  const value = result?.result as any;
  // Injected functions signal failure by RETURNING { error } - never by throwing, because
  // Chrome swallows exceptions thrown inside executeScript and resolves with null instead.
  if (value && typeof value === "object" && typeof value.error === "string") {
    throw new Error(value.error);
  }
  return value as T;
}

// Inject into every frame of the tab; returns the raw per-frame InjectionResults ({ frameId, result }).
// <all_urls> host permission lets executeScript reach cross-origin iframes that page JS can't.
//
// Injected PER FRAME, each raced against its own timeout (the scheme injectFrame uses for the session
// recorder): a single allFrames:true executeScript waits on the slowest frame, so one wedged
// cross-origin ad/embed - or a page showing a JS dialog - hung the whole call. The top frame gets
// INJECT_TOP_MS and its timeout fails the call with an actionable error; a child frame that times out
// is SKIPPED and listed on the returned array's `skippedFrames` property instead.
type FrameResults = chrome.scripting.InjectionResult[] & { skippedFrames?: { frameId: number; url?: string; reason: string }[] };

async function injectAllFrames(
  tab: chrome.tabs.Tab,
  func: (...args: any[]) => any,
  args: any[] = [],
  world: "ISOLATED" | "MAIN" = "ISOLATED",
  opts: InjectOpts = {}
): Promise<FrameResults> {
  assertScriptable(tab);
  const tabId = tab.id!;
  let frames: { frameId: number; url?: string }[] | null = null;
  try {
    frames = (await withTimeout(chrome.webNavigation.getAllFrames({ tabId }), 3_000, "getAllFrames")) ?? null;
  } catch {
    frames = null;
  }
  if (opts.skipTop) {
    if (!frames) return [] as FrameResults; // no frame list: no known child frames
    frames = frames.filter((f) => f.frameId !== 0);
    if (!frames.length) return [] as FrameResults;
  }
  if (!frames || !frames.length) {
    // No frame list - fall back to one allFrames call, still bounded.
    const ms = opts.timeoutMs ?? INJECT_TOP_MS;
    return withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world,
        func: func as any,
        args: clean(args),
        injectImmediately: !!opts.immediate,
      }),
      ms,
      () => tabTimeoutMsg(tabId, ms)
    );
  }
  const cleaned = clean(args);
  const skipped: { frameId: number; url?: string; reason: string }[] = [];
  const settled = await Promise.all(
    frames.map(async (f) => {
      const top = f.frameId === 0;
      const ms = top ? opts.timeoutMs ?? INJECT_TOP_MS : INJECT_CHILD_MS;
      try {
        const res = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId, frameIds: [f.frameId] },
            world,
            func: func as any,
            args: cleaned,
            injectImmediately: !!opts.immediate,
          }),
          ms,
          () => tabTimeoutMsg(tabId, ms, top ? "" : `frame ${f.frameId}`)
        );
        return res?.[0] ?? null;
      } catch (e) {
        if (top) throw e; // the top frame is the page - its failure is the call's failure
        // Not injectable (about:blank, sandboxed, gone mid-call) is silently omitted, as allFrames did;
        // only a frame that HUNG is worth telling the agent about.
        if (isTimeout(e)) skipped.push({ frameId: f.frameId, url: f.url, reason: "timeout" });
        return null;
      }
    })
  );
  const out = settled.filter((r): r is chrome.scripting.InjectionResult => r != null) as FrameResults;
  if (skipped.length) out.skippedFrames = skipped;
  return out;
}

// Run an element-interaction func in every frame; exactly the frame that owns the element acts.
// Frames without the element return { notFound: true }; a real failure returns { error }.
async function injectAllAggregate(tab: chrome.tabs.Tab, func: (...args: any[]) => any, args: any[] = []): Promise<any> {
  // A snapshot ref is only valid in the frame that issued it (see twoPhaseSnapshot).
  const ref = args[1]?.ref;
  if (ref != null) {
    const owner = ownerFrameForRef(tab.id!, ref);
    if (owner === null) throw new Error(`ref ${ref} is not from the latest snapshot (taking any snapshot invalidates earlier refs) - take a fresh snapshot`);
    if (owner !== undefined) {
      const v = await actInFrame(tab, owner, args, func);
      if (v?.staleRef) throw new Error("Ref matched an element that was since removed/re-rendered - take a fresh snapshot");
      if (!v || v.notFound) throw new Error("Element not found - take a fresh snapshot");
      return v;
    }
  }
  const results = await injectAllFrames(tab, func, args);
  let acted: any = null;
  let stale = false;
  for (const r of results) {
    const v: any = r?.result;
    if (!v || typeof v !== "object") continue;
    if (typeof v.error === "string") throw new Error(v.error);
    if (v.staleRef) { stale = true; continue; } // ref hit, but the element was removed/re-rendered
    if (v.notFound) continue;
    acted = v;
  }
  if (acted) return acted;
  throw new Error(stale ? "Ref matched an element that was since removed/re-rendered - take a fresh snapshot" : "Element not found in any frame - take a fresh snapshot");
}

// bbAct across every frame, tracking WHICH frame owns the element so the auto-wait retry can
// re-inject into just that frame instead of walking every frame's DOM again each tick. Unlike
// injectAllAggregate it does NOT throw on not-found/stale - it returns a structured result the retry
// loop interprets (a real {error} still throws). frameId is null when no frame located the element.
//
// Refs route straight to the frame that issued them. Selectors are first LOCATED read-only in every
// frame and ONE match is chosen (visible > top frame > in viewport > document order), then bbAct runs
// only in that frame on that match (p.nth) - so a selector can't also fill a lookalike field inside an
// embedded widget iframe, and a hidden duplicate (mobile nav) doesn't shadow the visible one.
async function actAllFrames(
  tab: chrome.tabs.Tab,
  args: any[]
): Promise<{ result: any; frameId: number | null; nth?: number; matchCount?: number; note?: string; skipped?: number }> {
  const p: BbActParams = args[1] ?? {};
  if (p.ref != null) {
    const owner = ownerFrameForRef(tab.id!, p.ref);
    if (owner === null) return { result: { notFound: true }, frameId: null };
    if (owner !== undefined) {
      let v: any;
      try {
        v = await actInFrame(tab, owner, args);
      } catch (e) {
        if (e instanceof Error && /Frame with ID|No frame|was removed/i.test(e.message)) v = { notFound: true };
        else throw e;
      }
      return { result: v, frameId: v?.notFound || v?.staleRef ? null : owner };
    }
  } else if (p.sel != null && p.nth == null) {
    // Fast path: locate + pick + act in the TOP frame in one injection, while the child frames are
    // located in parallel (for matchCount/note, and as the fallback). A visible top-frame match always
    // wins pickSelectorTarget's ranking, so acting on it before the children answer picks the same
    // element the two-step locate-then-act did - one executeScript round trip fewer.
    const [top, kids] = await Promise.all([
      actInFrame(tab, 0, [args[0], { ...p, pick: true }, ...args.slice(2)]),
      injectAllFrames(tab, bbLocateAll, [p.sel], "ISOLATED", { skipTop: true }),
    ]);
    const pickData = top?._pick as { count: number; matches: { index: number; visible: boolean; inViewport: boolean }[]; index?: number } | undefined;
    if (top && typeof top === "object") delete top._pick;
    const matches: LocateMatch[] = (pickData?.matches ?? []).map((m) => ({ frameId: 0, ...m }));
    for (const r of kids) {
      const v: any = r?.result;
      if (!v || typeof v !== "object") continue;
      if (typeof v.error === "string") throw new Error(v.error);
      for (const m of v.matches ?? []) matches.push({ frameId: r.frameId, index: m.index, visible: m.visible, inViewport: m.inViewport });
    }
    const skipped = kids.skippedFrames?.length ?? 0;
    const pick = pickSelectorTarget(matches);
    if (top && !top.notFound && !top.pickHidden && pickData?.index != null) {
      return { result: top, frameId: 0, nth: pickData.index, matchCount: pick.count, note: pick.note, skipped };
    }
    if (!pick.chosen) return { result: { notFound: true }, frameId: null, skipped };
    const nthArgs = [args[0], { ...p, nth: pick.chosen.index }, ...args.slice(2)];
    const v = await actInFrame(tab, pick.chosen.frameId, nthArgs);
    return { result: v, frameId: v?.notFound ? null : pick.chosen.frameId, nth: pick.chosen.index, matchCount: pick.count, note: pick.note, skipped };
  } else if (p.sel != null) {
    const pick = await locateOne(tab, p.sel);
    if (!pick.chosen) return { result: { notFound: true }, frameId: null, skipped: pick.skipped };
    const nthArgs = [args[0], { ...p, nth: pick.chosen.index }, ...args.slice(2)];
    const v = await actInFrame(tab, pick.chosen.frameId, nthArgs);
    return {
      result: v,
      frameId: v?.notFound ? null : pick.chosen.frameId,
      nth: pick.chosen.index,
      matchCount: pick.count,
      note: pick.note,
      skipped: pick.skipped,
    };
  }
  const results = await injectAllFrames(tab, bbAct, args);
  const skipped = results.skippedFrames?.length ?? 0;
  let acted: any = null;
  let ownerFrame: number | null = null;
  let stale: any = null; // keep bbAct's {staleRef, was, now} detail for the error message
  for (const r of results) {
    const v: any = r?.result;
    if (!v || typeof v !== "object") continue;
    if (typeof v.error === "string") throw new Error(v.error);
    if (v.staleRef) { stale = v; continue; }
    if (v.notFound) continue;
    acted = v;
    ownerFrame = r.frameId; // this frame owns the element (result may be notActionable)
  }
  if (acted) return { result: acted, frameId: ownerFrame, skipped };
  return { result: stale ?? { notFound: true }, frameId: null, skipped };
}

// Read-only locate of a selector in every frame, then pick ONE match (snapshot-plan.ts
// pickSelectorTarget). An invalid selector throws immediately instead of being retried until timeout.
async function locateOne(tab: chrome.tabs.Tab, sel: string) {
  const located = await injectAllFrames(tab, bbLocateAll, [sel]);
  const matches: LocateMatch[] = [];
  for (const r of located.slice().sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0))) {
    const v: any = r?.result;
    if (!v || typeof v !== "object") continue;
    if (typeof v.error === "string") throw new Error(v.error);
    for (const m of v.matches ?? []) matches.push({ frameId: r.frameId, index: m.index, visible: m.visible, inViewport: m.inViewport });
  }
  // Child frames that did not answer within INJECT_CHILD_MS were not searched: callers say so on a miss.
  return { ...pickSelectorTarget(matches), skipped: located.skippedFrames?.length ?? 0 };
}

// A retry once the owning frame is known: run bbAct in just that one frame.
async function actInFrame(tab: chrome.tabs.Tab, frameId: number, args: any[], func: (...a: any[]) => any = bbAct): Promise<any> {
  const ms = INJECT_TOP_MS;
  const res = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [frameId] },
      world: "ISOLATED",
      func: func as any,
      args: clean(args),
    }),
    ms,
    () => tabTimeoutMsg(tab.id, ms, frameId ? `frame ${frameId}` : "")
  );
  const v: any = res?.[0]?.result;
  if (v && typeof v === "object" && typeof v.error === "string") throw new Error(v.error);
  return v ?? { notFound: true };
}

// ---------- injected page functions ----------
// These are serialized and run IN THE PAGE, so each must be fully self-contained:
// no references to module-scope helpers (esbuild would leave dangling names). Shadow-DOM
// support is via a local deep-walk that recurses into open shadowRoots (closed roots are
// inaccessible by design). Failure is signalled by RETURNING { error } / { notFound }.

// Read/write this origin's web storage. Runs in the page (localStorage/sessionStorage are origin-scoped).
function bbStorage(op: string, area: string | null, key: string | null, value: string | null, kinds: string[] | null) {
  try {
    const readArea = (a: string) => {
      const store = a === "session" ? sessionStorage : localStorage;
      const out: Record<string, string | null> = {};
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k != null) out[k] = store.getItem(k);
      }
      return out;
    };
    if (op === "dump") {
      const want = kinds && kinds.length ? kinds : ["local", "session"];
      const res: any = { origin: location.origin };
      if (want.includes("local")) res.local = readArea("local");
      if (want.includes("session")) res.session = readArea("session");
      return res;
    }
    const store = area === "session" ? sessionStorage : localStorage;
    if (op === "set") {
      store.setItem(key as string, value as string);
      return { ok: true, area: area || "local", key };
    }
    if (op === "remove") {
      store.removeItem(key as string);
      return { ok: true, area: area || "local", key };
    }
    if (op === "clear") {
      store.clear();
      return { ok: true, area: area || "local", cleared: true };
    }
    return { error: `unknown storage op: ${op}` };
  } catch (e) {
    return { error: String(e) };
  }
}

function bbPageText(includeHidden: boolean) {
  let text: string;
  if (includeHidden && document.body) {
    // textContent (on a script/style-stripped clone) includes display:none / collapsed content that
    // innerText drops — e.g. un-expanded accordion bodies. Loses block-level line breaks; that's fine,
    // the point is to surface hidden-but-present DOM text.
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script,style,noscript,template").forEach((e) => e.remove());
    text = (clone.textContent ?? "")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
  }
  return { title: document.title, url: location.href, text };
}

// Phase 1 of a plain snapshot (runs per frame). Collects candidate interactive elements in one pass,
// orders them by priority (open dialog / modal / popover first, then in-viewport, then the rest in
// DOM order), and returns up to `limit` entries WITHOUT refs. The elements are parked in
// window.__bbPending (tagged with the snapshot epoch); phase 2 (bbCommitRefs) registers the ones the
// service worker's cross-frame budget kept, under refs it numbered. Two phases so every frame's ref
// range is dense and disjoint whatever its size, and child frames get a fair share of the budget.
function bbSnapshot(epoch: number, o: { limit: number; viewportOnly: boolean; modalOnly: boolean; filter: string | null }) {
  try {
    const LIMIT = Math.max(1, Math.min(2000, o.limit || 400));
    const SCAN_CAP = 6000; // max candidates considered per frame (bounds work on giant pages)
    const CURSOR_CAP = 3000; // max getComputedStyle(cursor) checks for handler-only clickables
    const STRONG =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable]:not([contenteditable="false"]), ' +
      'audio[controls], video[controls], [role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
      '[role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], ' +
      '[role="switch"], [role="combobox"], [role="textbox"], [role="searchbox"], [role="treeitem"], [role="slider"], ' +
      '[role="spinbutton"], [role="gridcell"], [role="listbox"]';
    const WEAK = '[tabindex]:not([tabindex="-1"]), [onclick]';
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE", "HTML", "BODY", "BR", "HR", "OPTION", "OPTGROUP", "LABEL", "SLOT", "IFRAME", "FRAME"]);
    const SVG_INNER = /^(path|g|use|circle|rect|line|polyline|polygon|ellipse|defs|clippath|mask|lineargradient|radialgradient|stop|symbol|tspan|title|desc)$/i;
    const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    const norm = (s: string | null | undefined, max = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, max);
    const safeMatches = (el: Element, sel: string) => {
      try {
        return el.matches(sel);
      } catch {
        return false;
      }
    };
    const parentOf = (n: Node): Element | null => (n.parentElement as Element | null) || ((n.getRootNode() as ShadowRoot).host ?? null);
    const containsDeep = (a: Element, b: Element) => {
      for (let n: Node | null = b; n; n = (n.parentNode as Node | null) || ((n as ShadowRoot).host ?? null)) if (n === a) return true;
      return false;
    };
    // Rendered + not visibility:hidden (+ opacity unless the caller is checking a toggle input).
    const shown = (el: Element, opacity: boolean) => {
      const cv = (el as any).checkVisibility;
      if (typeof cv === "function") {
        try {
          if (!cv.call(el, { visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: opacity, checkOpacity: opacity })) return false;
        } catch {}
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const rendered = (el: Element) => {
      const cv = (el as any).checkVisibility;
      try {
        return typeof cv === "function" ? cv.call(el, { visibilityProperty: true }) : true;
      } catch {
        return true;
      }
    };

    // ---- open modal / overlays ----
    let modal: Element | null = null;
    let modalNative = false;
    try {
      modal = document.querySelector("dialog:modal");
      modalNative = !!modal;
    } catch {}
    if (!modal) {
      const ams = document.querySelectorAll('[aria-modal="true"]');
      for (let i = ams.length - 1; i >= 0; i--) if (shown(ams[i], false)) { modal = ams[i]; break; }
    }
    const OVERLAY = 'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [popover]';
    const inOverlay = (el: Element) => {
      for (let n: Element | null = el; n; ) {
        const c: Element | null = n.closest(OVERLAY);
        if (c) {
          if (!c.hasAttribute("popover") || safeMatches(c, ":popover-open")) return true;
          n = c.parentElement;
          continue;
        }
        const host: Element | null = (n.getRootNode() as ShadowRoot).host ?? null;
        n = host;
      }
      return false;
    };

    // ---- role / name / state ----
    const INPUT_ROLE: Record<string, string> = {
      button: "button", submit: "button", reset: "button", image: "button", file: "button",
      checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
    };
    const roleOf = (el: Element): string => {
      const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "input") return INPUT_ROLE[((el as HTMLInputElement).type || "text").toLowerCase()] || "textbox";
      if (tag === "select") return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
      if (tag === "textarea" || (el as HTMLElement).isContentEditable) return "textbox";
      if (tag === "audio" || tag === "video") return tag;
      return "";
    };
    const byIds = (el: Element, ids: string) => {
      const root = el.getRootNode() as Document | ShadowRoot;
      let out = "";
      for (const id of ids.split(/\s+/)) {
        if (!id) continue;
        const r = ((root as any).getElementById?.(id) as Element | null) ?? document.getElementById(id);
        if (r) out += " " + ((r as HTMLElement).innerText || r.textContent || "");
      }
      return norm(out);
    };
    const isField = (el: Element) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    const nameOf = (el: Element): string => {
      const al = el.getAttribute("aria-label");
      if (al && al.trim()) return norm(al);
      const lb = el.getAttribute("aria-labelledby");
      if (lb) {
        const t = byIds(el, lb);
        if (t) return t;
      }
      if (isField(el)) {
        const labels = (el as HTMLInputElement).labels;
        if (labels && labels.length) {
          const t = norm((labels[0] as HTMLElement).innerText || labels[0].textContent);
          if (t) return t;
        }
        const t = ((el as HTMLInputElement).type || "").toLowerCase();
        if (el.tagName === "INPUT" && /^(button|submit|reset)$/.test(t)) return norm((el as HTMLInputElement).value);
        return norm(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || "");
      }
      if ((el as HTMLElement).isContentEditable) return norm(el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("title") || "");
      const txt = norm((el as HTMLElement).innerText || "");
      if (txt) return txt;
      const t = el.getAttribute("title");
      if (t && t.trim()) return norm(t);
      try {
        const inner = el.querySelector("img[alt], [aria-label], svg title");
        if (inner) return norm(inner.getAttribute("alt") || inner.getAttribute("aria-label") || inner.textContent || "");
      } catch {}
      return "";
    };
    // [name hint] A discovery hint for NAMELESS elements (icon-only buttons, sidebar items): the first
    // of aria-describedby text, title (self / first descendant), test id (self / nearest descendant),
    // data-key/-value/-action, name attr, a non-generated id, or the icon's name (lucide-*, fa-*, bi-*,
    // data-icon, material ligature). NOT part of the ref fingerprint. Keep in sync with hintOf in ax.ts.
    const AUTO_ID = /^(radix-|react-aria|headlessui-|mui-|rc[-_]|ember\d|:r|«r|_r_|aria-)|[:«»]|\d{3,}|^[0-9a-f-]{16,}$/i;
    const ICON_SKIP = /^(fa-(solid|regular|light|thin|duotone|brands|sharp|fw|lg|xs|sm|xl|\dx|spin|pulse|border|inverse|stack.*|rotate.*|flip.*)|lucide-icon|bi-icon)$/;
    const hintOf = (el: Element, selfOnly = false): string => {
      const clean = (s: string | null | undefined) => (s || "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim().slice(0, 60);
      const attr = (e: Element | null, a: string) => clean(e ? e.getAttribute(a) : "");
      const desc = el.getAttribute("aria-describedby");
      if (desc) {
        const t = clean(byIds(el, desc));
        if (t) return t;
      }
      const sub = (sel: string): Element | null => {
        if (safeMatches(el, sel)) return el;
        if (selfOnly) return null;
        try {
          return el.querySelector(sel);
        } catch {
          return null;
        }
      };
      const tt = attr(sub("[title]"), "title");
      if (tt) return tt;
      for (const a of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
        const v = attr(sub(`[${a}]`), a);
        if (v) return `${a}=${v}`;
      }
      for (const a of ["data-key", "data-value", "data-action", "name"]) {
        const v = attr(el, a);
        if (v) return `${a}=${v}`;
      }
      const id = clean(el.id);
      if (id && !AUTO_ID.test(id)) return `id=${id}`;
      const di = attr(sub("[data-icon]"), "data-icon");
      if (di) return `icon:${di}`;
      let icons: Element[] = [];
      try {
        icons = selfOnly ? [] : Array.from(el.querySelectorAll("svg, i, span[class*='icon'], span[class*='material']")).slice(0, 8);
        if (/^(svg|i)$/i.test(el.tagName)) icons.unshift(el);
      } catch {}
      for (const ic of icons) {
        const cls = (ic.getAttribute("class") || "").split(/\s+/);
        for (const c of cls) {
          const m = /^(?:lucide|fa|bi|tabler|ph|ri|mdi|icon)-([a-z0-9-]+)$/i.exec(c);
          if (m && !ICON_SKIP.test(c)) return `icon:${clean(m[1])}`;
        }
        if (cls.some((c) => /^material-(icons|symbols)/.test(c))) {
          const t = clean(ic.textContent);
          if (t) return `icon:${t}`;
        }
      }
      return "";
    };
    const NO_VALUE = /^(checkbox|radio|file|button|submit|reset|image|password|hidden)$/;
    // target = element the ref points at; ctl = the control whose state is reported (a hidden checkbox
    // behind a label: target is the label, ctl the checkbox).
    const entryFor = (target: Element, ctl: Element, via: string | null) => {
      const tag = target.tagName.toLowerCase();
      const ctag = ctl.tagName.toLowerCase();
      const role = via === "cursor" ? "" : roleOf(ctl);
      const name = via === "label" ? norm((target as HTMLElement).innerText || target.textContent) || nameOf(ctl) : nameOf(target);
      const e: any = { tag };
      if (role && role !== tag) e.role = role;
      if (name) e.name = name;
      else {
        let h = "";
        try {
          // a composite widget (listbox, menu, tablist...) must not borrow its first item's icon/testid
          h = hintOf(target, /^(listbox|menu|menubar|tablist|tree|grid|treegrid|radiogroup|toolbar|combobox)$/.test(role));
        } catch {}
        if (h) e.hint = h;
      }
      if (ctag === "input") e.type = ((ctl as HTMLInputElement).type || "text").toLowerCase();
      if (tag === "a" && (target as HTMLAnchorElement).href) e.href = (target as HTMLAnchorElement).href.slice(0, 120);
      // value
      let v = "";
      if (ctag === "input" && !NO_VALUE.test(e.type)) v = (ctl as HTMLInputElement).value;
      else if (ctag === "textarea") v = (ctl as HTMLTextAreaElement).value;
      else if (ctag === "select") {
        const s = ctl as HTMLSelectElement;
        v = Array.from(s.selectedOptions || []).map((op) => op.text).join(", ");
      } else if ((ctl as HTMLElement).isContentEditable) v = (ctl as HTMLElement).innerText || "";
      else if (role === "slider" || role === "spinbutton") v = ctl.getAttribute("aria-valuenow") || "";
      v = norm(v);
      if (v) e.value = v;
      // states
      const ac = ctl.getAttribute("aria-checked");
      if (ac === "true") e.checked = true;
      else if (ac === "false") e.checked = false;
      else if (ac === "mixed") e.checked = "mixed";
      else if (ctag === "input" && (e.type === "checkbox" || e.type === "radio")) e.checked = (ctl as HTMLInputElement).checked;
      if (ctl.getAttribute("aria-selected") === "true") e.selected = true;
      const ae = ctl.getAttribute("aria-expanded");
      if (ae === "true") e.expanded = true;
      else if (ae === "false") e.expanded = false;
      else if (ctag === "summary" && ctl.parentElement?.tagName === "DETAILS") e.expanded = (ctl.parentElement as HTMLDetailsElement).open;
      if ((ctl as any).disabled || safeMatches(ctl, ":disabled") || ctl.getAttribute("aria-disabled") === "true") e.disabled = true;
      if (via) e.via = via;
      return { e, meta: { tag, role: role || "generic", name } };
    };

    // ---- single pass: collect candidates ----
    type Cand = { el: Element; ctl: Element; via: string | null; hiddenCtl?: boolean; dom: number };
    const cands: Cand[] = [];
    const seen = new Map<Element, Cand>();
    const cursorCache = new Map<Element, boolean>();
    let cursorChecks = 0;
    let scanCapped = false;
    let dom = 0;
    const isPointer = (el: Element): boolean => {
      const c = cursorCache.get(el);
      if (c !== undefined) return c;
      cursorChecks++;
      let p = false;
      try {
        p = getComputedStyle(el).cursor === "pointer";
      } catch {}
      cursorCache.set(el, p);
      return p;
    };
    const add = (el: Element, ctl: Element, via: string | null, hiddenCtl = false) => {
      const prev = seen.get(el);
      if (prev) {
        if (via === "label") {
          prev.ctl = ctl;
          prev.via = "label";
        }
        return;
      }
      const c: Cand = { el, ctl, via, hiddenCtl, dom: dom++ };
      seen.set(el, c);
      cands.push(c);
      if (cands.length >= SCAN_CAP) scanCapped = true;
    };
    const consider = (el: Element) => {
      if (SKIP.has(el.tagName)) return;
      if (safeMatches(el, STRONG)) {
        const tag = el.tagName;
        const type = tag === "INPUT" ? ((el as HTMLInputElement).type || "").toLowerCase() : "";
        if (type === "checkbox" || type === "radio" || type === "file") {
          // Visually-hidden toggle (opacity 0, 1px sr-only, display:none behind a styled label): expose
          // it through its visible label - clicking the label toggles the control.
          const r = el.getBoundingClientRect();
          const visible = shown(el, true) && r.width > 2 && r.height > 2;
          if (visible) return add(el, el, null);
          const labels = Array.from((el as HTMLInputElement).labels || []);
          const lab = labels.find((l) => shown(l, true));
          if (lab) return add(lab, el, "label");
          if (rendered(el) && (r.width > 0 || r.height > 0)) return add(el, el, null, true); // operable, just transparent
          return;
        }
        if (shown(el, true)) add(el, el, null);
        return;
      }
      if (safeMatches(el, WEAK)) {
        const p = parentOf(el);
        if (p && p.closest(STRONG)) return; // inside an already-interactive ancestor
        if (shown(el, true)) add(el, el, null);
        return;
      }
      // handler-only clickable (div/span with cursor:pointer). Emit only the element where the pointer
      // style ORIGINATES (parent isn't pointer), and never inside an interactive ancestor.
      if (cursorChecks >= CURSOR_CAP || SVG_INNER.test(el.tagName)) return;
      if (!isPointer(el)) return;
      const p = parentOf(el);
      if (p && p.tagName !== "BODY" && p.tagName !== "HTML" && isPointer(p)) return;
      if (el.closest(STRONG + ", label") || (p && p.closest(STRONG + ", " + WEAK))) return;
      if (shown(el, true)) add(el, el, "cursor");
    };
    const walk = (root: Document | ShadowRoot) => {
      let els: NodeListOf<Element>;
      try {
        els = root.querySelectorAll("*");
      } catch {
        return;
      }
      for (let i = 0; i < els.length; i++) {
        if (scanCapped) return;
        const el = els[i];
        consider(el);
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    // Open overlays FIRST: a portal modal/popover is usually the last child of <body>, so on a page with
    // more than SCAN_CAP candidates a DOM-order walk would never reach it (and modalOnly would then
    // return nothing). `seen` de-duplicates when the full walk revisits them.
    const walkSubtree = (root: Element) => {
      if (scanCapped) return;
      consider(root);
      const sr = (root as HTMLElement).shadowRoot;
      if (sr) walk(sr);
      let els: NodeListOf<Element>;
      try {
        els = root.querySelectorAll("*");
      } catch {
        return;
      }
      for (let i = 0; i < els.length; i++) {
        if (scanCapped) return;
        consider(els[i]);
        const s2 = (els[i] as HTMLElement).shadowRoot;
        if (s2) walk(s2);
      }
    };
    const overlays: Element[] = [];
    if (modal) overlays.push(modal);
    try {
      document.querySelectorAll(OVERLAY).forEach((o) => {
        if (overlays.includes(o) || overlays.some((x) => x.contains(o))) return;
        if (o.hasAttribute("popover") && !safeMatches(o, ":popover-open")) return;
        if (!shown(o, false)) return;
        overlays.push(o);
      });
    } catch {}
    for (const o of overlays.slice(0, 20)) walkSubtree(o);
    walk(document);

    // ---- modal handling + priority buckets ----
    type Ranked = Cand & { bucket: number; inViewport: boolean; behindModal: boolean };
    const ranked: Ranked[] = [];
    for (const c of cands) {
      let behindModal = false;
      if (c.el.closest("[inert]")) continue; // inert = not operable
      if (modal && !containsDeep(modal, c.el)) {
        if (modalNative || c.el.closest('[aria-hidden="true"]')) continue; // made inert / hidden by the modal
        behindModal = true;
        if (o.modalOnly) continue;
      }
      const r = c.el.getBoundingClientRect();
      const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      if (o.viewportOnly && !inViewport) continue;
      const bucket = behindModal ? 3 : inOverlay(c.el) ? 0 : inViewport ? 1 : 2;
      ranked.push({ ...c, bucket, inViewport, behindModal });
    }
    ranked.sort((a, b) => a.bucket - b.bucket || a.dom - b.dom);

    const filter = (o.filter || "").toLowerCase().trim();
    const elements: any[] = [];
    const pending: { el: Element; meta: any }[] = [];
    let total = 0;
    for (const c of ranked) {
      // Without a filter, entries past the limit are only counted (no name/state work for them).
      if (!filter && elements.length >= LIMIT) {
        total++;
        continue;
      }
      const { e, meta } = entryFor(c.el, c.ctl, c.via);
      if (filter) {
        const hay = `${e.tag} ${e.role || ""} ${e.type || ""} ${e.name || ""} ${e.hint || ""} ${e.value || ""} ${e.href || ""}`.toLowerCase();
        if (!hay.includes(filter)) continue;
      }
      total++;
      if (elements.length >= LIMIT) continue;
      e.inViewport = c.inViewport;
      if (c.behindModal) e.behindModal = true;
      if (c.hiddenCtl) e.visuallyHidden = true;
      elements.push(e);
      pending.push({ el: c.el, meta });
    }
    (window as any).__bbPending = { epoch, items: pending };
    const out: any = { url: location.href, total, elements };
    if (scanCapped) out.scanCapped = true;
    if (modal) out.modal = norm(modal.getAttribute("aria-label") || (modal.getAttribute("aria-labelledby") ? byIds(modal, modal.getAttribute("aria-labelledby")!) : "") || (modal as HTMLElement).innerText, 60) || modal.tagName.toLowerCase();
    return out;
  } catch (e) {
    return { error: `snapshot failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Phase 2 of snapshot / ax_snapshot: register the first `keep` parked elements as refs offset+1..,
// with their {tag, role, name} fingerprints in window.__bbRefMeta (the interaction layer verifies a
// ref still points at the same kind of element). Always reassigns fresh Maps - never merges - so refs
// from an older snapshot can't leak. A newer snapshot's phase 1 that raced in (different epoch) wins.
// INVARIANT: every ref locator must inject in the ISOLATED world (this registry lives there).
function bbCommitRefs(epoch: number, offset: number, keep: number) {
  const w = window as any;
  const p = w.__bbPending;
  if (!p || p.epoch !== epoch) return { error: "superseded by a newer snapshot" };
  const refs = new Map<number, Element>();
  const meta = new Map<number, { tag: string; role: string; name: string }>();
  // [ref fingerprint] The fingerprint is computed from the registered element itself and MUST stay
  // identical to fpOf in dom-act.ts (bbAct re-checks it before acting on a ref; injected code can't
  // share helpers). role is the EXPLICIT role attribute only, and inputs are fingerprinted without
  // their value, so filling a field never makes its own ref stale.
  const fp = (e: Element) => {
    const t = e.tagName;
    const it = t === "INPUT" ? ((e as HTMLInputElement).type || "").toLowerCase() : "";
    let s: string;
    if (t === "INPUT" && (it === "submit" || it === "button" || it === "reset")) s = (e as HTMLInputElement).value || e.getAttribute("aria-label") || "";
    else if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT")
      s = e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.getAttribute("name") || e.id || e.getAttribute("title") || "";
    // Editable regions (ProseMirror/Lexical/Slate) change their own text when filled: never use innerText.
    else if ((e as HTMLElement).isContentEditable)
      s = e.getAttribute("aria-label") || e.getAttribute("aria-placeholder") || e.getAttribute("placeholder") || e.id || e.getAttribute("title") || "";
    else s = e.getAttribute("aria-label") || (e as HTMLElement).innerText || e.textContent || e.getAttribute("title") || "";
    return { tag: t.toLowerCase(), role: e.getAttribute("role") || "", name: s.replace(/\s+/g, " ").trim().slice(0, 80) };
  };
  const n = Math.min(keep, p.items.length);
  for (let i = 0; i < n; i++) {
    const el = p.items[i].el as Element;
    refs.set(offset + i + 1, el);
    try {
      meta.set(offset + i + 1, fp(el));
    } catch {}
  }
  w.__bbRefs = refs;
  w.__bbRefMeta = meta;
  w.__bbEpoch = epoch;
  w.__bbPending = null;
  return { ok: true, n };
}

// Read-only selector locate (per frame) used to pick ONE target before acting. Enumerates matches in
// deep document order (element, then its open shadow root, then onward) - the SAME order bbAct uses
// for `nth`, so the index chosen here addresses the same element there.
function bbLocateAll(sel: string) {
  try {
    document.createDocumentFragment().querySelector(sel);
  } catch (e) {
    return { error: `Invalid CSS selector ${JSON.stringify(sel)}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  const matches: { index: number; visible: boolean; inViewport: boolean }[] = [];
  let count = 0;
  const walk = (root: Document | ShadowRoot) => {
    let els: NodeListOf<Element>;
    try {
      els = root.querySelectorAll("*");
    } catch {
      return;
    }
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      let m = false;
      try {
        m = el.matches(sel);
      } catch {}
      if (m) {
        if (matches.length < 100) {
          const r = el.getBoundingClientRect();
          let vis = r.width > 0 && r.height > 0;
          const cv = (el as any).checkVisibility;
          if (vis && typeof cv === "function") {
            try {
              vis = cv.call(el, { visibilityProperty: true, checkVisibilityCSS: true });
            } catch {}
          }
          matches.push({ index: count, visible: vis, inViewport: vis && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw });
        }
        count++;
      }
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) walk(sr);
    }
  };
  walk(document);
  return { count, matches };
}

// Resolve once the DOM has been quiet (no mutations) for quietMs, or after capMs regardless. Used to
// let a framework finish rendering the result of an action before withSnapshot captures it.
function bbDomQuiet(quietMs: number, capMs: number) {
  return new Promise((resolve) => {
    let quiet: any = null;
    let cap: any = null;
    let obs: MutationObserver | null = null;
    const done = (why: string) => {
      try {
        obs?.disconnect();
      } catch {}
      clearTimeout(quiet);
      clearTimeout(cap);
      resolve({ settled: why });
    };
    try {
      obs = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(() => done("quiet"), quietMs);
      });
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {}
    quiet = setTimeout(() => done("quiet"), quietMs);
    cap = setTimeout(() => done("cap"), capMs);
  });
}

// Scroll the window, a container, or an element into view. Target by ref (__bbRefs) or selector+nth.
// With a target and no delta: scroll it into view. With a target and a delta/direction: scroll the
// target's nearest scrollable ancestor (or itself). No target: the window - or, when the document
// itself can't scroll (Gmail/Slack app shells), the scroll container under the viewport center.
function bbScroll(p: { ref: number | null; sel: string | null; nth: number | null; dx: number | null; dy: number | null; direction: string | null; amount: number | null }) {
  try {
    let target: Element | null = null;
    if (p.ref != null) {
      const reg = (window as any).__bbRefs as Map<number, Element> | undefined;
      const hit = reg && reg.get(p.ref);
      if (!hit) return { error: `ref ${p.ref} is not in the current snapshot - take a fresh snapshot` };
      if (!hit.isConnected) return { error: `ref ${p.ref} points at an element that was removed/re-rendered - take a fresh snapshot` };
      target = hit;
    } else if (p.sel != null) {
      try {
        document.createDocumentFragment().querySelector(p.sel);
      } catch (e) {
        return { error: `Invalid CSS selector ${JSON.stringify(p.sel)}: ${e instanceof Error ? e.message : String(e)}` };
      }
      let k = 0;
      const want = p.nth ?? 0;
      const walk = (root: Document | ShadowRoot): Element | null => {
        const els = root.querySelectorAll("*");
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          if (el.matches(p.sel!) && k++ === want) return el;
          const sr = (el as HTMLElement).shadowRoot;
          if (sr) {
            const f = walk(sr);
            if (f) return f;
          }
        }
        return null;
      };
      target = walk(document);
      if (!target) return { error: `Element not found: ${p.sel}` };
    }
    const se = (document.scrollingElement || document.documentElement) as HTMLElement;
    const isRoot = (el: Element | null) => !el || el === se || el === document.documentElement || el === document.body;
    const describe = (el: Element | null) => {
      if (isRoot(el)) return "window";
      const h = el as HTMLElement;
      const cls = typeof h.className === "string" ? h.className.trim().split(/\s+/)[0] : "";
      return h.tagName.toLowerCase() + (h.id ? "#" + h.id : cls ? "." + cls : "");
    };
    const parentOf = (n: Element): Element | null => n.parentElement || ((n.getRootNode() as ShadowRoot).host ?? null);
    const canScroll = (el: Element, axis: "x" | "y") => {
      const cs = getComputedStyle(el);
      const ov = axis === "y" ? cs.overflowY : cs.overflowX;
      if (!/(auto|scroll|overlay)/.test(ov)) return false;
      return axis === "y" ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
    };
    const scrollerFor = (el: Element, axis: "x" | "y"): Element | null => {
      for (let n: Element | null = el; n && !isRoot(n); n = parentOf(n)) if (canScroll(n, axis)) return n;
      return null; // the window
    };
    const state = (c: Element | null, axis: "x" | "y") => {
      const el = isRoot(c) ? se : (c as Element);
      const pos = axis === "y" ? el.scrollTop : el.scrollLeft;
      const size = axis === "y" ? el.scrollHeight : el.scrollWidth;
      const view = isRoot(c) ? (axis === "y" ? window.innerHeight : window.innerWidth) : axis === "y" ? el.clientHeight : el.clientWidth;
      return { pos: Math.round(pos), size, view, atStart: pos <= 1, atEnd: pos + view >= size - 2 };
    };
    const hasDelta = p.dx != null || p.dy != null || p.direction != null;
    if (target && !hasDelta) {
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" as ScrollBehavior });
      const c = scrollerFor(parentOf(target) ?? target, "y");
      const s = state(c, "y");
      return { scrolled: true, scrolledTo: describe(target), container: describe(c), scrollTop: s.pos, atEnd: s.atEnd };
    }
    const dir = (p.direction || "").toLowerCase();
    const axis: "x" | "y" = dir === "left" || dir === "right" || (p.dx != null && p.dy == null) ? "x" : "y";
    let container: Element | null;
    if (target) container = scrollerFor(target, axis);
    else {
      const docScrollable = axis === "y" ? se.scrollHeight > window.innerHeight + 1 : se.scrollWidth > window.innerWidth + 1;
      container = null;
      if (!docScrollable) {
        const mid = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        container = mid ? scrollerFor(mid, axis) : null;
        if (!container) {
          let best = 0;
          const all = document.querySelectorAll("*");
          for (let i = 0; i < all.length && i < 5000; i++) {
            const el = all[i];
            if (el.clientHeight * el.clientWidth <= best) continue;
            if (canScroll(el, axis)) {
              best = el.clientHeight * el.clientWidth;
              container = el;
            }
          }
        }
      }
    }
    const before = state(container, axis);
    const step = p.amount != null ? p.amount : Math.round(before.view * 0.8);
    const scroller: any = isRoot(container) ? window : container;
    if (dir === "top" || dir === "bottom") {
      const to = dir === "top" ? 0 : before.size;
      scroller.scrollTo(axis === "y" ? { top: to, behavior: "instant" } : { left: to, behavior: "instant" });
    } else {
      let dx = 0, dy = 0;
      if (dir === "down") dy = step;
      else if (dir === "up") dy = -step;
      else if (dir === "right") dx = step;
      else if (dir === "left") dx = -step;
      else {
        dx = p.dx ?? 0;
        dy = p.dy ?? (p.dx != null ? 0 : 600);
      }
      scroller.scrollBy({ left: dx, top: dy, behavior: "instant" });
    }
    const after = state(container, axis);
    const out: any = {
      scrolled: after.pos !== before.pos,
      container: describe(container),
      axis,
      [axis === "y" ? "scrollTop" : "scrollLeft"]: after.pos,
      atStart: after.atStart,
      atEnd: after.atEnd,
    };
    if (isRoot(container)) out.scrollY = Math.round(window.scrollY);
    return out;
  } catch (e) {
    return { error: `scroll failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// One wait_for probe slice in one frame: resolves as soon as the condition holds in THIS frame, or at
// sliceEnd (epoch ms) with satisfied:false. MutationObserver-driven checks (coalesced to one per
// animation frame / 50ms) plus a 150ms poll for changes that don't mutate the DOM (CSS transitions).
// Shadow-aware. Matching: selector and/or role(+name) and/or text, all of which must hold for one element.
function bbWaitProbe(spec: { sel: string | null; text: string | null; role: string | null; name: string | null; state: string }, sliceEnd: number) {
  return new Promise((resolve) => {
    try {
      const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const text = spec.text ? norm(spec.text) : "";
      const nameQ = spec.name ? norm(spec.name) : "";
      const roleQ = (spec.role || "").toLowerCase();
      const INPUT_ROLE: Record<string, string> = {
        button: "button", submit: "button", reset: "button", image: "button",
        checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
      };
      const TAG_ROLE: Record<string, string> = {
        button: "button", summary: "button", select: "combobox", textarea: "textbox", dialog: "dialog", nav: "navigation",
        main: "main", img: "img", ul: "list", ol: "list", li: "listitem", table: "table", form: "form", option: "option",
        h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
      };
      const roleOf = (el: Element) => {
        const ex = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
        if (ex) return ex.toLowerCase();
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return el.hasAttribute("href") ? "link" : "";
        if (tag === "input") {
          const t = ((el as HTMLInputElement).type || "text").toLowerCase();
          return t === "hidden" ? "" : INPUT_ROLE[t] || "textbox";
        }
        if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
        return TAG_ROLE[tag] || "";
      };
      const nameOf = (el: Element) => {
        const al = el.getAttribute("aria-label");
        if (al) return norm(al);
        const lb = el.getAttribute("aria-labelledby");
        if (lb) {
          let s = "";
          for (const id of lb.split(/\s+/)) s += " " + (document.getElementById(id)?.textContent || "");
          if (s.trim()) return norm(s);
        }
        const labels = (el as HTMLInputElement).labels;
        if (labels && labels.length) return norm(labels[0].textContent);
        return norm((el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || (el as HTMLInputElement).value || "");
      };
      const hasText = (el: Element) => norm((el as HTMLElement).innerText ?? el.textContent).includes(text) || norm((el as HTMLInputElement).value).includes(text);
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        const cv = (el as any).checkVisibility;
        try {
          return typeof cv === "function" ? cv.call(el, { visibilityProperty: true, checkVisibilityCSS: true }) : true;
        } catch {
          return true;
        }
      };
      const roots = (): (Document | ShadowRoot)[] => {
        const out: (Document | ShadowRoot)[] = [document];
        for (let i = 0; i < out.length; i++) {
          const els = out[i].querySelectorAll("*");
          for (let j = 0; j < els.length; j++) {
            const sr = (els[j] as HTMLElement).shadowRoot;
            if (sr) out.push(sr);
          }
        }
        return out;
      };
      const find = (): Element[] => {
        const found: Element[] = [];
        const rs = roots();
        if (spec.sel || roleQ) {
          for (const r of rs) {
            const els = spec.sel ? r.querySelectorAll(spec.sel) : r.querySelectorAll("*");
            for (let i = 0; i < els.length && found.length < 200; i++) {
              const el = els[i];
              if (roleQ && roleOf(el) !== roleQ) continue;
              if (nameQ && !nameOf(el).includes(nameQ)) continue;
              if (text && !hasText(el)) continue;
              found.push(el);
            }
          }
          return found;
        }
        // text only: the element owning each matching text node (or, for text split across inline
        // children, the deepest element whose text contains it).
        for (const r of rs) {
          const start = r === document ? document.body : r;
          if (!start) continue;
          const tw = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
          let hits = 0;
          for (let n = tw.nextNode(); n && found.length < 200; n = tw.nextNode()) {
            const pe = n.parentElement;
            if (!pe || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(pe.tagName)) continue;
            if (norm(n.nodeValue).includes(text)) {
              found.push(pe);
              hits++;
            }
          }
          // Rendered text only: textContent includes <script>/<style> source, so a page whose inline JS or
          // JSON data mentions the text would "match" before the text is ever shown.
          const shownText = (node: Node): string => {
            let s = "";
            const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            for (let t = w.nextNode(); t; t = w.nextNode()) {
              const p = t.parentElement;
              if (p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
              s += t.nodeValue + " ";
            }
            return s;
          };
          if (!hits && norm(shownText(start)).includes(text)) {
            let el: Element | null = start instanceof Element ? start : null;
            let kids: Element[] = Array.from((start as ParentNode).children);
            for (;;) {
              const next: Element | undefined = kids.find((k) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(k.tagName) && norm(shownText(k)).includes(text));
              if (!next) break;
              el = next;
              kids = Array.from(next.children);
            }
            if (el) found.push(el);
          }
        }
        return found;
      };
      let finished = false;
      let obs: MutationObserver | null = null;
      let poll: any = null;
      let end: any = null;
      const finish = (v: any) => {
        if (finished) return;
        finished = true;
        try {
          obs?.disconnect();
        } catch {}
        clearInterval(poll);
        clearTimeout(end);
        resolve(v);
      };
      const check = () => {
        if (finished) return;
        let els: Element[];
        try {
          els = find();
        } catch (e) {
          return finish({ error: `wait_for probe failed: ${e instanceof Error ? e.message : String(e)}` });
        }
        const vis = els.filter(visible);
        const st = spec.state;
        const ok = st === "attached" ? els.length > 0 : st === "detached" ? els.length === 0 : st === "hidden" ? vis.length === 0 : vis.length > 0;
        if (!ok) return;
        const out: any = { satisfied: true, count: els.length, visibleCount: vis.length };
        const first = vis[0] ?? els[0];
        if (first && (st === "visible" || st === "attached")) {
          out.tag = first.tagName.toLowerCase();
          const nm = nameOf(first);
          if (nm) out.name = nm.slice(0, 80);
          const reg = (window as any).__bbRefs as Map<number, Element> | undefined;
          if (reg) for (const [ref, el] of reg) if (el === first) { out.ref = ref; break; }
        }
        finish(out);
      };
      let scheduled = false;
      const schedule = () => {
        if (scheduled || finished) return;
        scheduled = true;
        const run = () => {
          if (!scheduled) return;
          scheduled = false;
          check();
        };
        try {
          requestAnimationFrame(run);
        } catch {}
        setTimeout(run, 50); // rAF is throttled in background tabs
      };
      check();
      if (finished) return;
      obs = new MutationObserver(schedule);
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      poll = setInterval(check, 150);
      end = setTimeout(() => finish({ satisfied: false }), Math.max(0, sliceEnd - Date.now()));
    } catch (e) {
      resolve({ error: `wait_for probe failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}

// Validate a CSS selector without touching the page (a syntax error is a clear, immediate error).
function bbValidateSelector(sel: string) {
  try {
    document.createDocumentFragment().querySelector(sel);
    return { ok: true };
  } catch (e) {
    return { error: `Invalid CSS selector ${JSON.stringify(sel)}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Put an image on the REAL OS clipboard as image/png (converting via canvas if needed). Async; the
// executeScript caller awaits it. Requires the document focused + user activation (a trusted click).
async function bbClipboardWriteImage(b64: string, mimeType: string) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let blob: Blob = new Blob([bytes as BlobPart], { type: mimeType || "image/png" });
    if (blob.type !== "image/png") {
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return { error: "no 2d context for conversion" };
      ctx.drawImage(bmp, 0, 0);
      blob = await canvas.convertToBlob({ type: "image/png" });
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return { ok: true, size: bytes.length };
  } catch (e) {
    return { error: String(e) };
  }
}

// Resolve when the tab finishes loading. The primary signal is the onUpdated 'complete' event, but we
// also poll tab.status so navigations that DON'T fire a fresh 'complete' resolve quickly instead of
// blocking the full timeout: a same-document/hash nav, a no-op (same URL), a bfcache restore, or a load
// whose event fired before we attached. A 250ms grace lets a real cross-document nav flip to 'loading'
// first, so we don't resolve on the previous page's lingering 'complete'. The listener still wins for
// normal loads (no added latency); the poll only becomes the resolver in the fast/no-op cases.
//
// Event-driven: listeners are registered BEFORE the navigation is issued (startLoadWait returns a
// handle; call .wait() after triggering the nav) so a fast load can't slip past. webNavigation tells us
// when a top-frame navigation actually started, so the no-op case (hash/same URL/bfcache) resolves on
// the first status check instead of a fixed sleep, and 'domcontentloaded' resolves on the real event.
// A slow status poll stays as a backstop for events that fired before we were listening.
type WaitUntil = "load" | "domcontentloaded" | "none";
interface LoadWaitResult {
  loadTimedOut?: boolean;
  dialog?: PendingDialog; // a JS dialog (e.g. beforeunload) opened while we waited
}

function startLoadWait(
  tabId: number,
  opts: { waitUntil?: WaitUntil; timeoutMs?: number; cancelKey?: object; targetUrl?: string } = {}
): { wait(): Promise<LoadWaitResult>; dispose(): void } {
  const waitUntil: WaitUntil = opts.waitUntil ?? "load";
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let started = false; // a top-frame navigation (or 'loading' status) was observed
  let reached = false; // the waitUntil milestone was observed
  let wake: (() => void) | null = null;
  const poke = () => wake?.();
  const mine = (id: number) => id === tabId;

  const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (!mine(id)) return;
    if (info.status === "loading") started = true;
    if (info.status === "complete" && started) reached = true;
    poke();
  };
  const onBefore = (d: { tabId: number; frameId: number }) => {
    if (mine(d.tabId) && d.frameId === 0) {
      started = true;
      poke();
    }
  };
  const onDcl = (d: { tabId: number; frameId: number }) => {
    if (mine(d.tabId) && d.frameId === 0 && started && waitUntil === "domcontentloaded") {
      reached = true;
      poke();
    }
  };
  // Only a load that belongs to a navigation we saw START counts, so a lingering event from the
  // previous document can't resolve the wait early.
  const onDone = (d: { tabId: number; frameId: number }) => {
    if (mine(d.tabId) && d.frameId === 0 && started) {
      reached = true;
      poke();
    }
  };
  // Same-document navigations never fire 'complete' - they are done the moment they happen. When we know
  // the target URL (navigate), only a same-document nav TO it counts: an SPA on the old page calling
  // pushState/replaceState right after tabs.update must not end the wait before the real load commits.
  let target: string | null = null;
  try {
    target = opts.targetUrl ? new URL(opts.targetUrl).href : null;
  } catch {
    target = null;
  }
  const onSameDoc = (d: { tabId: number; frameId: number; url?: string }) => {
    if (mine(d.tabId) && d.frameId === 0 && (!target || d.url === target)) {
      reached = true;
      poke();
    }
  };
  const listen = waitUntil !== "none";
  if (listen) {
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.webNavigation.onBeforeNavigate.addListener(onBefore);
    chrome.webNavigation.onDOMContentLoaded.addListener(onDcl);
    chrome.webNavigation.onCompleted.addListener(onDone);
    chrome.webNavigation.onErrorOccurred.addListener(onDone);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDoc);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDoc);
  }
  const cleanup = () => {
    if (!listen) return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.webNavigation.onBeforeNavigate.removeListener(onBefore);
    chrome.webNavigation.onDOMContentLoaded.removeListener(onDcl);
    chrome.webNavigation.onCompleted.removeListener(onDone);
    chrome.webNavigation.onErrorOccurred.removeListener(onDone);
    chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onSameDoc);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDoc);
  };

  return {
    dispose: cleanup,
    async wait(): Promise<LoadWaitResult> {
      if (!listen) {
        cleanup();
        return {};
      }
      const t0 = Date.now();
      const deadline = t0 + timeoutMs;
      try {
        for (;;) {
          if (reached) return {};
          const dialog = pendingDialogs.get(tabId);
          if (dialog) return { dialog }; // nothing will load while a dialog holds the page
          if (isCancelled(opts.cancelKey)) return {};
          let status: string | undefined;
          try {
            status = (await chrome.tabs.get(tabId)).status;
          } catch {
            return {}; // tab closed/gone
          }
          if (status === "loading") started = true;
          // 'complete' only counts once a navigation started - or, if none starts within a short
          // grace, the nav was a no-op (same URL / hash / bfcache) and the page is already there.
          if (status === "complete" && (started || Date.now() - t0 > 250)) return {};
          if (Date.now() >= deadline) return { loadTimedOut: true };
          // Sleep until an event pokes us, with a backstop poll for events we missed.
          await new Promise<void>((r) => {
            const timer = setTimeout(done, started ? 500 : 100);
            function done() {
              clearTimeout(timer);
              wake = null;
              r();
            }
            wake = done;
          });
        }
      } finally {
        cleanup();
      }
    },
  };
}

const parseWaitUntil = (v: any): WaitUntil => (v === "none" || v === "domcontentloaded" ? v : "load");

// Same page for navigate's "did the URL change?" check (a reload of the current URL is not a failure).
function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = "";
    y.hash = "";
    return x.href.replace(/\/$/, "") === y.href.replace(/\/$/, "");
  } catch {
    return a === b;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// chrome.tabs.captureVisibleTab is quota-limited (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, ~2/s).
// The old unconditional 350ms pre-capture sleep spaced calls out incidentally; now that capturing an
// already-foregrounded tab is near-instant, a burst would trip the quota and hard-fail. Space them
// explicitly instead, measured from the LAST capture - so an isolated screenshot (the common case)
// still waits nothing, and only a genuine burst pays. CDP screenshots use Page.captureScreenshot,
// which is not subject to this quota, so cdpScreenshot deliberately doesn't throttle.
const MIN_CAPTURE_INTERVAL_MS = 550;
const lastCaptureAt = new Map<number, number>(); // windowId -> last captureVisibleTab timestamp
const captureChain = new Map<number, Promise<unknown>>(); // windowId -> tail of the serialized queue
// tabId|format|quality -> a capture already in flight. Concurrent agents watching the SAME page used
// to queue behind each other and each pay a full activate+paint+capture; since their requests overlap
// in time, one frame is a legitimate answer for all of them. Only ever shared while the capture is
// still running - nothing is cached past completion, so a later call always gets a fresh frame.
const captureInFlight = new Map<string, Promise<{ dataUrl: string; meta: any }>>();

/**
 * Wait until a just-activated tab has actually PAINTED, instead of sleeping a fixed 350ms.
 *
 * A backgrounded tab doesn't run requestAnimationFrame; once it becomes visible it does, so two rAF
 * ticks are a real signal that the compositor produced a frame - typically ~16-33ms rather than 350.
 * Because captures of different tabs in one window must serialize (captureVisibleTab only ever shoots
 * the ACTIVE tab), that fixed sleep was the dominant cost of concurrent screenshotting: it set the
 * floor for every queued capture.
 *
 * Deliberately polls a flag rather than relying on executeScript awaiting a returned promise: if that
 * assumption were wrong the call would resolve instantly and we'd capture an unpainted frame, which is
 * exactly the kind of silent wrongness this whole path just got fixed for. Polling is correct either
 * way, and it can never be slower than the old behaviour - if the flag never arrives (throttled or
 * occluded tab) the remaining budget is still slept.
 */
async function awaitPaint(tab: chrome.tabs.Tab, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  // Each inject is bounded by what is left of the budget: a page frozen by a JS dialog would otherwise
  // hold executeScript - and with it the whole per-window capture queue - forever.
  const left = () => Math.max(50, deadline - Date.now());
  try {
    await inject(
      tab,
      () => {
        const w = window as any;
        w.__bbPaint = 0;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            w.__bbPaint = 1;
          })
        );
      },
      [],
      "ISOLATED",
      { timeoutMs: left(), immediate: true }
    );
    while (Date.now() < deadline) {
      if (await inject(tab, () => !!(window as any).__bbPaint, [], "ISOLATED", { timeoutMs: left(), immediate: true })) return;
      await sleep(8);
    }
  } catch {
    const left = deadline - Date.now(); // not scriptable - fall back to the blind wait
    if (left > 0) await sleep(left);
  }
}

/**
 * Run a captureVisibleTab through a per-window SERIAL queue. A bare timestamp check was not enough:
 * concurrent callers (several agents, or one agent with parallel tool calls) all read the same stale
 * timestamp, all computed the same wait, and then all fired at once - tripping Chrome's
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota. Observed 4 hard failures out of 24 screenshots at 8
 * concurrent clients. Chaining makes concurrent callers queue and spacing is enforced per capture, so
 * they wait instead of failing.
 */
function serializeCapture<T>(windowId: number, fn: () => Promise<T>): Promise<T> {
  const prev = captureChain.get(windowId) ?? Promise.resolve();
  const mine = prev.then(async () => {
    const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - (lastCaptureAt.get(windowId) ?? 0));
    if (wait > 0) await sleep(wait);
    try {
      // Hard cap so the chain ALWAYS advances: one wedged grab (dialog-frozen page, hung compositor)
      // used to block every later screenshot in this window - and captureInFlight handed that stuck
      // promise to every repeat caller. The caller falls back to CDP on this timeout.
      return await withTimeout(fn(), CAPTURE_STEP_MS, `screenshot capture in window ${windowId} did not complete within ${CAPTURE_STEP_MS / 1000}s`);
    } finally {
      lastCaptureAt.set(windowId, Date.now()); // space the NEXT capture from when this one finished
    }
  });
  // Keep the chain alive past a rejection, or one failed capture would poison the window's queue.
  captureChain.set(
    windowId,
    mine.catch(() => undefined)
  );
  return mine;
}

// Back/forward via the page's own history - chrome.tabs.goBack/goForward fail spuriously
// ("Cannot find a next page in history") even when history exists. Polls for the URL change
// so bfcache (instant) restores don't wait on a load-complete event that never fires.
async function navByHistory(tab: chrome.tabs.Tab, direction: "back" | "forward", params: any = {}): Promise<any> {
  const before = (await chrome.tabs.get(tab.id!)).url;
  // Listen before triggering, so a bfcache restore's events can't be missed.
  const load = startLoadWait(tab.id!, { waitUntil: parseWaitUntil(params.waitUntil), timeoutMs: 10_000, cancelKey: params });
  await inject(tab, (dir: string) => {
    if (dir === "back") history.back();
    else history.forward();
  }, [direction]);
  const deadline = Date.now() + 6_000;
  let navigated = false;
  // Check BEFORE sleeping: a bfcache restore is effectively instant, and sleeping first charged it a
  // flat 150ms it never needed.
  while (Date.now() < deadline && !isCancelled(params)) {
    const t = await chrome.tabs.get(tab.id!);
    if (t.url && t.url !== before) {
      navigated = true;
      break;
    }
    if (pendingDialogs.has(tab.id!)) break; // a beforeunload dialog is holding the navigation
    await sleep(100);
  }
  // Settle on the real load signal (instant for bfcache) instead of a fixed 300ms sleep.
  let waited: LoadWaitResult = {};
  if (navigated) waited = await load.wait();
  else load.dispose();
  const fresh = await chrome.tabs.get(tab.id!);
  const dialog = waited.dialog ?? pendingDialogs.get(tab.id!);
  return {
    tabId: fresh.id,
    title: fresh.title,
    url: fresh.url,
    navigated,
    ...(waited.loadTimedOut ? { loadTimedOut: true } : {}),
    ...(dialog ? { dialog, hint: "a JavaScript dialog is open on this tab - call handle_dialog" } : {}),
  };
}

// ---------- chrome.debugger (CDP) session layer ----------
// Per-tab debugger session, auto-attached on first use of a debugger-backed feature and
// auto-detached after idle (removes the "started debugging this browser" banner).

const CDP_VERSION = "1.3";
const NET_MAX_ENTRIES = 500;
const BODY_CAP = 512 * 1024; // chars returned to the agent per body
// Bound eager response-body fetches: on an asset-heavy page every loadingFinished would otherwise
// fire Network.getResponseBody at once, each buffering a whole body in the worker (memory spike).
const bodyFetchSem = new Semaphore(6);
const IDLE_DETACH_MS = 5 * 60_000;

// NetEntry lives in net-capture.ts (with the ring that holds it).

interface ExtraInfo {
  reqHeaders?: Record<string, string>;
  respHeaders?: Record<string, string>;
  setCookie?: string[];
}

interface WsFrame {
  requestId: string;
  url?: string;
  dir: "sent" | "received" | "create" | "close" | "sse";
  opcode?: number;
  payload?: string;
  ts: number;
}

const WS_MAX_FRAMES = 1000;
const LOG_MAX = 2000;

// ---- intercept (CDP Fetch) ----
interface InterceptRule {
  match?: { urlContains?: string; method?: string; resourceType?: string; stage?: "Request" | "Response" };
  action?: "continue" | "fail" | "fulfill" | "modify";
  set?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string; errorReason?: string };
  response?: { status?: number; headers?: Record<string, string>; body?: string; bodyIsBase64?: boolean };
}
interface PausedEntry {
  requestId: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
  resourceType?: string;
  stage: "Request" | "Response";
  responseStatusCode?: number;
  responseHeaders?: any;
  ts: number;
}

// Continue every held request unmodified (falling back to failing it, so the page never hangs) and
// clear the map. Returns how many were held.
async function releasePaused(tabId: number, s: Session): Promise<number> {
  const held = [...s.paused.values()];
  s.paused.clear();
  for (const e of held) {
    try {
      await cmd(tabId, e.stage === "Response" ? "Fetch.continueResponse" : "Fetch.continueRequest", { requestId: e.requestId });
    } catch {
      try {
        await cmd(tabId, "Fetch.failRequest", { requestId: e.requestId, errorReason: "Aborted" });
      } catch {
        /* already gone */
      }
    }
  }
  return held.length;
}

// ---- console/log capture ----
interface LogEntry {
  source: string;
  level: string;
  text: string;
  url?: string;
  line?: number;
  ts: number;
}

interface Session {
  attachedAt: number;
  lastUsedAt: number;
  net: NetRing; // bounded request ring with a requestId index (see net-capture.ts)
  netOn: boolean;
  netFilter?: string; // if set, only buffer requests whose URL contains this
  excludeExtensionTraffic?: boolean; // drop non-http(s) requests (other extensions' own traffic)
  netMax: number; // in-memory ring cap for `net` (overridable via net_capture_start maxEntries)
  persist: boolean; // stream finished entries to the server's on-disk sink
  persistBodies: boolean; // include response bodies in the persisted stream
  flushQueue: any[]; // capture entries awaiting a batched flush to the server
  flushTimer: ReturnType<typeof setTimeout> | null; // pending batch-flush timer
  extra: Map<string, ExtraInfo>; // requestId -> raw ExtraInfo headers (incl. Set-Cookie / sent Cookie)
  wsUrls: Map<string, string>; // ws requestId -> url
  wsFrames: WsFrame[];
  refNodes: Map<number, number>; // deep-snapshot ref -> CDP backendNodeId
  deepGen: number; // bumped on every deep snapshot; folded into ref numbers so stale/foreign refs can't collide
  interceptOn: boolean; // CDP Fetch interception active
  interceptRules: InterceptRule[]; // auto-apply rules for paused requests
  paused: Map<string, PausedEntry>; // requestId -> request/response held for the agent to resolve
  pausedAutoContinued?: number; // requests released by the TTL sweep rather than by the agent
  logOn: boolean; // console/log capture active
  logs: LogEntry[];
}

// Deep-snapshot refs are numbered in a range plain snapshot() refs (capped at 400, numbered from 1)
// can never reach, and each deep-snapshot generation gets its own disjoint sub-range. Together this
// means a ref from the wrong snapshot type, or from a since-replaced deep snapshot, can never
// coincidentally match a live entry in s.refNodes and silently resolve to the wrong element.
const DEEP_REF_BASE = 100_000;
const DEEP_REF_GEN_WIDTH = 10_000;

const sessions = new Map<number, Session>();

// Named identity snapshots (cookies incl. HttpOnly + storage + bearer) for replay/authz_matrix.
const identities = new Map<string, { cookies: any[]; storage: any; bearer?: string }>();

// storage.SESSION, not .local: an identity is a credential snapshot, so it should die with the
// browser session rather than persist to disk indefinitely. It only needs to outlive an SW eviction,
// which storage.session does.
const IDENTITIES_KEY = "bb.identities.v1";
async function persistIdentities(): Promise<void> {
  try {
    await chrome.storage.session.set({ [IDENTITIES_KEY]: [...identities.entries()] });
  } catch {
    /* best-effort */
  }
}
async function restoreIdentities(): Promise<void> {
  try {
    const got = await chrome.storage.session.get({ [IDENTITIES_KEY]: [] });
    for (const [name, v] of (got[IDENTITIES_KEY] as [string, any][]) ?? []) {
      if (!identities.has(name)) identities.set(name, v);
    }
  } catch {
    /* first run / storage unavailable */
  }
}

// Default timeout per CDP method. A command that legitimately runs long gets more; one whose duration
// the CALLER controls (Runtime.evaluate awaiting a user promise, bounded by the tool's own timeoutMs on
// the server) gets none - the server-side timeout + cancel governs it.
function cdpTimeoutFor(method: string, params?: any): number {
  if (method === "Runtime.evaluate" || (method === "Runtime.callFunctionOn" && params?.awaitPromise)) return 0; // user code: the tool's own timeoutMs governs
  if (method === "Page.captureScreenshot") return 25_000; // inside the server's 30s screenshot budget
  if (method === "Page.captureSnapshot" || method === "Page.printToPDF") return 60_000;
  if (method === "Network.getResponseBody" || method === "Fetch.getResponseBody") return 30_000;
  return CDP_CMD_MS;
}

function cmd(tabId: number, method: string, params?: any, timeoutMs = cdpTimeoutFor(method, params)): Promise<any> {
  const p = new Promise<any>((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
  return withTimeout(p, timeoutMs, () => tabTimeoutMsg(tabId, timeoutMs, `debugger command ${method}`));
}

function attach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        const m = err.message ?? "attach failed";
        reject(
          new Error(
            /already attached/i.test(m)
              ? `Cannot attach the debugger: ${m}. Close DevTools on that tab (only one debugger can attach at a time).`
              : m
          )
        );
      } else resolve();
    });
  });
}

// In-flight attaches, keyed by tab. Without this, two concurrent debugger-backed calls on a COLD tab
// both see no session and both call chrome.debugger.attach - the loser hits the "already attached"
// rejection path and fails a call that should have succeeded. Sharing the promise makes the second
// caller await the first attach instead of racing it.
const attaching = new Map<number, Promise<Session>>();

async function ensureAttached(tabId: number): Promise<Session> {
  const existing = sessions.get(tabId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  let p = attaching.get(tabId);
  if (!p) {
    // Bounded: attach or an enable that never answers used to leave this shared entry pending forever,
    // wedging EVERY later debugger-backed call on the tab. On timeout the entry is cleared (below), the
    // half-made attach is detached, and a late success is torn down instead of resurrecting a session.
    let abandoned = false;
    const run = (async () => {
      await attach(tabId);
      if (abandoned) {
        // Only tear down if no newer session was created for this tab meanwhile.
        if (!sessions.has(tabId)) await detachSession(tabId).catch(() => {});
        throw new Error("attach abandoned after timeout");
      }
      // If an enable fails AFTER a successful attach, detach so we don't strand an orphaned debugger
      // (stuck "being debugged" banner + a leaked attach that nothing will ever clean up).
      try {
        await Promise.all([cmd(tabId, "DOM.enable", undefined, ATTACH_MS), cmd(tabId, "Page.enable", undefined, ATTACH_MS)]);
        if (abandoned) throw new Error("attach abandoned after timeout");
      } catch (e) {
        if (!sessions.has(tabId)) await detachSession(tabId).catch(() => {});
        throw e;
      }
      const s: Session = {
        attachedAt: Date.now(),
        lastUsedAt: Date.now(),
        net: new NetRing(NET_MAX_ENTRIES),
        netOn: false,
        netMax: NET_MAX_ENTRIES,
        persist: false,
        persistBodies: false,
        flushQueue: [],
        flushTimer: null,
        extra: new Map(),
        wsUrls: new Map(),
        wsFrames: [],
        refNodes: new Map(),
        deepGen: 0,
        interceptOn: false,
        interceptRules: [],
        paused: new Map(),
        logOn: false,
        logs: [],
      };
      sessions.set(tabId, s);
      return s;
    })();
    p = withTimeout(run, ATTACH_MS + 2_000, () => tabTimeoutMsg(tabId, ATTACH_MS + 2_000, "the debugger attach")).catch(async (e) => {
      if (isTimeout(e)) {
        abandoned = true;
        if (attaching.get(tabId) === p) attaching.delete(tabId);
        await withTimeout(detachSession(tabId), 3_000, "detach").catch(() => {});
      }
      throw e;
    });
    attaching.set(tabId, p);
    // Clear on settle either way: a failed attach must not be cached, or the tab could never retry.
    void p.catch(() => {}).then(() => attaching.delete(tabId));
  }
  const s = await p;
  s.lastUsedAt = Date.now();
  return s;
}

async function detachSession(tabId: number): Promise<void> {
  finalizeCapture(tabId); // flush + close the on-disk sink before the session goes away
  sessions.delete(tabId);
  forgetEmulation(tabId); // CDP drops every override on detach
  keepAlives.delete(tabId); // detaching drops the debugger's focus emulation with it
  pendingDialogs.delete(tabId); // no longer observable once detached - don't report a stale one
  try {
    await new Promise<void>((resolve) => chrome.debugger.detach({ tabId }, () => resolve()));
  } catch {
    /* already gone */
  }
}

// ---------- hidden tabs: detection + keep-alive ----------
// A tab whose window is covered/minimized/on another Space - or that sits behind another tab - has
// document.visibilityState 'hidden': Chrome renders NO frames for it, so requestAnimationFrame never
// fires and timers are throttled. React-Aria and many UI libraries commit state inside rAF, so an
// action "succeeds" but the app updates seconds later or never. Worse, CDP Input.dispatchMouseEvent
// (mouseMoved) waits for a frame that never comes: every trusted click/hover took ~5-6s there.
//
// Measured in the e2e harness (raw Chromium, background tab, rAF within 1s):
//   nothing / debugger attached ........ never        Page.setWebLifecycleState active ... never
//   Page.startScreencast ............... never        Page.captureScreenshot ............ never
//   Emulation.setFocusEmulationEnabled . yes (visibilityState flips to 'visible', ~60fps)
// Focus emulation makes the browser treat the tab as captured, so it renders while enabled. So
// while an action runs on a hidden tab and a debugger session exists (or the caller passed
// keepAlive:true, or the action is trusted anyway), focus emulation is switched on for the action
// plus a short frame settle, then off again. Ref-counted per tab for overlapping actions.
const HIDDEN_TAB_WARNING =
  "tab is hidden (window covered/minimized/on another desktop, or another tab is in front): the page may not update until it is visible; " +
  "call tab_activate or ask the user to bring the window forward (or pass keepAlive:true to keep it rendering during the action via the debugger)";
const KEPT_ALIVE_NOTE =
  "tab is hidden; it was kept rendering for this action (debugger focus emulation) but stops again now - later async updates may not render until it is visible";
const STALLED_WARNING = "the page rendered no frame within 250ms (requestAnimationFrame did not fire): it may be throttled or busy, so updates can lag";

const keepAlives = new Map<number, KeepAliveEntry>();

// Top-frame visibility, bounded short: a page stuck behind a JS dialog can't answer, and that must not
// add more than a moment to the action. null = unknown.
async function tabVisibility(tab: chrome.tabs.Tab, rafCapMs = 0): Promise<{ hidden: boolean; raf: boolean | null } | null> {
  if (!tab.id || !tab.url || RESTRICTED.test(tab.url)) return null;
  try {
    const res = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        world: "ISOLATED",
        injectImmediately: true,
        func: (cap: number) => {
          const hidden = document.visibilityState === "hidden";
          if (hidden || !cap) return { hidden, raf: hidden ? false : null };
          return new Promise((res) => {
            let done = false;
            const fin = (v: boolean) => {
              if (!done) {
                done = true;
                res({ hidden: document.visibilityState === "hidden", raf: v });
              }
            };
            requestAnimationFrame(() => fin(true));
            setTimeout(() => fin(false), cap);
          });
        },
        args: [rafCapMs],
      }),
      rafCapMs + 400,
      "visibility probe"
    );
    const v: any = res?.[0]?.result;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// Wait for n rendered frames in the top frame (bounded) - lets rAF-scheduled commits land.
async function settleFrames(tabId: number, n: number, capMs: number): Promise<boolean> {
  try {
    const res = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "ISOLATED",
        injectImmediately: true,
        func: (n: number, cap: number) =>
          new Promise<boolean>((res) => {
            let left = n;
            const t = setTimeout(() => res(false), cap);
            const f = () => {
              if (--left <= 0) {
                clearTimeout(t);
                res(true);
              } else requestAnimationFrame(f);
            };
            requestAnimationFrame(f);
          }),
        args: [n, capMs],
      }),
      capMs + 300,
      "frame settle"
    );
    return res?.[0]?.result === true;
  } catch {
    return false;
  }
}

type KeepAliveEntry = { refs: number; ready: Promise<boolean> };

// Returns the entry this caller holds a reference on (its token for releaseKeepAlive), or null when
// focus emulation could not be turned on. A caller only ever releases the entry it acquired, so a
// stale entry (debugger detached and re-attached in between) can't switch emulation off mid-way
// through another session's action, and a new session never inherits a dead entry.
async function acquireKeepAlive(tabId: number): Promise<KeepAliveEntry | null> {
  let entry = keepAlives.get(tabId);
  if (entry) entry.refs++;
  else {
    entry = { refs: 1, ready: cmd(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }, 3_000).then(() => true, () => false) };
    keepAlives.set(tabId, entry);
  }
  if (await entry.ready) return entry;
  releaseKeepAlive(tabId, entry);
  return null;
}

function releaseKeepAlive(tabId: number, entry: KeepAliveEntry): void {
  if (--entry.refs > 0 || keepAlives.get(tabId) !== entry) return;
  keepAlives.delete(tabId);
  void entry.ready.then((on) => {
    if (on && sessions.has(tabId) && !keepAlives.has(tabId)) void cmd(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false }, 3_000).catch(() => {});
  });
}

/**
 * Run an action with hidden-tab handling: probe visibility first; on a hidden tab keep it rendering
 * (see above) when allowed, settle a couple of frames after the action so rAF commits land, and
 * report tabHidden + keptAlive/warning on the result. params.keepAlive: true = attach the debugger
 * if needed; false = never; unset = only when a debugger session already exists (or `trusted`).
 */
async function withLiveTab(tab: chrome.tabs.Tab, params: any, trusted: boolean, run: () => Promise<any>): Promise<any> {
  const tabId = tab.id!;
  const mode: boolean | undefined = typeof params?.keepAlive === "boolean" ? params.keepAlive : undefined;
  const vis = await tabVisibility(tab);
  let held: KeepAliveEntry | null = null;
  let keepError: string | undefined;
  let rafProbe: Promise<{ hidden: boolean; raf: boolean | null } | null> | null = null;
  if (vis?.hidden && mode !== false && (mode === true || trusted || sessions.has(tabId)) && !isCancelled(params)) {
    try {
      await ensureAttached(tabId);
      held = await acquireKeepAlive(tabId);
    } catch (e) {
      keepError = e instanceof Error ? e.message : String(e);
    }
  } else if (vis && !vis.hidden) {
    // Visible - but is it actually rendering? Checked alongside the action, so it costs nothing extra.
    rafProbe = tabVisibility(tab, 250);
  }
  const kept = held !== null;
  let result: any;
  try {
    result = await run();
    // Let rAF-scheduled commits (React-Aria & co) land while frames are still being produced.
    if (kept && !isCancelled(params)) await settleFrames(tabId, 2, 300);
  } finally {
    if (held) releaseKeepAlive(tabId, held);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const addWarning = (w: string) => {
    result.warning = result.warning ? `${result.warning}; ${w}` : w;
  };
  if (vis?.hidden) {
    result = { ...result, tabHidden: true };
    if (kept) {
      result.keptAlive = true;
      if (!String(result.note ?? "").includes(KEPT_ALIVE_NOTE)) result.note = result.note ? `${result.note}; ${KEPT_ALIVE_NOTE}` : KEPT_ALIVE_NOTE;
    } else if (!result.keptAlive) {
      // A nested withLiveTab (e.g. a covered click escalated to trusted) may already have kept it alive.
      addWarning(HIDDEN_TAB_WARNING + (keepError ? ` (keepAlive failed: ${keepError})` : ""));
    }
  } else if (rafProbe) {
    const r = await rafProbe;
    if (r?.hidden) {
      result = { ...result, tabHidden: true };
      addWarning(HIDDEN_TAB_WARNING);
    } else if (r && r.raf === false) {
      result = { ...result, renderingStalled: true };
      addWarning(STALLED_WARNING);
    }
  }
  return result;
}

// After an SW eviction the in-memory `sessions` map is empty, but a debugger attach the dead worker
// held can linger. Detach any target still attached BY US with no live session, or the next
// debugger-backed tool wedges on "already attached". Detaching a target we didn't attach is a no-op
// (the callback just sets lastError), so this can't steal a DevTools attachment.
async function reconcileDebuggerTargets(): Promise<void> {
  let targets: chrome.debugger.TargetInfo[] = [];
  try {
    targets = await new Promise<chrome.debugger.TargetInfo[]>((resolve) =>
      chrome.debugger.getTargets((t) => resolve(t ?? []))
    );
  } catch {
    return;
  }
  for (const t of targets) {
    if (!t.attached || t.tabId == null || sessions.has(t.tabId)) continue;
    await new Promise<void>((resolve) =>
      chrome.debugger.detach({ tabId: t.tabId! }, () => {
        void chrome.runtime.lastError; // swallow "not attached" for a target that wasn't ours
        resolve();
      })
    );
  }
}

function idleSweep() {
  const now = Date.now();
  for (const [tabId, s] of sessions) {
    // Never idle-detach a tab that's actively doing work - a passive capture/intercept/log
    // session bumps lastUsedAt only on tool calls, so it would otherwise be torn down (banner
    // gone, buffer lost) after 5 min of no calls. One-shot debugger use (trusted click, deep
    // snapshot, screenshot) leaves these flags off, so its banner still auto-cleans.
    // Release paused requests the agent has abandoned FIRST, so a forgotten intercept can't hold the
    // tab (and the banner) open forever via the paused.size check below.
    if (s.paused.size > 0) sweepPaused(tabId, s);
    // Live emulate_* overrides exist only while the debugger is attached: detaching would silently
    // revert the device/network/locale the agent set, so they count as activity until emulate_reset.
    if (s.netOn || s.interceptOn || s.logOn || s.paused.size > 0 || hasEmulation(tabId)) continue;
    if (now - s.lastUsedAt > IDLE_DETACH_MS) void detachSession(tabId);
  }
}

// Bound the per-request side-map so it can't outgrow the ring cap and OOM the service worker on a
// long capture. 2x the ring cap gives headroom for the ExtraInfo-before-requestWillBeSent CDP race.
function capExtra(s: Session): void {
  const max = s.netMax * 2;
  while (s.extra.size > max) {
    const k = s.extra.keys().next().value as string | undefined; // Map is insertion-ordered: oldest first
    if (k === undefined) break;
    s.extra.delete(k);
  }
}

// Buffer Network.* CDP events into the per-tab session (listener registered synchronously below).
function onDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params: any) {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === "Page.javaScriptDialogOpening" || method === "Page.javaScriptDialogClosed") onDialogEvent(tabId, method, params);
  const s = sessions.get(tabId);
  if (!s) return;
  // Fetch interception + console/log capture run independently of Network capture (netOn).
  if (method === "Fetch.requestPaused") return void onFetchPaused(s, tabId, params);
  if (s.logOn && (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown" || method === "Log.entryAdded"))
    return onLogEvent(s, method, params);
  if (!s.netOn) return;
  const find = (id: string) => s.net.get(id); // latest hop for the id (redirect-aware, O(1))
  if (method === "Network.requestWillBeSent") {
    const url = params.request?.url ?? "";
    if (s.netFilter && !url.includes(s.netFilter)) return;
    // Other installed extensions inject scripts, fonts and fetches into every page the user visits.
    // Measured on one ordinary page load: 69 captured requests, 3 of them the user's - the rest were
    // Acrobat/Pocket/etc bundles and base64 font blobs. With persistBodies on, that noise dominates
    // the capture file. Excluded at the source so it never reaches the ring, the JSONL, or a HAR.
    if (s.excludeExtensionTraffic && !/^https?:/i.test(url)) return;
    // A redirect hop re-fires requestWillBeSent with the SAME requestId and a redirectResponse for
    // the hop that just finished. Finalize that prior hop (its status/headers/Location) and keep it
    // as its own entry; the new entry below becomes the latest hop the requestId resolves to.
    if (params.redirectResponse) applyRedirectResponse(s.net.get(params.requestId), params.redirectResponse, url);
    // push() evicts the oldest entry when at cap and returns the requestId that thereby left the ring
    // entirely (a still-live redirect hop keeps it), so we drop its side data in lockstep - else
    // s.extra grows past the ring cap and eventually OOM-kills the MV3 service worker.
    const gone = s.net.push({
      requestId: params.requestId,
      method: params.request?.method,
      url: params.request?.url,
      type: params.type,
      requestHeaders: params.request?.headers,
      requestBody: params.request?.postData ? String(params.request.postData).slice(0, BODY_CAP) : undefined,
      ts: Date.now(),
    });
    if (gone) s.extra.delete(gone);
  } else if (method === "Network.responseReceived") {
    const e = find(params.requestId);
    if (e) {
      e.status = params.response?.status;
      e.mimeType = params.response?.mimeType;
      e.responseHeaders = params.response?.headers;
      e.timing = params.response?.timing;
      if (!e.type && params.type) e.type = params.type;
    }
  } else if (method === "Network.requestWillBeSentExtraInfo") {
    // raw request headers incl. the Cookie actually sent
    const x = s.extra.get(params.requestId) ?? {};
    x.reqHeaders = params.headers;
    s.extra.set(params.requestId, x);
    capExtra(s);
  } else if (method === "Network.responseReceivedExtraInfo") {
    // raw response headers incl. Set-Cookie (dropped from Network.responseReceived.headers)
    const x = s.extra.get(params.requestId) ?? {};
    x.respHeaders = params.headers;
    const sc = params.headers?.["set-cookie"] ?? params.headers?.["Set-Cookie"];
    if (sc) x.setCookie = String(sc).split("\n");
    s.extra.set(params.requestId, x);
    capExtra(s);
  } else if (method === "Network.loadingFinished") {
    const e = find(params.requestId);
    if (e) {
      e.finished = true;
      if (s.persist) {
        if (s.persistBodies) {
          // fetch the body eagerly while the session is still live (a deferred fetch fails after
          // the ring evicts the entry or the SW dies); never let a body failure drop the entry.
          void (async () => {
            const row = captureNetRow(s, e);
            try {
              const b = await bodyFetchSem.run(() => getResponseBody(tabId, e.requestId));
              row.responseBody = b.body;
              row.responseBodyBase64 = b.base64;
              if (b.truncated) {
                row.responseBodyTruncated = true;
                row.responseBodyOriginalLength = b.originalLength;
              }
            } catch (err) {
              row.bodyError = err instanceof Error ? err.message : String(err);
            }
            queueCapture(s, tabId, row);
          })();
        } else {
          queueCapture(s, tabId, captureNetRow(s, e));
        }
      }
    }
  } else if (method === "Network.loadingFailed") {
    const e = find(params.requestId);
    if (e) {
      e.failed = params.errorText || "failed";
      if (s.persist) queueCapture(s, tabId, captureNetRow(s, e));
    }
  } else if (method === "Network.webSocketCreated") {
    s.wsUrls.set(params.requestId, params.url);
    pushWs(s, { requestId: params.requestId, url: params.url, dir: "create", ts: Date.now() });
  } else if (method === "Network.webSocketFrameSent") {
    const f = wsFrame(s, params, "sent");
    pushWs(s, f);
    if (s.persist) queueCapture(s, tabId, { kind: "ws", ...f });
  } else if (method === "Network.webSocketFrameReceived") {
    const f = wsFrame(s, params, "received");
    pushWs(s, f);
    if (s.persist) queueCapture(s, tabId, { kind: "ws", ...f });
  } else if (method === "Network.webSocketClosed") {
    pushWs(s, { requestId: params.requestId, url: s.wsUrls.get(params.requestId), dir: "close", ts: Date.now() });
    s.wsUrls.delete(params.requestId); // ws is done; free its url (never lives in the s.net ring)
  } else if (method === "Network.eventSourceMessageReceived") {
    const f: WsFrame = {
      requestId: params.requestId,
      url: s.wsUrls.get(params.requestId),
      dir: "sse",
      payload: String(params.data ?? "").slice(0, BODY_CAP),
      ts: Date.now(),
    };
    pushWs(s, f);
    if (s.persist) queueCapture(s, tabId, { kind: "ws", ...f });
  }
}

function pushWs(s: Session, f: WsFrame) {
  if (s.wsFrames.length >= WS_MAX_FRAMES) s.wsFrames.shift();
  s.wsFrames.push(f);
}

function wsFrame(s: Session, params: any, dir: "sent" | "received"): WsFrame {
  const payload = params.response?.payloadData;
  return {
    requestId: params.requestId,
    url: s.wsUrls.get(params.requestId),
    dir,
    opcode: params.response?.opcode,
    payload: payload != null ? String(payload).slice(0, BODY_CAP) : undefined,
    ts: Date.now(),
  };
}

async function getResponseBody(tabId: number, requestId: string): Promise<ReturnType<typeof capBody>> {
  const r = await cmd(tabId, "Network.getResponseBody", { requestId });
  // capBody reports truncation as {truncated, originalLength} and keeps a base64 body decodable
  // (cut to a multiple of 4) instead of appending a marker that corrupts it.
  return capBody(typeof r?.body === "string" ? r.body : "", !!r?.base64Encoded, BODY_CAP);
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// ---- persist streaming: batch finished capture entries and flush to the server's on-disk sink ----
// Row shape mirrors net_get_requests so the persisted JSONL converts to HAR/curl trivially.
function captureNetRow(s: Session, e: NetEntry): any {
  const x = s.extra.get(e.requestId);
  const row: any = {
    kind: "net",
    requestId: e.requestId,
    // Request-start wall clock. It was omitted even though NetEntry carries it, which is why
    // export_har had to stamp every entry with the export time - and why watch mode could not order
    // requests against page events without it.
    ts: e.ts,
    method: e.method,
    url: e.url,
    type: e.type,
    status: e.status,
    mimeType: e.mimeType,
    failed: e.failed,
    timing: e.timing,
    requestHeaders: x?.reqHeaders ?? e.requestHeaders,
    responseHeaders: x?.respHeaders ?? e.responseHeaders,
  };
  if (x?.setCookie) row.setCookie = x.setCookie;
  if (e.requestBody) row.requestBody = e.requestBody;
  return row;
}
function queueCapture(s: Session, tabId: number, item: any) {
  s.flushQueue.push(item);
  if (s.flushQueue.length >= 50) return void flushCapture(s, tabId); // cap batch size (bound socket pressure)
  if (!s.flushTimer) s.flushTimer = setTimeout(() => flushCapture(s, tabId), 300);
}
function flushCapture(s: Session, tabId: number, done = false) {
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  const entries = s.flushQueue;
  s.flushQueue = [];
  if (entries.length || done) shipOrQueue({ type: "capture", tabId, entries, done });
}
// Flush the remaining queue and tell the server to close the sink; call before a persist session
// is torn down (detach / tab removed). Idempotent: no-op once persist is cleared.
function finalizeCapture(tabId: number) {
  const s = sessions.get(tabId);
  if (!s || !s.persist) return;
  s.persist = false;
  flushCapture(s, tabId, true);
}

// ---- session recording (rrweb) ----
// Banner-free (scripting only, no chrome.debugger), so its per-tab state lives HERE, not on the CDP
// Session (which would force ensureAttached -> the banner). The injected recorder relays event batches
// via chrome.runtime.sendMessage({cmd:"bb-rec"}); we re-batch and stream them over the WS capture
// channel with stream:"session" so they land in a distinct sink (not the net-capture sink).
interface RecState {
  queue: any[];
  timer: ReturnType<typeof setTimeout> | null;
  allFrames: boolean;
  maskInputs: boolean;
  recordCanvas: boolean;
  canvasFps?: number;
  canvasQuality?: number;
  canvasMaxDim?: number;
  canvasBudgetBytes?: number;
}
const sessionRecordings = new Map<number, RecState>();

// Persist the DURABLE config of each active recording (not the transient queue/timer) so a recording
// survives an SW eviction: the injected page recorder keeps posting bb-rec messages, and restoring the
// map is what lets onMessage accept them again after the worker respawns. storage.SESSION because a
// recording is tied to a live page, not something to resurrect after a browser restart.
const RECORDINGS_KEY = "bb.recordings.v1";
async function persistRecordings(): Promise<void> {
  try {
    const rows = [...sessionRecordings.entries()].map(([tabId, r]) => ({
      tabId,
      allFrames: r.allFrames,
      maskInputs: r.maskInputs,
      recordCanvas: r.recordCanvas,
      canvasFps: r.canvasFps ?? null,
      canvasQuality: r.canvasQuality ?? null,
      canvasMaxDim: r.canvasMaxDim ?? null,
      canvasBudgetBytes: r.canvasBudgetBytes ?? null,
    }));
    await chrome.storage.session.set({ [RECORDINGS_KEY]: rows });
  } catch {
    /* best-effort */
  }
}
async function restoreRecordings(): Promise<void> {
  try {
    const got = await chrome.storage.session.get({ [RECORDINGS_KEY]: [] });
    for (const row of (got[RECORDINGS_KEY] as any[]) ?? []) {
      if (row?.tabId == null || sessionRecordings.has(row.tabId)) continue;
      try {
        await chrome.tabs.get(row.tabId); // drop recordings whose tab is gone
      } catch {
        continue;
      }
      // Fresh queue/timer; the page recorder is still running and streams into this on the next batch.
      sessionRecordings.set(row.tabId, {
        queue: [],
        timer: null,
        allFrames: !!row.allFrames,
        maskInputs: !!row.maskInputs,
        recordCanvas: !!row.recordCanvas,
        // Preserve the original capture settings so post-eviction re-injection isn't silently downgraded to defaults.
        canvasFps: row.canvasFps ?? undefined,
        canvasQuality: row.canvasQuality ?? undefined,
        canvasMaxDim: row.canvasMaxDim ?? undefined,
        canvasBudgetBytes: row.canvasBudgetBytes ?? undefined,
      });
    }
  } catch {
    /* first run / storage unavailable */
  }
}

function queueRecord(rec: RecState, tabId: number, events: any[]) {
  for (const e of events) rec.queue.push({ kind: "rrweb", event: e });
  if (rec.queue.length >= 50) return void flushRecord(rec, tabId);
  if (!rec.timer) rec.timer = setTimeout(() => flushRecord(rec, tabId), 300);
}
function flushRecord(rec: RecState, tabId: number, done = false) {
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  const entries = rec.queue;
  rec.queue = [];
  if (entries.length || done) shipOrQueue({ type: "capture", stream: "session", tabId, entries, done });
}
// Inject + start the recorder in ONE frame, bounded by a timeout. A single allFrames:true
// executeScript blocks on a wedged cross-origin child (ad/embed that never settles) and can hang the
// whole record-start call past its 30s timeout, leaving the tab in a broken recording state. Injecting
// per-frame with an individual timeout means one unresponsive frame can't stall the others.
function injectFrame(tabId: number, frameId: number, rec: RecState, timeoutMs: number): Promise<boolean> {
  const run = (async () => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["vendor/rrweb-record.js"] });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (opts: any) => (window as any).__bbRec?.start(opts),
      // executeScript rejects `undefined` in args ("Value is unserializable") - coalesce to null.
      args: [
        {
          allFrames: rec.allFrames,
          maskInputs: rec.maskInputs,
          recordCanvas: rec.recordCanvas,
          canvasFps: rec.canvasFps ?? null,
          canvasQuality: rec.canvasQuality ?? null,
          canvasMaxDim: rec.canvasMaxDim ?? null,
          canvasBudgetBytes: rec.canvasBudgetBytes ?? null,
        },
      ],
    });
    return true;
  })();
  return Promise.race([
    run.catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

// (Re)inject + start the recorder in a tab's frames. Called on start and on navigation-complete.
// Returns whether the TOP frame was injected (the mandatory one: it carries the Meta+FullSnapshot the
// replay is built from). Subframes are best-effort.
async function injectRecorder(tabId: number, rec: RecState): Promise<boolean> {
  // Top frame is mandatory (own origin, always injectable) and gets a generous budget.
  const top = await injectFrame(tabId, 0, rec, 8000);
  if (!rec.allFrames) return top;
  // Cross-origin iframes: inject each independently and in parallel, each with its own short timeout,
  // so a frame that never responds is simply skipped (best-effort) instead of blocking record-start.
  let frames: { frameId: number }[] = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  } catch {
    return top; // no webNavigation result -> top-frame recording only
  }
  await Promise.all(frames.filter((f) => f.frameId !== 0).map((f) => injectFrame(tabId, f.frameId, rec, 4000)));
  return top;
}

// scheme + host only, no path/query/fragment - for compact tab listings where the path may carry
// opaque ids (mail item ids, doc tokens) that shouldn't be echoed unnecessarily.
function safeOrigin(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// Return the URL with its last integer (path segment or id-like query value) incremented, or null.
function neighborUrl(url: string): string | null {
  const m = url.match(/(\d+)(?!.*\d)/);
  if (!m) return null;
  const n = String(Number(m[1]) + 1);
  return url.slice(0, m.index!) + n + url.slice(m.index! + m[1].length);
}

// Resolve a replay's base request (from a captured requestId or an ad-hoc spec) + overrides + identity,
// then pick the page-fetch or CDP-fetch path.
async function doReplay(tab: chrome.tabs.Tab, params: any): Promise<any> {
  const tabId = tab.id!;
  let base: { url?: string; method: string; headers: Record<string, string>; body?: string } = {
    url: params.url,
    method: (params.method || "GET").toUpperCase(),
    headers: params.headers || {},
    body: params.body,
  };
  if (params.requestId) {
    const s = sessions.get(tabId);
    const e = s?.net.get(params.requestId);
    if (!e) throw new Error("requestId not found in this tab's capture buffer");
    base = {
      url: e.url,
      method: (e.method || "GET").toUpperCase(),
      headers: s!.extra.get(e.requestId)?.reqHeaders ?? e.requestHeaders ?? {},
      body: e.requestBody,
    };
    if (base.body == null && ["POST", "PUT", "PATCH", "DELETE"].includes(base.method)) {
      try {
        const pd = await cmd(tabId, "Network.getRequestPostData", { requestId: params.requestId });
        base.body = pd?.postData;
      } catch {
        /* body unavailable */
      }
    }
  }
  const ov = params.overrides || {};
  const url = ov.url || base.url;
  if (!url) throw new Error("Provide a url (or a requestId to replay)");
  const method = (ov.method || base.method).toUpperCase();
  const body = ov.body !== undefined ? ov.body : base.body;

  // Build request headers: every captured header fetch() can set (auth, CSRF, x-*, accept...), then
  // explicit overrides, then identity (replay-headers.ts). Cookies ride on `credentials`.
  // identity: current session (default) · anon (no cookies) · captured bearer
  let credentials: RequestCredentials = "include";
  let note: string | undefined;
  let bearer: string | null = null;
  if (params.identity === "anon") {
    credentials = "omit";
  } else if (params.identity) {
    const id = identities.get(params.identity);
    if (!id) throw new Error(`identity '${params.identity}' not captured - call identity_capture first`);
    if (id.bearer) {
      bearer = id.bearer;
      credentials = "omit";
    } else {
      note = `identity '${params.identity}' has no bearer; used the current tab session (cookie-jar swap not supported via background fetch)`;
    }
  }
  const built = buildReplayHeaders(base.headers, ov.headers, { hasBody: body != null, identity: params.identity ?? null, bearer });
  const headers = built.headers;
  let referrer: string | undefined;
  try {
    if (built.referrer && /^https?:$/.test(new URL(built.referrer).protocol)) referrer = built.referrer;
  } catch {
    /* unparseable Referer: omit */
  }

  // viaAppClient: run through the PAGE'S OWN fetch (main world) so the app's CSRF tokens, auth
  // interceptors, and service worker apply. Practically same-origin (page CSP connect-src / CORS).
  if (params.viaAppClient) {
    const ta = Date.now();
    try {
      const res: any = await inject(
        tab,
        async (u: string, m: string, hh: Record<string, string>, b: string | null, ref: string | null) => {
          try {
            const init: RequestInit = { method: m, headers: hh, body: b ?? undefined, credentials: "include" };
            if (ref) init.referrer = ref;
            const r = await fetch(u, init);
            const oh: Record<string, string> = {};
            r.headers.forEach((v, k) => (oh[k] = v));
            let t = "";
            try {
              t = (await r.text()).slice(0, 512 * 1024);
            } catch {
              /* opaque/binary */
            }
            return { status: r.status, statusText: r.statusText, redirected: r.redirected, headers: oh, body: t };
          } catch (e) {
            return { __fetchError: String(e) };
          }
        },
        [url, method, headers, body ?? null, referrer ?? null],
        "MAIN"
      );
      if (res && res.__fetchError) return { error: res.__fetchError, via: "app-fetch", url, method };
      return { ...res, ms: Date.now() - ta, via: "app-fetch", identity: params.identity ?? null, note };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), via: "app-fetch", url, method };
    }
  }

  // Replay from the extension BACKGROUND context: <all_urls> host permission sends the session
  // cookies, and it is NOT subject to the page's CSP or CORS (unlike an injected fetch).
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method, headers, body: body ?? undefined, credentials, ...(referrer ? { referrer } : {}) });
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => (h[k] = v));
    let text = "";
    try {
      text = (await r.text()).slice(0, BODY_CAP);
    } catch {
      /* opaque / binary */
    }
    return { status: r.status, statusText: r.statusText, redirected: r.redirected, headers: h, body: text, ms: Date.now() - t0, via: "bg-fetch", identity: params.identity ?? null, note };
  } catch (e) {
    return { error: String(e), via: "bg-fetch", url, method };
  }
}

// Fetch a batch of resources (CSS/fonts/images) from the extension background: no CORS wall under
// <all_urls>, sends the session cookies, CSP-immune - so it inlines cross-origin assets a page-level
// recorder can't. Returns base64 + mime for each; enforces a per-asset byte cap.
async function fetchResources(params: any): Promise<any> {
  const urls: string[] = Array.isArray(params.urls) ? params.urls : [];
  const cap: number = params.perAssetMaxBytes ?? 2 * 1024 * 1024;
  const timeoutMs: number = params.timeoutMs ?? 15_000;
  const concurrency = 8;
  const toB64 = (buf: ArrayBuffer) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    return btoa(bin);
  };
  const one = async (url: string) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let r: Response;
      try {
        r = await fetch(url, { credentials: "include", signal: ctrl.signal });
      } finally {
        clearTimeout(t);
      }
      if (!r.ok) return { url, ok: false, status: r.status, error: `HTTP ${r.status}` };
      const clen = Number(r.headers.get("content-length") || 0);
      if (clen && clen > cap) return { url, ok: false, status: r.status, error: "oversized", bytes: clen };
      const buf = await r.arrayBuffer();
      if (buf.byteLength > cap) return { url, ok: false, status: r.status, error: "oversized", bytes: buf.byteLength };
      const mime = (r.headers.get("content-type") || "").split(";")[0].trim();
      return { url, ok: true, status: r.status, mime, base64: toB64(buf), bytes: buf.byteLength };
    } catch (e) {
      return { url, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const out: any[] = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    out.push(...(await Promise.all(urls.slice(i, i + concurrency).map(one))));
  }
  return { resources: out };
}

// ---- intercept helpers (CDP Fetch) ----

// UTF-8-safe base64 (btoa alone mangles multibyte chars); CDP wants base64 for postData/body.
function b64EncodeUtf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64DecodeUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// CDP header params are [{name,value}]; accept either that or a plain object.
function toHeaderArray(h: any): { name: string; value: string }[] | undefined {
  if (!h) return undefined;
  if (Array.isArray(h)) return h.map((x) => ({ name: String(x.name), value: String(x.value) }));
  return Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));
}

function defaultFetchPatterns(stage?: string): any[] {
  if (stage === "Response") return [{ urlPattern: "*", requestStage: "Response" }];
  if (stage === "both") return [{ urlPattern: "*" }, { urlPattern: "*", requestStage: "Response" }];
  return [{ urlPattern: "*" }];
}

function matchRule(r: InterceptRule, e: PausedEntry): boolean {
  const m = r.match || {};
  if (m.urlContains && !(e.url || "").includes(m.urlContains)) return false;
  if (m.method && (e.method || "").toUpperCase() !== m.method.toUpperCase()) return false;
  if (m.resourceType && e.resourceType !== m.resourceType) return false;
  if (m.stage && e.stage !== m.stage) return false;
  return true;
}

// Apply a resolution to one paused request/response. Mutating a request uses continueRequest;
// synthesizing/replacing a response uses fulfillRequest; blocking uses failRequest.
async function resolvePaused(tabId: number, e: PausedEntry, action: string, set: any, response: any): Promise<any> {
  const requestId = e.requestId;
  if (action === "fail") {
    await cmd(tabId, "Fetch.failRequest", { requestId, errorReason: set?.errorReason || "BlockedByClient" });
    return { resolved: "fail", requestId };
  }
  if (action === "fulfill" || response || (action === "modify" && e.stage === "Response")) {
    const resp = response || {};
    const body = resp.body != null ? (resp.bodyIsBase64 ? resp.body : b64EncodeUtf8(String(resp.body))) : undefined;
    await cmd(tabId, "Fetch.fulfillRequest", {
      requestId,
      responseCode: resp.status ?? e.responseStatusCode ?? 200,
      responseHeaders: toHeaderArray(resp.headers),
      body,
    });
    return { resolved: "fulfill", requestId };
  }
  // continue (optionally mutating the request)
  const cont: any = { requestId };
  if (set) {
    if (set.url) cont.url = set.url;
    if (set.method) cont.method = set.method;
    if (set.headers) cont.headers = toHeaderArray(set.headers);
    if (set.postData != null) cont.postData = b64EncodeUtf8(String(set.postData));
  }
  await cmd(tabId, e.stage === "Response" ? "Fetch.continueResponse" : "Fetch.continueRequest", cont);
  return { resolved: "continue", requestId };
}

function onFetchPaused(s: Session, tabId: number, params: any) {
  if (!s.interceptOn) {
    void cmd(tabId, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    return;
  }
  const isResponse = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
  const entry: PausedEntry = {
    requestId: params.requestId,
    url: params.request?.url,
    method: params.request?.method,
    headers: params.request?.headers,
    postData: params.request?.postData,
    resourceType: params.resourceType,
    stage: isResponse ? "Response" : "Request",
    responseStatusCode: params.responseStatusCode,
    responseHeaders: params.responseHeaders,
    ts: Date.now(),
  };
  const rule = s.interceptRules.find((r) => matchRule(r, entry));
  if (rule) {
    void resolvePaused(tabId, entry, rule.action || "continue", rule.set, rule.response).catch(() => {
      void cmd(tabId, entry.stage === "Response" ? "Fetch.continueResponse" : "Fetch.continueRequest", { requestId: entry.requestId }).catch(() => {});
    });
    return;
  }
  s.paused.set(params.requestId, entry);
  sweepPaused(tabId, s);
}

// Bound the paused-request map. It was the one uncapped structure left: an agent that starts an
// intercept and never resolves a request leaves the page's fetch hanging FOREVER (the tab just spins)
// and pins the debugger banner, because idleSweep skips any tab with paused.size > 0. Eviction must
// actually continue the request - silently forgetting it is what hangs the page.
const PAUSED_MAX = 200;
const PAUSED_TTL_MS = 60_000;

function sweepPaused(tabId: number, s: Session): number {
  const now = Date.now();
  let freed = 0;
  for (const [id, e] of [...s.paused]) {
    const expired = now - e.ts > PAUSED_TTL_MS;
    if (!expired && s.paused.size <= PAUSED_MAX) break; // insertion-ordered: the rest are newer
    s.paused.delete(id);
    freed++;
    void cmd(tabId, e.stage === "Response" ? "Fetch.continueResponse" : "Fetch.continueRequest", { requestId: id }).catch(
      () => {}
    );
  }
  if (freed) s.pausedAutoContinued = (s.pausedAutoContinued ?? 0) + freed;
  return freed;
}

// ---- console/log capture ----
function remoteObjToStr(a: any): string {
  if (a == null) return "";
  if (a.type === "string") return a.value ?? "";
  if ("value" in a) {
    try {
      return typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value);
    } catch {
      return String(a.value);
    }
  }
  if (a.unserializableValue) return String(a.unserializableValue);
  return a.description ?? a.className ?? a.type ?? "";
}
function onLogEvent(s: Session, method: string, params: any) {
  let entry: LogEntry;
  if (method === "Runtime.consoleAPICalled") {
    const frame = params.stackTrace?.callFrames?.[0];
    entry = {
      source: "console",
      level: params.type || "log",
      text: (params.args || []).map(remoteObjToStr).join(" "),
      url: frame?.url,
      line: frame?.lineNumber,
      ts: Date.now(),
    };
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    entry = {
      source: "exception",
      level: "error",
      text: d.exception?.description || d.text || "uncaught exception",
      url: d.url,
      line: d.lineNumber,
      ts: Date.now(),
    };
  } else {
    const e = params.entry || {};
    entry = { source: e.source || "log", level: e.level || "info", text: e.text || "", url: e.url, line: e.lineNumber, ts: Date.now() };
  }
  if (s.logs.length >= LOG_MAX) s.logs.shift();
  s.logs.push(entry);
}

// ---- fuzz (intruder: payload iteration over a request template, via background fetch) ----
function mode<T>(arr: T[]): T | undefined {
  const m = new Map<T, number>();
  let best: T | undefined = arr[0];
  let bestN = 0;
  for (const v of arr) {
    const n = (m.get(v) || 0) + 1;
    m.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}
async function doFuzz(_tab: chrome.tabs.Tab, params: any): Promise<any> {
  const fuzzMode: string = params.mode || "sniper";
  const tmpl = params.template;
  if (!tmpl) throw new Error("Provide a template (a URL string with marker(s), or {url,method,headers,body})");
  const method0 = (params.method || "GET").toUpperCase();
  const concurrency = Math.max(1, Math.min(params.concurrency ?? 10, 30));
  const applySubs = (str: any, subs: [string, string][]) => {
    if (typeof str !== "string") return str;
    let out = str;
    for (const [m, v] of subs) out = out.split(m).join(v);
    return out;
  };
  const buildReq = (subs: [string, string][]) => {
    if (typeof tmpl === "string") {
      return { url: applySubs(tmpl, subs), method: method0, headers: params.headers || {}, body: params.body != null ? applySubs(params.body, subs) : undefined };
    }
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(tmpl.headers || params.headers || {})) hdrs[k] = applySubs(String(v), subs);
    return {
      url: applySubs(tmpl.url, subs),
      method: (tmpl.method || method0).toUpperCase(),
      headers: hdrs,
      body: tmpl.body != null ? applySubs(tmpl.body, subs) : params.body != null ? applySubs(params.body, subs) : undefined,
    };
  };
  // Build the job list - each job = a set of marker→value substitutions + a display label.
  const jobs: { subs: [string, string][]; label: string }[] = [];
  if (fuzzMode === "sniper") {
    const marker = params.marker || "§";
    const payloads: any[] = params.payloads || [];
    if (!payloads.length) throw new Error("sniper: provide a non-empty payloads array");
    for (const raw of payloads) {
      const p = typeof raw === "object" && raw !== null ? String(raw.value ?? raw) : String(raw);
      jobs.push({ subs: [[marker, p]], label: p });
    }
  } else if (fuzzMode === "pitchfork" || fuzzMode === "clusterbomb") {
    const markers: string[] = params.markers || ["§1§", "§2§", "§3§", "§4§"];
    const sets: any[][] = params.payloadSets || [];
    if (!sets.length) throw new Error(`${fuzzMode}: provide payloadSets (array of payload arrays)`);
    const mk = markers.slice(0, sets.length);
    if (fuzzMode === "pitchfork") {
      const len = Math.min(...sets.map((s) => s.length));
      for (let i = 0; i < len; i++) {
        const subs = mk.map((m, j) => [m, String(sets[j][i])] as [string, string]);
        jobs.push({ subs, label: subs.map((s) => s[1]).join(" | ") });
      }
    } else {
      let combos: string[][] = [[]];
      for (let j = 0; j < sets.length; j++) {
        const next: string[][] = [];
        for (const c of combos) for (const v of sets[j]) next.push([...c, String(v)]);
        combos = next;
        if (combos.length > 4096) throw new Error("clusterbomb: >4096 combinations - reduce payload sets");
      }
      for (const c of combos) {
        const subs = mk.map((m, j) => [m, c[j]] as [string, string]);
        jobs.push({ subs, label: c.join(" | ") });
      }
    }
  } else if (fuzzMode === "race") {
    const count = Math.max(2, Math.min(params.raceCount ?? 20, 50));
    const marker = params.marker || "§";
    const p = params.payload != null ? String(params.payload) : "";
    for (let i = 0; i < count; i++) jobs.push({ subs: [[marker, p]], label: `race#${i + 1}` });
  } else {
    throw new Error(`Unknown fuzz mode: ${fuzzMode} (sniper|pitchfork|clusterbomb|race)`);
  }

  const runOne = async (job: { subs: [string, string][]; label: string }): Promise<any> => {
    const req = buildReq(job.subs);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers || {})) if (!/^(cookie|host|content-length)$/i.test(k)) headers[k] = String(v);
    const t0 = Date.now();
    try {
      const r = await fetch(req.url, { method: req.method, headers, body: req.body ?? undefined, credentials: params.identity === "anon" ? "omit" : "include" });
      let text = "";
      try {
        text = await r.text();
      } catch {
        /* opaque/binary */
      }
      return { payload: job.label, status: r.status, length: text.length, timeMs: Date.now() - t0, contentType: r.headers.get("content-type") || "", snippet: text.slice(0, 200) };
    } catch (e) {
      return { payload: job.label, error: String(e), timeMs: Date.now() - t0 };
    }
  };
  const results: any[] = [];
  if (fuzzMode === "race") {
    // Prep all, then release together (best-effort single-packet: minimal skew via Promise.all).
    results.push(...(await Promise.all(jobs.map(runOne))));
  } else {
    for (let i = 0; i < jobs.length; i += concurrency) {
      const batch = jobs.slice(i, i + concurrency);
      results.push(...(await Promise.all(batch.map(runOne))));
    }
  }
  // baseline (mode status / median length) → flag anomalies
  const ok = results.filter((x) => x.status !== undefined);
  const statusMode = mode(ok.map((x) => x.status));
  const lengths = ok.map((x) => x.length).sort((a, b) => a - b);
  const medLen = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  for (const x of results) {
    x.anomaly = x.error !== undefined || x.status !== statusMode || (medLen > 0 && Math.abs((x.length ?? 0) - medLen) / medLen > 0.25);
  }
  results.sort((a, b) => (b.anomaly ? 1 : 0) - (a.anomaly ? 1 : 0));
  return { mode: fuzzMode, count: results.length, baseline: { status: statusMode, medianLength: medLen }, anomalies: results.filter((x) => x.anomaly).length, results };
}

// ---- CDP evaluate (page-context JS that is NOT subject to the page CSP's unsafe-eval) ----
// DevTools-level evaluation runs in the page's main-world realm but bypasses `script-src`
// 'unsafe-eval', so it works on strict-CSP pages where injected `(0,eval)(...)` is blocked.
function cdpStringify(val: any): string {
  if (!val || val.type === "undefined") return "undefined";
  if ("value" in val) {
    const v = val.value;
    try {
      return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    } catch {
      return String(v);
    }
  }
  return String(val.description ?? val.type ?? "");
}
async function cdpEvaluate(tabId: number, code: string, awaitPromise = true): Promise<any> {
  await ensureAttached(tabId);
  const r = await cmd(tabId, "Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise, userGesture: true });
  if (r?.exceptionDetails) {
    const ex = r.exceptionDetails;
    throw new Error(ex.exception?.description || ex.text || "CDP evaluation error");
  }
  return { value: cdpStringify(r?.result).slice(0, 50_000), via: "cdp" };
}

// ---- CDP element resolution (for trusted input / closed shadow / file upload) ----

async function cdpResolveBySelector(tabId: number, selector: string): Promise<number> {
  const { root } = await cmd(tabId, "DOM.getDocument", { depth: 0 });
  const { nodeId } = await cmd(tabId, "DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Element not found for selector: ${selector}`);
  return nodeId;
}

async function cdpResolveByRef(tabId: number, ref: number): Promise<number> {
  const s = sessions.get(tabId);
  if (ref < DEEP_REF_BASE) {
    throw new Error(
      `ref ${ref} is from a plain snapshot() call, not snapshot({deep:true}) - trusted actions require a ref from a deep snapshot. Take a fresh snapshot with deep:true and use the ref it returns.`
    );
  }
  const backendNodeId = s?.refNodes.get(ref);
  if (!backendNodeId) throw new Error(`ref ${ref} is not in the current deep snapshot for this tab (it may be from an older, since-replaced snapshot) - take a fresh snapshot with deep:true`);
  const { nodeIds } = await cmd(tabId, "DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] });
  const nodeId = nodeIds?.[0];
  if (!nodeId) throw new Error(`ref ${ref} node is gone - take a fresh snapshot`);
  return nodeId;
}

async function cdpCenter(tabId: number, nodeId: number): Promise<{ x: number; y: number }> {
  try {
    await cmd(tabId, "DOM.scrollIntoViewIfNeeded", { nodeId });
  } catch {
    /* not all nodes support it */
  }
  const { quads } = await cmd(tabId, "DOM.getContentQuads", { nodeId });
  if (!quads || !quads.length) throw new Error("Element has no visible box (offscreen or hidden)");
  const q = quads[0]; // [x1,y1,x2,y2,x3,y3,x4,y4]
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function cdpResolve(tabId: number, ref: number | null, selector: string | null): Promise<number> {
  if (ref != null) return cdpResolveByRef(tabId, ref);
  if (selector) return cdpResolveBySelector(tabId, selector);
  throw new Error("Provide either ref (from a deep snapshot) or selector");
}

const SHOT_MAX_PX = 16384; // Chrome's per-dimension surface limit

// Viewport + visibility metadata for a screenshot: the dpr (to map screenshot device-pixels → CSS
// input coords), the CSS viewport size (the input coordinate bounds), and whether the tab is actually
// visible — a hidden tab has its compositor throttled, so captures look stale (mistaken for dropped input).
async function viewportMeta(tab: chrome.tabs.Tab): Promise<any> {
  try {
    const v: any = await inject(tab, () => ({
      dpr: window.devicePixelRatio || 1,
      cssWidth: window.innerWidth,
      cssHeight: window.innerHeight,
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
    }), [], "ISOLATED", { timeoutMs: 2_000, immediate: true }); // read-only; never hold up a capture
    if (v && v.hidden) {
      v.warning =
        "Tab is hidden/occluded - the compositor may be throttling its frames, so this capture can be stale " +
        "(looks like dropped input). Input still lands; activate the tab (tab_activate) for a live frame.";
    }
    return v ?? {};
  } catch {
    return {};
  }
}

// Full-page / high-DPI / element screenshot via CDP Page.captureScreenshot (shows the debugger banner).
// `scale` is the FINAL output multiplier over CSS pixels (default 1 = CSS-resolution; 2 = retina).
// CDP's clip.scale multiplies on top of the display's device pixel ratio, so we divide the DPR out to
// keep output dimensions predictable (= CSS size × scale) and default file sizes reasonable.
async function cdpScreenshot(tab: chrome.tabs.Tab, params: any): Promise<any> {
  const tabId = tab.id!;
  // Surface capture requires the tab to be visible/active, else it returns empty. Skip the switch
  // (and its settle) when it's already foregrounded - the common case in an agent loop.
  const win = await chrome.windows.get(tab.windowId!).catch(() => null);
  const needsForeground = !tab.active || !win?.focused;
  if (needsForeground) {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId!, { focused: true }).catch(() => {});
  }
  await ensureAttached(tabId);
  if (needsForeground) await sleep(250); // let the newly-foregrounded tab paint before capture

  const format = params.format === "jpeg" ? "jpeg" : "png";
  const scale = typeof params.scale === "number" && params.scale > 0 ? params.scale : 1;
  const quality = typeof params.quality === "number" ? params.quality : 90;

  // True page dimensions + DPR straight from the page (Page.getLayoutMetrics under-reports content size).
  const pd = await inject(
    tab,
    () => ({
      sw: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, window.innerWidth),
      sh: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight),
      iw: window.innerWidth,
      ih: window.innerHeight,
      sx: window.scrollX,
      sy: window.scrollY,
      dpr: window.devicePixelRatio || 1,
      vis: document.visibilityState,
      hidden: document.hidden,
      focus: document.hasFocus(),
    }),
    [],
    "MAIN"
  );
  const clipScale = scale / (pd.dpr || 1); // so output px = cssSize × scale

  let clip: any;
  if (params.selector) {
    const nodeId = await cdpResolveBySelector(tabId, params.selector);
    let model: any;
    try {
      model = (await cmd(tabId, "DOM.getBoxModel", { nodeId })).model;
    } catch {
      /* no box */
    }
    if (!model) throw new Error(`Element has no rendered box (offscreen/hidden): ${params.selector}`);
    const q: number[] = model.border; // [x1,y1,x2,y2,x3,y3,x4,y4]
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    // DOM.getBoxModel quads are relative to the main frame's VIEWPORT, but Page.captureScreenshot's
    // clip (with captureBeyondViewport) is in DOCUMENT coordinates - add the scroll offset, exactly
    // like the viewport branch below (and Puppeteer's ElementHandle.screenshot) does.
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    clip = { x: x + (pd.sx || 0), y: y + (pd.sy || 0), width: Math.max(...xs) - x, height: Math.max(...ys) - y, scale: clipScale };
  } else if (params.fullPage) {
    if (pd.sw * scale > SHOT_MAX_PX || pd.sh * scale > SHOT_MAX_PX) {
      throw new Error(`Page too large for a single capture (${pd.sw}x${pd.sh} @${scale}x, limit ${SHOT_MAX_PX}px). Use a selector, a smaller scale, or capture regions.`);
    }
    clip = { x: 0, y: 0, width: pd.sw, height: pd.sh, scale: clipScale };
  } else {
    clip = { x: pd.sx, y: pd.sy, width: pd.iw, height: pd.ih, scale: clipScale };
  }

  const capture = async (fmt: "png" | "jpeg", q?: number): Promise<string> => {
    const opts: any = { format: fmt, clip, captureBeyondViewport: true, fromSurface: true };
    if (fmt === "jpeg") opts.quality = q ?? 90;
    const res = await cmd(tabId, "Page.captureScreenshot", opts);
    return res?.data || "";
  };

  let data = await capture(format, quality);
  let outFormat = format;
  // Large PNGs can exceed chrome.debugger's result-size limit and come back empty - fall back to JPEG.
  if (!data && format === "png") {
    data = await capture("jpeg", 92);
    outFormat = "jpeg";
  }
  if (!data) throw new Error("Screenshot returned empty - the page may be too large; try a smaller scale, a selector, or format:'jpeg'.");
  return {
    base64: data,
    format: outFormat,
    fellBackToJpeg: outFormat !== format || undefined,
    dpr: pd.dpr,
    cssWidth: pd.iw,
    cssHeight: pd.ih,
    visibilityState: pd.vis,
    hidden: pd.hidden,
    hasFocus: pd.focus,
    ...(pd.hidden ? { warning: "Tab is hidden/occluded - frames may be throttled; this capture can be stale." } : {}),
  };
}

// Trusted image paste (chrome.debugger): put the image on the real OS clipboard and send a TRUSTED
// Cmd/Ctrl+V, so editors that check event.isTrusted (e.g. YesWeHack) accept it. Needs the tab focused.
async function trustedPasteImage(tab: chrome.tabs.Tab, params: any): Promise<any> {
  const tabId = tab.id!;
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId!, { focused: true }).catch(() => {});
  await ensureAttached(tabId);
  await sleep(200);

  // best-effort: grant clipboard permission for the origin (also relying on the trusted click's activation)
  try {
    const origin = new URL(tab.url!).origin;
    await cmd(tabId, "Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  } catch {
    /* not fatal - the trusted click below provides user activation */
  }

  // find the target element's on-screen center (CSP-safe function injection; handles plain refs + shadow)
  // (frame-aware: coordinates are mapped to the top-level viewport)
  const loc = await locateForTrusted(tab, params.ref ?? null, params.selector ?? null).catch((e) => {
    throw new Error(`Target not found for trusted paste (${e instanceof Error ? e.message : e}) - take a fresh snapshot or check the selector.`);
  });
  await sleep(150);

  // trusted click → focuses the field + grants user activation for the clipboard write
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: loc.x, y: loc.y });
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: loc.x, y: loc.y, button: "left", buttons: 1, clickCount: 1 });
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: loc.x, y: loc.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(120);

  // write the image to the real clipboard (as PNG)
  const w = await inject(tab, bbClipboardWriteImage, [params.base64, params.mimeType ?? "image/png"], "MAIN");
  if (!w || w.error) {
    throw new Error(
      `Clipboard write failed: ${w?.error ?? "unknown"}. The browser window must be focused/frontmost - bring Chrome to the foreground and retry.`
    );
  }
  await sleep(120);

  // trusted Cmd/Ctrl+V → the "paste" editing command reads the real clipboard and dispatches a genuine
  // (isTrusted) paste to the focused field. `commands:["paste"]` invokes it directly (a modifier+V key
  // event alone does NOT reliably trigger paste via CDP).
  const isMac = /Mac/i.test(navigator.userAgent);
  const modifiers = isMac ? 4 : 2; // CDP bitmask: Meta=4, Ctrl=2
  const key = { key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers };
  await cmd(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, commands: ["Paste"] });
  await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
  return { pasted: true, trusted: true, method: "clipboard+trusted-paste", size: w.size };
}

// Offset of an extension frame's viewport inside the top-level viewport, via CDP: map the frame to
// its CDP frame id (by URL in Page.getFrameTree), then take the content box of its owner <iframe>
// (DOM.getBoxModel is relative to the main frame's viewport). Used when a same-origin
// window.frameElement walk can't reach the top (cross-origin ancestors).
async function cdpFrameOffset(tabId: number, frameId: number): Promise<{ x: number; y: number }> {
  const f = await chrome.webNavigation.getFrame({ tabId, frameId });
  if (!f?.url) throw new Error(`frame ${frameId} is gone`);
  const { frameTree } = await cmd(tabId, "Page.getFrameTree");
  const cdpFrameId = matchCdpFrame(frameTree, f.url);
  if (!cdpFrameId) throw new Error(`can't map frame ${frameId} (${f.url}) to a CDP frame (no unique URL match)`);
  const { backendNodeId } = await cmd(tabId, "DOM.getFrameOwner", { frameId: cdpFrameId });
  try {
    await cmd(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    /* best effort */
  }
  const { model } = await cmd(tabId, "DOM.getBoxModel", { backendNodeId });
  const q: number[] = model.content; // [x1,y1,...] - top-left first
  return { x: Math.min(q[0], q[2], q[4], q[6]), y: Math.min(q[1], q[3], q[5], q[7]) };
}

// Top-level viewport coordinates of a PLAIN snapshot ref (or a selector) for CDP Input: run bbAct
// "locate" in the owning frame (scrolls it into view, focuses it, returns its frame-local centre),
// then add the frame's offset in the page - from the same-origin frameElement chain the locate
// itself computes, or CDP for cross-origin frames.
async function locateForTrusted(tab: chrome.tabs.Tab, ref: number | null, selector: string | null): Promise<{ x: number; y: number; frameId: number; reResolved?: boolean }> {
  const { result: loc, frameId } = await actAllFrames(tab, ["locate", { ref, sel: selector, value: null } satisfies BbActParams]);
  if (!loc || loc.notFound || frameId == null) {
    throw new Error(ref != null ? `ref ${ref} is not in the page's ref registry - take a new snapshot` : `Element not found for selector: ${selector}`);
  }
  if (loc.staleRef) throw new Error(staleRefMessage(ref, loc));
  let x = loc.x, y = loc.y;
  if (frameId !== 0 && !loc.isTop) {
    if (!loc.crossOrigin) {
      x += loc.ox;
      y += loc.oy;
    } else {
      const off = await cdpFrameOffset(tab.id!, frameId);
      x += off.x;
      y += off.y;
    }
  }
  return { x, y, frameId, ...(loc.reResolved ? { reResolved: true } : {}) };
}

function staleRefMessage(ref: number | null, v: any): string {
  if (v?.was) {
    return `stale-ref: element ${ref} changed since the snapshot (was ${v.was}, now ${v.now})${v.ambiguous ? " and several elements now match it" : ""}; take a new snapshot`;
  }
  return `stale-ref: the element ref ${ref} pointed at is gone from the DOM (re-render/navigation) - take a new snapshot`;
}

// Trusted (isTrusted, CDP Input) click/hover/type. Deep-snapshot refs (>= DEEP_REF_BASE) resolve to
// CDP nodes; plain snapshot refs and selectors are located in-page (frame- and shadow-aware) and
// mapped to top-level viewport coordinates. A selector the in-page locate can't find falls back to
// CDP DOM.querySelector.
async function trustedAction(tab: chrome.tabs.Tab, action: string, ref: number | null, selector: string | null, text?: string): Promise<any> {
  const tabId = tab.id!;
  await ensureAttached(tabId);
  let x: number, y: number;
  let extra: any = {};
  let nodeId: number | null = null;
  if (ref != null && ref >= DEEP_REF_BASE) nodeId = await cdpResolveByRef(tabId, ref);
  else {
    try {
      const loc = await locateForTrusted(tab, ref, selector);
      x = loc.x;
      y = loc.y;
      if (loc.reResolved) extra.reResolved = true;
    } catch (e) {
      if (ref != null || !selector) throw e;
      nodeId = await cdpResolveBySelector(tabId, selector);
    }
  }
  if (action === "type") {
    // the in-page locate already focused the element; a CDP-resolved node is focused via DOM.focus
    if (nodeId != null) await cmd(tabId, "DOM.focus", { nodeId });
    for (const ch of Array.from(text ?? "")) {
      await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
      await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(15); // real inter-keystroke timing
    }
    return { typed: (text ?? "").length, trusted: true, ...extra };
  }
  if (nodeId != null) ({ x, y } = await cdpCenter(tabId, nodeId));
  x = x!;
  y = y!;
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  if (action === "hover") return { hovered: true, trusted: true, x, y, ...extra };
  if (action === "click") {
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { clicked: true, trusted: true, x, y, ...extra };
  }
  throw new Error(`Unknown trusted action: ${action}`);
}

// ---- coordinate-level trusted input (CDP Input) — for canvas / remote-desktop / game targets ----
// Coords are CSS VIEWPORT pixels (top-left origin). Screenshots are device pixels, so map with the
// dpr the screenshot tool returns: inputCoord = screenshotPixel / dpr.
// (CDP_MODS / keyInfo live in act-logic.ts - pure and unit-tested.)
async function cdpInput(tabId: number, params: any): Promise<any> {
  const action: string = params.action;
  if (params.activate) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId!, { focused: true }).catch(() => {});
      await sleep(150);
    } catch {
      /* activation best-effort */
    }
  }
  await ensureAttached(tabId);
  const x = params.x, y = params.y;
  const needsXY = ["mouse_move", "left_click", "right_click", "middle_click", "double_click", "left_mouse_down", "left_mouse_up", "scroll", "left_click_drag"];
  if (needsXY.includes(action) && (typeof x !== "number" || typeof y !== "number")) {
    throw new Error(`input action '${action}' needs numeric x and y (CSS viewport pixels; divide screenshot pixels by dpr)`);
  }

  if (action === "mouse_move") {
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    return { moved: true, x, y };
  }
  if (action === "left_click" || action === "right_click" || action === "middle_click" || action === "double_click") {
    const button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
    const mask = button === "right" ? 2 : button === "middle" ? 4 : 1;
    const count = action === "double_click" ? 2 : Math.max(1, params.clickCount ?? 1);
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    for (let c = 1; c <= count; c++) {
      await cmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: mask, clickCount: c });
      await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: c });
    }
    return { clicked: action, x, y, clickCount: count };
  }
  if (action === "left_mouse_down") {
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    return { down: true, x, y };
  }
  if (action === "left_mouse_up") {
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { up: true, x, y };
  }
  if (action === "left_click_drag") {
    const x2 = params.x2, y2 = params.y2;
    if (typeof x2 !== "number" || typeof y2 !== "number") throw new Error("left_click_drag needs x2 and y2 (drag end, CSS px)");
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x + ((x2 - x) * i) / steps, y: y + ((y2 - y) * i) / steps, button: "left", buttons: 1 });
      await sleep(12);
    }
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
    return { dragged: true, from: [x, y], to: [x2, y2] };
  }
  if (action === "scroll") {
    const dx = params.dx ?? 0, dy = params.dy ?? 0;
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
    return { scrolled: true, x, y, dx, dy };
  }
  if (action === "type") {
    const text = String(params.text ?? "");
    for (const ch of Array.from(text)) {
      await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
      await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(8);
    }
    return { typed: text.length };
  }
  if (action === "key") {
    const combo = String(params.key ?? "");
    if (!combo && !params.code) throw new Error("input action 'key' needs a key (e.g. 'Enter', 'ctrl+c') or an explicit code");
    let mods = 0;
    let base = "";
    for (const p of combo.split("+").map((s) => s.trim()).filter(Boolean)) {
      const lk = p.toLowerCase();
      if (CDP_MODS[lk] !== undefined) mods |= CDP_MODS[lk];
      else base = p;
    }
    const info = base ? keyInfo(base) : { key: "", code: "", vk: 0 };
    const key = info.key;
    const code = params.code ?? info.code;
    const vk = params.keyCode ?? info.vk;
    // printable single char with only Shift (or no) modifier → send text so the char inputs
    const printable = key.length === 1 && (mods & ~8) === 0;
    const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods } as any;
    const down: any = { ...common, type: printable ? "keyDown" : "rawKeyDown" };
    if (printable) { down.text = mods & 8 ? key.toUpperCase() : key; down.unmodifiedText = key; }
    await cmd(tabId, "Input.dispatchKeyEvent", down);
    await cmd(tabId, "Input.dispatchKeyEvent", { ...common, type: "keyUp" });
    return { key: combo || code, modifiers: mods };
  }
  throw new Error(`Unknown input action: ${action} (mouse_move|left_click|right_click|middle_click|double_click|left_mouse_down|left_mouse_up|left_click_drag|scroll|type|key)`);
}

// CDP deep snapshot: walks the pierced DOM tree (incl. CLOSED shadow roots and iframe docs),
// stamps refs -> backendNodeId in the session so trusted interaction can act on them.
async function cdpDeepSnapshot(tabId: number, limit = SNAPSHOT_DEFAULT_LIMIT): Promise<any> {
  const s = await ensureAttached(tabId);
  const { root } = await cmd(tabId, "DOM.getDocument", { depth: -1, pierce: true });
  const INTERACTIVE = new Set(["BUTTON", "SELECT", "TEXTAREA", "SUMMARY"]);
  const ROLES = new Set([
    "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio",
    "switch", "combobox", "textbox", "searchbox", "treeitem", "slider", "spinbutton", "gridcell", "listbox",
  ]);
  let total = 0;
  const items: any[] = [];
  s.refNodes = new Map();
  s.deepGen++;
  const genBase = DEEP_REF_BASE + s.deepGen * DEEP_REF_GEN_WIDTH;
  let n = 0;

  const attrsOf = (node: any): Record<string, string> => {
    const a: Record<string, string> = {};
    const arr: string[] = node.attributes ?? [];
    for (let i = 0; i + 1 < arr.length; i += 2) a[arr[i]] = arr[i + 1];
    return a;
  };
  const textOf = (node: any): string => {
    let t = "";
    if (node.nodeType === 3) t += node.nodeValue ?? "";
    for (const c of node.children ?? []) t += textOf(c);
    return t;
  };
  const isInteractive = (node: any, attrs: Record<string, string>): boolean => {
    if (INTERACTIVE.has(node.nodeName)) return true;
    if (node.nodeName === "A") return "href" in attrs || "onclick" in attrs || !!attrs.role;
    if (node.nodeName === "INPUT") return (attrs.type || "").toLowerCase() !== "hidden";
    if ((node.nodeName === "VIDEO" || node.nodeName === "AUDIO") && "controls" in attrs) return true;
    if (attrs.role && ROLES.has(attrs.role.trim().split(/\s+/)[0])) return true;
    if ("contenteditable" in attrs && attrs.contenteditable !== "false") return true;
    if ("onclick" in attrs) return true;
    if ("tabindex" in attrs && attrs.tabindex !== "-1") return true;
    return false;
  };
  const walk = (node: any) => {
    if (!node) return;
    if (node.nodeType === 1) {
      const attrs = attrsOf(node);
      if (isInteractive(node, attrs) && ++total <= limit) {
        n++;
        const ref = genBase + n;
        const label = (textOf(node) || attrs["aria-label"] || attrs.placeholder || attrs.value || attrs.title || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        const entry: any = { ref, tag: node.nodeName.toLowerCase(), label };
        if (node.nodeName === "A" && attrs.href) entry.href = attrs.href.slice(0, 120);
        if (node.nodeName === "INPUT" && attrs.type) entry.type = attrs.type;
        if (attrs.role) entry.role = attrs.role;
        s.refNodes.set(ref, node.backendNodeId);
        items.push(entry);
      }
    }
    for (const c of node.children ?? []) walk(c);
    for (const sr of node.shadowRoots ?? []) walk(sr); // includes CLOSED shadow roots
    if (node.contentDocument) walk(node.contentDocument); // iframe subtree
  };
  walk(root);
  const out: any = { url: root.documentURL, count: items.length, total, truncated: total > items.length, deep: true };
  if (out.truncated) out.hint = `${total - items.length} more elements not listed; pass limit (max ${SNAPSHOT_MAX_LIMIT})`;
  out.elements = items;
  return out;
}

// ---- snapshot / ax_snapshot orchestration (two-phase, budgeted, routed refs) ----
// Every snapshot bumps an epoch. Phase 1 (bbSnapshot / bbAxSnapshot) runs in each frame concurrently
// and parks its priority-ordered candidates; the SW then splits the ref budget fairly across frames
// (snapshot-plan.ts), numbers each frame's refs as one dense, disjoint range, and phase 2
// (bbCommitRefs) registers them. The per-tab route table remembers which frame owns which range, so a
// ref is only ever resolved in the frame that issued it: a frame whose re-snapshot failed keeps its OLD
// __bbRefs map, but no current ref routes there, so its stale entries can't collide with a new range.
let snapEpoch = 0;
const refRoutes = new Map<number, { epoch: number; routes: RefRoute[] }>();

async function frameList(tab: chrome.tabs.Tab): Promise<number[]> {
  let frames: { frameId: number }[];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id! })) ?? [{ frameId: 0 }];
  } catch {
    frames = [{ frameId: 0 }];
  }
  const ids = frames.map((f) => f.frameId);
  ids.sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : 0)); // top frame first, rest in Chrome's order
  if (!ids.includes(0)) ids.unshift(0);
  return ids;
}

interface PlannedFrame {
  frameId: number;
  v: any; // the frame's phase-1 result
  offset: number;
  keep: number; // refs registered (0 = none)
}

async function twoPhaseSnapshot(
  tab: chrome.tabs.Tab,
  func: (...a: any[]) => any,
  extraArgs: any[],
  limit: number,
  countOf: (v: any) => number
): Promise<{ epoch: number; frames: PlannedFrame[]; skippedFrames: number[] }> {
  assertScriptable(tab);
  const epoch = ++snapEpoch;
  const ids = await frameList(tab);
  const skipped: number[] = []; // child frames that didn't answer in time (wedged ad/embed)
  const results = await Promise.all(
    ids.map(async (frameId) => {
      try {
        const ms = frameId === 0 ? INJECT_TOP_MS : INJECT_CHILD_MS;
        const res = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId: tab.id!, frameIds: [frameId] },
            func: func as any,
            args: clean([epoch, ...extraArgs]),
          }),
          ms,
          () => tabTimeoutMsg(tab.id, ms, frameId ? `frame ${frameId}` : "")
        );
        const v = res?.[0]?.result as any;
        if (!v || typeof v !== "object") return null;
        if (typeof v.error === "string") {
          if (frameId === 0) throw new Error(v.error);
          return null;
        }
        return { frameId, v };
      } catch (e) {
        // a hung top frame is an error, not an empty page; a hung child frame is skipped and reported
        if (frameId === 0 && (isTimeout(e) || (e instanceof Error && !/Cannot access|No frame|was removed/i.test(e.message)))) throw e;
        if (frameId !== 0 && isTimeout(e)) skipped.push(frameId);
        return null; // frame not injectable (about:blank, sandboxed, gone)
      }
    })
  );
  const ok = results.filter((r): r is { frameId: number; v: any } => !!r);
  const budgets = allocateFrameBudgets(ok.map((r) => countOf(r.v)), limit);
  const offsets = frameOffsets(budgets);
  const planned: PlannedFrame[] = ok.map((r, i) => ({ frameId: r.frameId, v: r.v, offset: offsets[i], keep: budgets[i] }));
  await Promise.all(
    planned.map(async (p) => {
      try {
        const ms = p.frameId === 0 ? INJECT_TOP_MS : INJECT_CHILD_MS;
        const res = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId: tab.id!, frameIds: [p.frameId] },
            func: bbCommitRefs as any,
            args: [epoch, p.offset, p.keep],
          }),
          ms,
          () => tabTimeoutMsg(tab.id, ms, p.frameId ? `frame ${p.frameId}` : "")
        );
        const v = res?.[0]?.result as any;
        if (!v || v.error) p.keep = 0;
      } catch {
        p.keep = 0; // frame went away between phases - its refs are not handed out
      }
    })
  );
  // Two snapshots racing on one tab (e.g. click{withSnapshot} + snapshot): the OLDER one finishing last
  // must not overwrite the newer routing, or refs the agent was just handed would be rejected as stale.
  const prevRoute = refRoutes.get(tab.id!);
  if (!prevRoute || epoch >= prevRoute.epoch) {
    refRoutes.set(tab.id!, {
      epoch,
      routes: planned.filter((p) => p.keep > 0).map((p) => ({ frameId: p.frameId, lo: p.offset + 1, hi: p.offset + p.keep })),
    });
  }
  return { epoch, frames: planned, skippedFrames: skipped };
}

// Frame that owns `ref` in the latest snapshot of this tab. undefined = no route table (e.g. the
// service worker restarted since the snapshot) so the caller falls back to asking every frame;
// null = the table exists but the ref isn't in it (from an older snapshot) -> stale.
function ownerFrameForRef(tabId: number, ref: number): number | null | undefined {
  const t = refRoutes.get(tabId);
  if (!t) return undefined;
  return routeRef(t.routes, ref);
}

// Banner-free plain snapshot across all frames.
async function shallowSnapshot(tab: chrome.tabs.Tab, params: any = {}): Promise<any> {
  const limit = clampLimit(params.limit);
  const opts = { limit, viewportOnly: !!params.viewportOnly, modalOnly: !!params.modalOnly, filter: params.filter ? String(params.filter) : null };
  const { frames, skippedFrames } = await twoPhaseSnapshot(tab, bbSnapshot, [opts], limit, (v) => (v.elements ? v.elements.length : 0));
  const elements: any[] = [];
  let total = 0;
  let scanCapped = false;
  let modal: string | undefined;
  for (const f of frames) {
    total += f.v.total ?? 0;
    if (f.v.scanCapped) scanCapped = true;
    if (f.v.modal && !modal) modal = f.frameId === 0 ? f.v.modal : `${f.v.modal} (frame ${f.frameId})`;
    const els: any[] = f.v.elements ?? [];
    for (let i = 0; i < f.keep && i < els.length; i++) {
      const e = { ref: f.offset + i + 1, ...els[i] };
      if (f.frameId !== 0) e.frameId = f.frameId;
      elements.push(e);
    }
  }
  const truncated = total > elements.length || scanCapped;
  const out: any = { url: tab.url, count: elements.length, total, truncated };
  if (skippedFrames.length) out.skippedFrames = skippedFrames; // child frames that timed out (not listed)
  if (truncated) {
    out.hint =
      `${Math.max(0, total - elements.length)}${scanCapped ? "+" : ""} more elements not listed (priority order: open dialogs/popovers, then in-viewport, then the rest); ` +
      `pass limit (max ${SNAPSHOT_MAX_LIMIT}), or filter:"text", or viewportOnly:true`;
  }
  if (modal) {
    out.modal = modal;
    out.modalOnly = "a modal dialog is open: elements behind it are marked behindModal:true (likely not clickable); pass modalOnly:true to list only the dialog";
  }
  out.elements = elements;
  return out;
}

// Banner-free accessibility-tree snapshot (same two-phase ref scheme). The extension returns the
// structured per-frame trees; the server renders the compact text (server/src/ax.ts).
async function axSnapshot(tab: chrome.tabs.Tab, params: any = {}): Promise<any> {
  const limit = clampLimit(params.limit);
  const { frames, skippedFrames } = await twoPhaseSnapshot(tab, bbAxSnapshot, [], limit, (v) => v.total ?? 0);
  const outFrames: any[] = [];
  for (const f of frames) {
    const assigned = assignAxRefs(f.v.root, f.offset, f.keep);
    const fr: any = { frameId: f.frameId, url: f.v.url, root: f.v.root ?? null, truncated: !!f.v.truncated };
    if ((f.v.total ?? 0) > assigned) {
      fr.refsTotal = f.v.total;
      fr.refsAssigned = assigned;
    }
    if (f.v.modal) fr.modal = f.v.modal;
    outFrames.push(fr);
  }
  const axOut: any = { url: tab.url, limit, frames: outFrames };
  if (skippedFrames.length) axOut.skippedFrames = skippedFrames; // child frames that timed out
  return axOut;
}

// Give a framework a moment to render an action's result before withSnapshot captures it: wait for
// the top frame's DOM to be mutation-quiet for 150ms (capped at 800ms). Best-effort.
async function waitDomQuiet(tab: chrome.tabs.Tab, quietMs = 150, capMs = 800): Promise<void> {
  try {
    await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, func: bbDomQuiet as any, args: [quietMs, capMs] }),
      sleep(capMs + 200),
    ]);
  } catch {
    /* navigating / not injectable - snapshot anyway */
  }
}

// Optionally attaches a fresh shallow snapshot to an interaction result (params.withSnapshot),
// so a caller doing e.g. click-then-observe can skip a separate follow-up snapshot() call.
// A snapshot failure is reported inline rather than masking the (already-succeeded) action result.
async function withSnapshotIfRequested(tab: chrome.tabs.Tab, params: any, result: any): Promise<any> {
  if (!params?.withSnapshot || !result || typeof result !== "object") return result;
  try {
    await waitDomQuiet(tab);
    result.snapshot = await shallowSnapshot(tab);
  } catch (e) {
    result.snapshot = { error: e instanceof Error ? e.message : String(e) };
  }
  return result;
}

// After-action effect summary for click / press_key: {url, title, urlChanged, newTabId?}, so the
// agent doesn't need 2-3 follow-up calls to learn what its action did. Start the watch BEFORE the
// action (so a new tab opened by it isn't missed), then finish() after: it waits up to maxMs for the
// first of a URL change on this tab, a new tab opened from it (openerTabId), or the DOM settling
// (EFFECT_IDLE_MS / EFFECT_QUIET_MS). Cheap and best-effort - it never throws, and an in-page probe that can't run (page
// navigating, a dialog open) is simply bounded by the timer.
const EFFECT_IDLE_MS = 50; // no mutation at all within this -> the action had no (sync-ish) DOM effect
const EFFECT_QUIET_MS = 75; // after a mutation: this long without another one = the render settled

function startEffectWatch(tab: chrome.tabs.Tab) {
  const tabId = tab.id!;
  const beforeUrl = tab.url ?? "";
  let newTabId: number | undefined;
  let urlChanged = false;
  let wake: (() => void) | null = null;
  const onCreated = (t: chrome.tabs.Tab) => {
    if (t.openerTabId === tabId && t.id != null && newTabId == null) {
      newTabId = t.id;
      wake?.();
    }
  };
  const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id === tabId && info.url && info.url !== beforeUrl) {
      urlChanged = true;
      wake?.();
    }
  };
  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  const stop = () => {
    chrome.tabs.onCreated.removeListener(onCreated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
  return {
    stop,
    async finish(maxMs = 500): Promise<{ url: string; title: string; urlChanged: boolean; newTabId?: number }> {
      try {
        if (!urlChanged && newTabId == null) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, maxMs);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
            chrome.scripting
              .executeScript({
                target: { tabId, frameIds: [0] },
                world: "ISOLATED",
                // Cheap settle: resolve after idleMs if the page shows no mutation at all (most
                // clicks), else once the DOM has been quiet for quietMs after the last mutation (a
                // framework commit), capped. Was a flat 150ms quiet window - the bulk of a click.
                func: (idleMs: number, quietMs: number, capMs: number) =>
                  new Promise<boolean>((res) => {
                    // A hidden tab (not kept alive) renders nothing and throttles these timers to ~1s:
                    // waiting would only burn the whole cap. URL/new-tab effects are still caught by
                    // the tab listeners.
                    if (document.visibilityState === "hidden") return res(true);
                    let t: any;
                    let cap: any;
                    const obs = new MutationObserver(() => {
                      clearTimeout(t);
                      t = setTimeout(() => done(true), quietMs);
                    });
                    const done = (v: boolean) => {
                      obs.disconnect();
                      clearTimeout(t);
                      clearTimeout(cap);
                      res(v);
                    };
                    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
                    t = setTimeout(() => done(true), idleMs);
                    cap = setTimeout(() => done(false), capMs);
                  }),
                args: [EFFECT_IDLE_MS, EFFECT_QUIET_MS, Math.max(50, maxMs - 50)],
              })
              .then((r) => {
                if (r?.[0]?.result === true) wake?.();
              })
              .catch(() => {});
          });
        }
      } catch {
        /* never fail the action */
      } finally {
        wake = null;
        stop();
      }
      let fresh: chrome.tabs.Tab | null = null;
      try {
        fresh = await chrome.tabs.get(tabId);
      } catch {}
      const url = fresh?.pendingUrl || fresh?.url || beforeUrl;
      const out: { url: string; title: string; urlChanged: boolean; newTabId?: number } = {
        url,
        title: fresh?.title ?? "",
        urlChanged: urlChanged || url !== beforeUrl,
      };
      if (newTabId != null) out.newTabId = newTabId;
      return out;
    },
  };
}

// Attach the effect summary to a successful action result; never lets it fail the action.
// ---- per-action dialog guard ----
// Chrome cannot answer an alert/confirm/prompt through chrome.debugger unless the debugger was attached
// BEFORE the dialog opened (a late session gets "No dialog is showing" and Page.enable hangs behind the
// blocked renderer - verified against bare Chromium). So when the agent opts in with onDialog, the action
// briefly replaces window.alert/confirm/prompt in the page's MAIN world (every frame), answers as told,
// and records what was shown on a DOM attribute named with a per-call random nonce (so a page cannot
// pre-plant fake dialog reports into the agent's result). The guard is removed as soon as the action
// finishes (collectGuardedDialogs, also on failure), on pagehide, or by a TTL backstop. Overlapping guards
// on one page are tracked in a registry so removing one never strands another or the page's originals.
// beforeunload is not covered (it is not a window method). Without onDialog nothing is installed.
function newGuardNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function armDialogGuard(tab: chrome.tabs.Tab, nonce: string, mode: "accept" | "dismiss", promptText: string | null, ttlMs: number): Promise<void> {
  await injectAllFrames(
    tab,
    (nonce: string, mode: string, promptText: string | null, ttl: number) => {
      const w = window as any;
      let reg = w.__bbDlgGuard;
      if (!reg || !(reg.guards instanceof Map) || !reg.real) {
        reg = { real: { alert: w.alert, confirm: w.confirm, prompt: w.prompt }, guards: new Map() };
        Object.defineProperty(w, "__bbDlgGuard", { value: reg, configurable: true, writable: true, enumerable: false });
        const active = () => {
          let last: any = null;
          for (const g of reg.guards.values()) last = g; // most recently armed wins
          return last;
        };
        const rec = (g: any, type: string, msg: unknown, answer: unknown) => {
          const attr = "data-bb-dlg-" + g.nonce;
          let list: any[] = [];
          try {
            list = JSON.parse(document.documentElement.getAttribute(attr) || "[]");
          } catch {}
          list.push({ type, message: String(msg ?? "").slice(0, 500), accepted: g.accept, answer });
          document.documentElement.setAttribute(attr, JSON.stringify(list.slice(-10)));
        };
        w.alert = function (m?: unknown) {
          const g = active();
          if (!g) return reg.real.alert.call(w, m);
          rec(g, "alert", m, null);
        };
        w.confirm = function (m?: unknown) {
          const g = active();
          if (!g) return reg.real.confirm.call(w, m);
          rec(g, "confirm", m, g.accept);
          return g.accept;
        };
        w.prompt = function (m?: unknown, d?: unknown) {
          const g = active();
          if (!g) return reg.real.prompt.call(w, m, d);
          const v = g.accept ? (g.promptText ?? (d == null ? "" : String(d))) : null;
          rec(g, "prompt", m, v);
          return v;
        };
        reg.removeAll = () => {
          for (const g of reg.guards.values()) clearTimeout(g.t);
          reg.guards.clear();
          w.alert = reg.real.alert;
          w.confirm = reg.real.confirm;
          w.prompt = reg.real.prompt;
          delete w.__bbDlgGuard;
        };
        reg.remove = (n: string) => {
          const g = reg.guards.get(n);
          if (g) clearTimeout(g.t);
          reg.guards.delete(n);
          if (!reg.guards.size) reg.removeAll();
        };
        // A navigation away (incl. into bfcache) must not keep answering dialogs when the user comes back.
        w.addEventListener("pagehide", () => reg.removeAll?.(), { once: true });
      }
      reg.guards.set(nonce, { nonce, accept: mode === "accept", promptText, t: setTimeout(() => reg.remove(nonce), ttl) });
      return true;
    },
    [nonce, mode, promptText, ttlMs],
    "MAIN"
  );
}

/** Remove this action's guard (every frame) and return the dialogs it answered. Never throws. */
async function collectGuardedDialogs(tab: chrome.tabs.Tab, nonce: string): Promise<any[]> {
  await injectAllFrames(
    tab,
    (n: string) => {
      (window as any).__bbDlgGuard?.remove?.(n);
      return true;
    },
    [nonce],
    "MAIN"
  ).catch(() => {});
  try {
    const res = await injectAllFrames(
      tab,
      (n: string) => {
        const attr = "data-bb-dlg-" + n;
        const raw = document.documentElement.getAttribute(attr);
        document.documentElement.removeAttribute(attr);
        try {
          const v = raw ? JSON.parse(raw) : [];
          return Array.isArray(v) ? v.slice(0, 10) : [];
        } catch {
          return [];
        }
      },
      [nonce]
    );
    return res.flatMap((r: any) => (Array.isArray(r?.result) ? r.result : []));
  } catch {
    return [];
  }
}

/** Run one action under an optional dialog guard; the guard is always removed, even if the action throws. */
async function withDialogGuard(tab: chrome.tabs.Tab, params: any, ttlMs: number, run: () => Promise<any>): Promise<any> {
  const mode = params.onDialog === "accept" || params.onDialog === "dismiss" ? (params.onDialog as "accept" | "dismiss") : null;
  if (!mode) return run();
  const nonce = newGuardNonce();
  await armDialogGuard(tab, nonce, mode, typeof params.promptText === "string" ? params.promptText : null, ttlMs);
  let result: any;
  try {
    result = await run();
  } catch (e) {
    await collectGuardedDialogs(tab, nonce);
    throw e;
  }
  const dialogs = await collectGuardedDialogs(tab, nonce);
  if (dialogs.length && result && typeof result === "object") result = { ...result, dialogs };
  return result;
}

async function withEffects(watch: ReturnType<typeof startEffectWatch>, result: any, succeeded: boolean): Promise<any> {
  if (!succeeded || !result || typeof result !== "object") {
    watch.stop();
    return result;
  }
  try {
    return { ...result, ...(await watch.finish()) };
  } catch {
    return result;
  }
}

// Synthetic press_key in the frame that holds focus (all-frames probe of document.hasFocus()).
async function pressKeySynthetic(tab: chrome.tabs.Tab, combo: string): Promise<any> {
  const k = parseKeyCombo(combo);
  if (!k.key) throw new Error(`press_key: can't parse key ${JSON.stringify(combo)}`);
  let frameId = 0;
  try {
    const probes = await injectAllFrames(tab, () => {
      let a: Element | null = document.activeElement;
      while (a && (a as HTMLElement).shadowRoot && (a as HTMLElement).shadowRoot!.activeElement) a = (a as HTMLElement).shadowRoot!.activeElement;
      return {
        hasFocus: document.hasFocus(),
        activeIsFrame: !!a && (a.tagName === "IFRAME" || a.tagName === "FRAME"),
        activeIsBody: !a || a === document.body || a === document.documentElement,
      };
    });
    const list: FocusProbe[] = [];
    for (const r of probes) if (r?.result && typeof r.result === "object") list.push({ frameId: r.frameId, ...(r.result as any) });
    frameId = pickFocusedFrame(list);
  } catch {
    frameId = 0;
  }
  const keyInit = { key: k.key, code: k.code, vk: k.vk, shift: k.shift, ctrl: k.ctrl, alt: k.alt, meta: k.meta };
  const v = await actInFrame(tab, frameId, ["key", { keyInit } satisfies BbActParams]);
  if (!v || v.notFound) throw new Error("press_key: the focused frame could not be scripted");
  return { ...v, pressed: combo, ...(frameId !== 0 ? { frameId } : {}) };
}

// Trusted press_key via CDP Input.dispatchKeyEvent (isTrusted; Enter carries "\r" so it submits /
// activates like a real key). Goes to whatever the page has focused.
async function pressKeyTrusted(tab: chrome.tabs.Tab, combo: string): Promise<any> {
  const tabId = tab.id!;
  await ensureAttached(tabId);
  const k = parseKeyCombo(combo);
  if (!k.key) throw new Error(`press_key: can't parse key ${JSON.stringify(combo)}`);
  const printable = k.key.length === 1 && !k.ctrl && !k.meta && !k.alt;
  const text = k.key === "Enter" ? "\r" : printable ? (k.shift ? k.key.toUpperCase() : k.key) : undefined;
  const common: any = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers };
  const down: any = { ...common, type: text ? "keyDown" : "rawKeyDown" };
  if (text) {
    down.text = text;
    down.unmodifiedText = k.key === "Enter" ? "\r" : k.key;
  }
  await cmd(tabId, "Input.dispatchKeyEvent", down);
  await cmd(tabId, "Input.dispatchKeyEvent", { ...common, type: "keyUp" });
  return { pressed: combo, trusted: true };
}

const HOVER_REVEAL_WAIT_MS = 1000;

// Run a synthetic interaction with auto-wait actionability retry + trusted escalation.
// Retries while the element is missing or transiently not-actionable (hidden/disabled) up to
// params.timeoutMs (default 5000). For click, if the target is COVERED by an overlay, it escalates
// to a real trusted CDP click (unless noEscalate/autoTrusted:false), which scrolls it into view and
// clicks the real coordinates - reporting via:"trusted". Structured {notActionable, reason} otherwise.
async function interact(tab: chrome.tabs.Tab, action: string, ref: number | null, sel: string | null, value: string | null, params: any): Promise<any> {
  const timeoutMs = params.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  // Deep-snapshot refs are CDP node handles, not entries in the page's ref registry - the synthetic
  // path can never resolve them, so say exactly what to do instead of "unknown ref".
  if (ref != null && ref >= DEEP_REF_BASE) {
    return {
      notActionable: true,
      reason: "deep-ref-needs-trusted",
      detail:
        action === "fill"
          ? `ref ${ref} is from snapshot({deep:true}); deep refs only work with trusted actions. Take a plain snapshot() and fill by its ref, or use type with trusted:true.`
          : `ref ${ref} is from snapshot({deep:true}); deep refs only work with trusted actions - pass trusted:true.`,
      ref,
    };
  }
  let args: any[] = [action, { ref, sel, value } satisfies BbActParams];
  let last: any = null;
  let ownerFrame: number | null = null; // once a frame owns the element, retry only there
  let pickInfo: { matchCount?: number; note?: string } = {};
  let skippedFrames = 0; // child frames that did not answer (not searched) on the latest all-frames pass
  for (;;) {
    if (ownerFrame == null) {
      const r = await actAllFrames(tab, [action, { ref, sel, value } satisfies BbActParams]);
      last = r.result;
      ownerFrame = r.frameId;
      skippedFrames = r.skipped ?? 0;
      if (r.nth != null) args = [action, { ref, sel, value, nth: r.nth } satisfies BbActParams];
      if (r.matchCount != null) pickInfo = { matchCount: r.matchCount, note: r.note };
    } else {
      last = await actInFrame(tab, ownerFrame, args);
      if (last?.notFound) ownerFrame = null; // the frame lost the element - re-search all frames
      // A selector whose chosen match is (still) hidden: re-locate next tick, a visible match may have appeared.
      else if (sel != null && ref == null && last?.notActionable && last.reason === "hidden") ownerFrame = null;
    }
    // A ref that no frame can resolve will NOT recover by waiting: window.__bbRefs is only
    // repopulated by a new snapshot, and a detached node never reattaches. Retrying it just burned
    // the whole timeout (measured 5107ms) to return the same failure, so fail fast and say what to
    // do about it. A SELECTOR miss still retries - that element can legitimately appear later - and
    // notActionable (hidden/disabled) keeps retrying in both modes, which is the useful auto-wait.
    if (ref != null && (last?.staleRef || last?.notFound)) {
      const stale = !!last?.staleRef;
      return {
        notActionable: true,
        reason: stale ? "stale-ref" : "unknown-ref",
        detail: stale
          ? staleRefMessage(ref, last)
          : "this ref is not from the latest snapshot (taking any snapshot - snapshot or ax_snapshot - invalidates earlier refs; a navigation clears them too) - take a new snapshot",
        ref,
        ...(stale && last.was ? { was: last.was, now: last.now } : {}),
      };
    }
    const retryable = last && (last.notFound || (last.notActionable && last.reason !== "covered"));
    if (!retryable || Date.now() >= deadline || isCancelled(params)) break; // server gave up: stop acting
    // A 0x0 target inside a visible container is almost always hover-revealed (only a trusted hover
    // shows it): waiting the full default 5s won't help, so give up after ~1s with the hover hint.
    if (last.hoverReveal && params.timeoutMs == null && Date.now() >= deadline - timeoutMs + HOVER_REVEAL_WAIT_MS) break;
    await sleep(150);
  }
  // Selector disambiguation info rides along when the selector matched more than one element.
  const withPick = (r: any) => (r && typeof r === "object" && (pickInfo.matchCount ?? 0) > 1 ? { ...r, matchCount: pickInfo.matchCount, note: pickInfo.note } : r);
  if (action === "click" && last?.notActionable && last.reason === "covered" && params.autoTrusted !== false && !params.noEscalate) {
    try {
      // Escalation attaches the debugger: keep a hidden tab rendering for it (ref-counted, so nesting
      // inside the click's own withLiveTab is fine) - CDP mouse input otherwise waits ~5s per event.
      const t = await withLiveTab(tab, params, true, () => trustedAction(tab, "click", ref, sel));
      return withPick({ ...t, via: "trusted", wasCovered: true, coveredBy: last.coveredBy });
    } catch (e) {
      // trusted also failed - report the covered state, and why escalation didn't help
      return withPick({ ...last, escalationError: e instanceof Error ? e.message : String(e) });
    }
  }
  if (last?.notFound) {
    const out: any = { notActionable: true, reason: `not-found-after-${timeoutMs}ms`, ref, selector: sel };
    if (skippedFrames) {
      out.skippedFrames = skippedFrames;
      out.detail = `${skippedFrames} child frame(s) did not respond within ${INJECT_CHILD_MS / 1000}s and were not searched - the target may be inside one of them (still loading?)`;
    }
    return out;
  }
  return withPick(last);
}

async function dispatch(method: string, params: any): Promise<any> {
  switch (method) {
    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
      // A tab frozen by a JS dialog is otherwise invisible until a tool times out on it.
      const dlg = (t: chrome.tabs.Tab) => {
        const d = t.id != null ? pendingDialogs.get(t.id) : undefined;
        return d ? { dialog: { type: d.type, message: d.message } } : {};
      };
      if (params?.short) {
        return tabs.map((t) => ({ id: t.id, title: t.title, origin: safeOrigin(t.url), active: t.active, ...dlg(t) }));
      }
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, incognito: t.incognito, ...dlg(t) }));
    }

    case "tab_new": {
      let tab: chrome.tabs.Tab;
      if (params.regularWindow) {
        const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
        const regular = windows.find(w => !w.incognito && w.focused) ?? windows.find(w => !w.incognito);
        if (regular?.id !== undefined) tab = await chrome.tabs.create({ url: params.url, windowId: regular.id });
        else {
          const window = await chrome.windows.create({ url: params.url, incognito: false, focused: true });
          if (!window.tabs?.[0]?.id) throw new Error("Could not create a regular browser tab");
          tab = window.tabs[0];
        }
      } else tab = await chrome.tabs.create({ url: params.url });
      const load = startLoadWait(tab.id!, { waitUntil: parseWaitUntil(params.waitUntil), cancelKey: params });
      const waited = await load.wait();
      const fresh = await chrome.tabs.get(tab.id!);
      return {
        tabId: fresh.id,
        title: fresh.title,
        url: fresh.url,
        incognito: fresh.incognito,
        ...(waited.loadTimedOut ? { loadTimedOut: true } : {}),
        ...(waited.dialog ? { dialog: waited.dialog } : {}),
      };
    }

    case "tab_activate": {
      const tab = await chrome.tabs.get(params.tabId);
      await chrome.tabs.update(tab.id!, { active: true });
      await chrome.windows.update(tab.windowId!, { focused: true });
      return { ok: true, title: tab.title };
    }

    case "tab_close": {
      const ids: number[] = params.tabIds ?? (params.tabId !== undefined ? [params.tabId] : []);
      if (ids.length === 0) return { error: "No tab ids provided" };
      const closed: number[] = [];
      const failed: { tabId: number; error: string }[] = [];
      for (const id of ids) {
        try {
          await chrome.tabs.remove(id);
          closed.push(id);
        } catch (e) {
          failed.push({ tabId: id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { closed, failed };
    }

    case "navigate": {
      const tab = await targetTab(params.tabId);
      const before = tab.url;
      // Listen BEFORE issuing the navigation so a fast load can't complete unseen.
      const load = startLoadWait(tab.id!, { waitUntil: parseWaitUntil(params.waitUntil), cancelKey: params, targetUrl: params.url });
      try {
        await chrome.tabs.update(tab.id!, { url: params.url });
      } catch (e) {
        load.dispose();
        throw e;
      }
      const waited = await load.wait();
      const fresh = await chrome.tabs.get(tab.id!);
      const out: any = { tabId: fresh.id, title: fresh.title, url: fresh.url, incognito: fresh.incognito };
      if (waited.loadTimedOut) out.loadTimedOut = true;
      const dialog = waited.dialog ?? pendingDialogs.get(tab.id!);
      // A beforeunload ("Leave site?") dialog holds or cancels the navigation and the tab stays on the
      // old page. Reporting plain success there had agents reasoning about a page that never loaded.
      if (dialog) {
        out.navigated = false;
        out.dialog = dialog;
        out.error =
          `navigation is blocked by a JavaScript ${dialog.type} dialog ("${dialog.message.slice(0, 120)}") - ` +
          `call handle_dialog (accept:true to leave the page, false to stay), then retry if needed`;
      } else if (params.waitUntil !== "none" && fresh.url === before && !fresh.pendingUrl && !sameUrl(before, params.url)) {
        out.navigated = false;
        out.warning =
          "the tab's URL did not change - a beforeunload ('Leave site?') dialog may have blocked the navigation " +
          "(call handle_dialog), or the site redirected back to the same page";
      }
      return out;
    }

    case "get_page_text": {
      const tab = await targetTab(params.tabId);
      const results = await injectAllFrames(tab, bbPageText, [!!params.includeHidden]);
      const top = results.find((r) => r.frameId === 0)?.result as any;
      let combined = "";
      for (const r of results) {
        const v = r.result as any;
        if (!v || !v.text || !v.text.trim()) continue;
        if (r.frameId === 0) combined += v.text;
        else combined += `\n\n--- frame: ${v.url} ---\n${v.text}`;
      }
      const out: any = { title: top?.title ?? tab.title, url: top?.url ?? tab.url, text: combined };
      // Child frames that did not answer within INJECT_CHILD_MS: their text is missing from `text`.
      if (results.skippedFrames?.length) out.skippedFrames = results.skippedFrames.map((f) => ({ frameId: f.frameId, url: f.url }));
      return out;
    }

    case "snapshot": {
      const tab = await targetTab(params.tabId);
      // Visibility is probed alongside the snapshot (no added latency) and reported on it.
      const vis = tabVisibility(tab);
      const snap = params.deep ? await cdpDeepSnapshot(tab.id!, clampLimit(params.limit)) : await shallowSnapshot(tab, params);
      const v = await vis;
      if (v?.hidden && snap && typeof snap === "object") return { tabHidden: true, warning: HIDDEN_TAB_WARNING, ...snap };
      return snap;
    }

    case "click": {
      const tab = await targetTab(params.tabId);
      // Guard TTL covers the auto-wait (timeoutMs) plus a possible trusted escalation (attach ~12s).
      const result = await withDialogGuard(tab, params, (params.timeoutMs ?? 5_000) + 15_000, () =>
        withLiveTab(tab, params, !!params.trusted, async () => {
          const watch = startEffectWatch(tab);
          let r: any;
          try {
            r = params.trusted
              ? { ...(await trustedAction(tab, "click", params.ref ?? null, params.selector ?? null)), via: "trusted" }
              : await interact(tab, "click", params.ref, params.selector, null, params);
          } catch (e) {
            watch.stop();
            throw e;
          }
          return withEffects(watch, r, !!r?.clicked);
        })
      );
      return withSnapshotIfRequested(tab, params, result);
    }

    case "fill": {
      const tab = await targetTab(params.tabId);
      const result = await withLiveTab(tab, params, false, () => interact(tab, "fill", params.ref, params.selector, params.value ?? null, params));
      return withSnapshotIfRequested(tab, params, result);
    }

    case "hover": {
      const tab = await targetTab(params.tabId);
      const result = await withLiveTab(tab, params, !!params.trusted, () =>
        params.trusted
          ? trustedAction(tab, "hover", params.ref ?? null, params.selector ?? null)
          : interact(tab, "hover", params.ref, params.selector, null, params)
      );
      return withSnapshotIfRequested(tab, params, result);
    }

    case "type": {
      const tab = await targetTab(params.tabId);
      const result = await withLiveTab(tab, params, !!params.trusted, () =>
        params.trusted
          ? trustedAction(tab, "type", params.ref ?? null, params.selector ?? null, params.text)
          : interact(tab, "type", params.ref, params.selector, params.text ?? null, params)
      );
      return withSnapshotIfRequested(tab, params, result);
    }

    case "input": {
      const tab = await targetTab(params.tabId);
      // Always trusted (CDP Input): keep a hidden tab rendering, or every mouse move waits ~5s for a frame.
      return withLiveTab(tab, params, true, () => cdpInput(tab.id!, params));
    }

    case "file_upload": {
      const tab = await targetTab(params.tabId);
      if (params.path) {
        await ensureAttached(tab.id!);
        const nodeId = await cdpResolve(tab.id!, params.ref ?? null, params.selector ?? null);
        await cmd(tab.id!, "DOM.setFileInputFiles", { files: [params.path], nodeId });
        return { uploaded: params.path, trusted: true };
      }
      return injectAllAggregate(tab, bbAct, [
        "upload",
        {
          sel: params.selector ?? null,
          ref: params.ref ?? null,
          filename: params.filename ?? null,
          mimeType: params.mimeType ?? null,
          b64: params.base64 ?? null,
        } satisfies BbActParams,
      ]);
    }

    case "paste_html": {
      const tab = await targetTab(params.tabId);
      const tabId = tab.id!;
      await ensureAttached(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId!, { focused: true });
      await sleep(150);
      const html = JSON.stringify(String(params.html ?? ""));
      const text = JSON.stringify(String(params.text ?? ""));
      await cdpEvaluate(tabId, `(async () => { await navigator.clipboard.write([new ClipboardItem({"text/html":new Blob([${html}],{type:"text/html"}),"text/plain":new Blob([${text}],{type:"text/plain"})})]); return true; })()`);
      const isMac = /Mac/i.test(navigator.userAgent);
      const key = { key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: isMac ? 4 : 2 };
      await cmd(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, commands: ["Paste"] });
      await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
      return { pasted: true, trusted: true };
    }

    case "paste_image": {
      const tab = await targetTab(params.tabId);
      if (params.trusted) return trustedPasteImage(tab, params);
      return injectAllAggregate(tab, bbAct, [
        "pasteImage",
        {
          sel: params.selector ?? null,
          ref: params.ref ?? null,
          b64: params.base64 ?? null,
          mimeType: params.mimeType ?? "image/png",
          method: params.method ?? "paste",
        } satisfies BbActParams,
      ]);
    }

    case "go_back":
      return navByHistory(await targetTab(params.tabId), "back", params);

    case "go_forward":
      return navByHistory(await targetTab(params.tabId), "forward", params);

    case "handle_dialog": {
      const tab = await targetTab(params.tabId);
      const tabId = tab.id!;
      const known = pendingDialogs.get(tabId);
      const accept = params.accept !== false;
      // Do NOT use ensureAttached here: its DOM.enable needs the renderer's main thread, which an open
      // alert/confirm/prompt is blocking, so it hangs until the attach timeout - exactly when this tool is
      // needed. Answering a dialog is handled in the browser process, so a bare attach is enough. Page.enable
      // is attempted briefly (it also re-announces an already-open dialog) but its failure is not fatal.
      let tempAttach = false;
      if (!sessions.get(tabId)) {
        if (attaching.has(tabId)) await attaching.get(tabId)!.catch(() => {});
        if (!sessions.get(tabId)) {
          try {
            await withTimeout(attach(tabId), 5_000, "debugger attach for handle_dialog");
            tempAttach = true;
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            if (!/already attached/i.test(m)) throw e; // a stale attach of ours is fine: just send the command
          }
          await cmd(tabId, "Page.enable", undefined, 2_000).catch(() => {});
        }
      }
      try {
        await cmd(
          tabId,
          "Page.handleJavaScriptDialog",
          { accept, ...(typeof params.promptText === "string" ? { promptText: params.promptText } : {}) },
          5_000
        );
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/no dialog/i.test(m)) {
          pendingDialogs.delete(tabId);
          return {
            handled: false,
            tabId,
            message:
              `Chrome reports no dialog it can answer on tab ${tabId}. Either none is open, or it opened before ` +
              `the debugger was attached - Chrome only lets a debugger answer dialogs that open while it is ` +
              `attached. If the tab is stuck behind a dialog, the user has to click it in Chrome. To avoid this, ` +
              `pass onDialog:"accept"|"dismiss" to click/press_key so the action answers its own dialogs.`,
          };
        }
        throw e;
      } finally {
        // A temporary bare attach must not linger: no session tracks it (banner + reconcile would detach it later anyway).
        if (tempAttach) await new Promise<void>((r) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); }));
      }
      pendingDialogs.delete(tabId);
      return { handled: true, tabId, accepted: accept, type: known?.type, message: known?.message, url: known?.url };
    }

    // ---- chrome.debugger (CDP) tools ----

    case "net_capture_start": {
      const tab = await targetTab(params.tabId);
      const s = await ensureAttached(tab.id!);
      finalizeCapture(tab.id!); // close any prior persist sink on this tab before (re)starting
      await cmd(tab.id!, "Network.enable");
      s.net = new NetRing(NET_MAX_ENTRIES);
      s.extra = new Map();
      s.wsUrls = new Map();
      s.wsFrames = [];
      s.netOn = true;
      s.netFilter = params.urlFilter || undefined;
      s.excludeExtensionTraffic = !!params.excludeExtensionTraffic;
      s.netMax = Math.max(1, Math.min(params.maxEntries ?? NET_MAX_ENTRIES, 5000));
      s.net.max = s.netMax;
      if (s.flushTimer) {
        clearTimeout(s.flushTimer);
        s.flushTimer = null;
      }
      s.flushQueue = [];
      s.persist = !!params.persist;
      s.persistBodies = !!params.persistBodies;
      return { capturing: true, tabId: tab.id!, persist: s.persist, maxEntries: s.netMax, note: "Now navigate/reload the tab to capture its load traffic (incl. Set-Cookie and WebSocket frames). Banner is showing while attached." };
    }

    case "net_get_requests": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s) throw new Error("Not capturing on this tab - call net_capture_start first.");
      s.lastUsedAt = Date.now();
      const filter: string | undefined = params.urlFilter;
      let entries = s.net.list().filter((e) => !filter || (e.url ?? "").includes(filter));
      const limit = params.limit ?? 100;
      if (entries.length > limit) entries = entries.slice(-limit);
      const out: any[] = [];
      const bodyJobs: { row: any; requestId: string }[] = [];
      for (const e of entries) {
        const x = s.extra.get(e.requestId);
        const row: any = {
          requestId: e.requestId,
          ts: e.ts, // request-start wall clock; export_har needs it for a real waterfall
          method: e.method,
          url: e.url,
          type: e.type,
          status: e.status,
          mimeType: e.mimeType,
          failed: e.failed,
          timing: e.timing,
          // prefer the raw ExtraInfo header sets (they include Set-Cookie and the sent Cookie)
          requestHeaders: x?.reqHeaders ?? e.requestHeaders,
          responseHeaders: x?.respHeaders ?? e.responseHeaders,
        };
        if (x?.setCookie) row.setCookie = x.setCookie;
        if (e.requestBody) row.requestBody = e.requestBody;
        if (e.redirectLocation) row.redirectLocation = e.redirectLocation;
        // Bodies are fetched AFTER the rows are built, concurrently - see below.
        if (params.includeBodies && e.finished && !e.failed) bodyJobs.push({ row, requestId: e.requestId });
        out.push(row);
      }
      // `await` inside the row loop serialized every fetch, so the 6-slot semaphore never actually
      // ran anything in parallel (100 bodies = 100 sequential CDP round trips). Starting them all and
      // awaiting together lets the semaphore do its job; row order is untouched because each job
      // mutates the row object it captured.
      if (bodyJobs.length) {
        await Promise.all(
          bodyJobs.map(({ row, requestId }) =>
            bodyFetchSem
              .run(() => getResponseBody(tab.id!, requestId))
              .then((b) => {
                row.responseBody = b.body;
                row.responseBodyBase64 = b.base64;
                if (b.truncated) {
                  row.responseBodyTruncated = true;
                  row.responseBodyOriginalLength = b.originalLength;
                }
              })
              .catch((err) => {
                row.responseBodyError = err instanceof Error ? err.message : String(err);
              })
          )
        );
      }
      return { count: out.length, totalBuffered: s.net.size, requests: out };
    }

    case "net_get_body": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s) throw new Error("Not capturing on this tab - call net_capture_start first.");
      s.lastUsedAt = Date.now();
      const b = await bodyFetchSem.run(() => getResponseBody(tab.id!, params.requestId));
      return { requestId: params.requestId, base64: b.base64, body: b.body, truncated: !!b.truncated, originalLength: b.originalLength };
    }

    case "net_get_ws_frames": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s) throw new Error("Not capturing on this tab - call net_capture_start first.");
      s.lastUsedAt = Date.now();
      const filter: string | undefined = params.urlFilter;
      let frames = s.wsFrames.filter((f) => !filter || (f.url ?? "").includes(filter));
      const limit = params.limit ?? 200;
      if (frames.length > limit) frames = frames.slice(-limit);
      return { count: frames.length, totalBuffered: s.wsFrames.length, frames };
    }

    case "identity_capture": {
      const tab = await targetTab(params.tabId);
      await ensureAttached(tab.id!);
      await cmd(tab.id!, "Network.enable");
      const domain: string | undefined = params.domain;
      const all = await cmd(tab.id!, "Network.getAllCookies");
      let cookies: any[] = all?.cookies ?? [];
      if (domain) {
        const d = domain.replace(/^\./, "");
        cookies = cookies.filter((c) => {
          const cd = String(c.domain || "").replace(/^\./, "");
          return cd === d || cd.endsWith("." + d) || d.endsWith("." + cd) || cd.endsWith(d);
        });
      }
      let storage: any = {};
      try {
        storage = await inject(
          tab,
          () => ({
            local: Object.fromEntries(Object.entries(localStorage)),
            session: Object.fromEntries(Object.entries(sessionStorage)),
          }),
          [],
          "MAIN"
        );
      } catch {
        /* not scriptable */
      }
      let bearer: string | undefined;
      const s = sessions.get(tab.id!);
      if (s) {
        const list = s.net.list();
        for (let i = list.length - 1; i >= 0 && !bearer; i--) {
          const h = s.extra.get(list[i].requestId)?.reqHeaders ?? list[i].requestHeaders;
          if (h) bearer = (h as any).authorization ?? (h as any).Authorization;
        }
      }
      identities.set(params.name, { cookies, storage, bearer });
      void persistIdentities(); // survive an SW eviction
      return {
        name: params.name,
        cookies: cookies.length,
        httpOnly: cookies.filter((c) => c.httpOnly).length,
        hasStorage: !!(storage && (Object.keys(storage.local || {}).length || Object.keys(storage.session || {}).length)),
        hasBearer: !!bearer,
      };
    }

    case "identity_list":
      return {
        identities: [...identities.entries()].map(([name, v]) => ({
          name,
          cookies: v.cookies?.length ?? 0,
          hasBearer: !!v.bearer,
        })),
      };

    case "identity_purge": {
      const purged = identities.delete(params.name);
      void persistIdentities();
      return { purged, name: params.name };
    }

    case "replay_request": {
      const tab = await targetTab(params.tabId);
      return doReplay(tab, params);
    }

    case "request_details": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (params.requestId) {
        const e = s?.net.get(params.requestId);
        if (!e) throw new Error("requestId not found in this tab's capture buffer");
        const method = (e.method || "GET").toUpperCase();
        let body = e.requestBody;
        if (body == null && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          try {
            const pd = await cmd(tab.id!, "Network.getRequestPostData", { requestId: params.requestId });
            body = pd?.postData;
          } catch {
            /* body unavailable */
          }
        }
        return { url: e.url, method, headers: s!.extra.get(e.requestId)?.reqHeaders ?? e.requestHeaders ?? {}, body };
      }
      return { url: params.url, method: (params.method || "GET").toUpperCase(), headers: params.headers || {}, body: params.body };
    }

    case "authz_matrix": {
      const tab = await targetTab(params.tabId);
      const reqIds: string[] = params.requestIds ?? [];
      const idents: string[] = params.identities ?? [];
      if (!reqIds.length || !idents.length) throw new Error("Provide requestIds[] and identities[]");
      const s = sessions.get(tab.id!);
      const rows: any[] = [];
      const runOne = async (rid: string, urlOverride?: string, label?: string) => {
        const e = s?.net.get(rid);
        const cells: any[] = [];
        for (const ident of idents) {
          try {
            const r = await doReplay(tab, {
              tabId: tab.id,
              requestId: urlOverride == null ? rid : undefined,
              url: urlOverride ?? undefined,
              method: e?.method,
              identity: ident,
            });
            if (r && r.error) {
              cells.push({ identity: ident, error: r.error });
            } else {
              const body = typeof r.body === "string" ? r.body : "";
              cells.push({ identity: ident, status: r.status, bytes: body.length, bodyHash: djb2(body), body: body.slice(0, 2000) });
            }
          } catch (err) {
            cells.push({ identity: ident, error: err instanceof Error ? err.message : String(err) });
          }
        }
        rows.push({ requestId: rid, url: urlOverride ?? e?.url, method: e?.method, label, cells });
      };
      for (const rid of reqIds) {
        await runOne(rid);
        if (params.mutateIds) {
          const e = s?.net.get(rid);
          const nb = e?.url ? neighborUrl(e.url) : null;
          if (nb) await runOne(rid, nb, "id+1 neighbor");
        }
      }
      return { rows };
    }

    case "debugger_detach": {
      const tab = await targetTab(params.tabId);
      await detachSession(tab.id!);
      return { detached: true, tabId: tab.id! };
    }

    case "debugger_status": {
      if (params.tabId !== undefined) {
        const s = sessions.get(params.tabId);
        const detach = lastDetach.get(params.tabId);
        return s
          ? { tabId: params.tabId, attached: true, capturing: s.netOn, bufferedRequests: s.net.size, deepRefs: s.refNodes.size, idleMs: Date.now() - s.lastUsedAt, emulating: emulationState(params.tabId) }
          : { tabId: params.tabId, attached: false, lastDetach: detach };
      }
      return {
        sessions: [...sessions.entries()].map(([tabId, s]) => ({
          tabId,
          capturing: s.netOn,
          bufferedRequests: s.net.size,
          idleMs: Date.now() - s.lastUsedAt,
          emulating: emulationState(tabId),
        })),
        // Why a capture stopped, when it stopped on its own. "canceled_by_user" = the human dismissed
        // the debugging banner; "replaced_with_devtools" = they opened DevTools on that tab.
        lastDetach: [...lastDetach.entries()].map(([tabId, d]) => ({ tabId, ...d })),
      };
    }

    case "press_key": {
      const tab = await targetTab(params.tabId);
      const result = await withDialogGuard(tab, params, 15_000, () =>
        withLiveTab(tab, params, !!params.trusted, async () => {
          const watch = startEffectWatch(tab);
          let r: any;
          try {
            // synthetic: dispatched (deferred) in the frame holding focus; Enter submits only when not
            // preventDefault()ed, Tab moves focus. trusted: real CDP key events.
            r = params.trusted ? await pressKeyTrusted(tab, String(params.key ?? "")) : await pressKeySynthetic(tab, String(params.key ?? ""));
          } catch (e) {
            watch.stop();
            throw e;
          }
          return withEffects(watch, r, true);
        })
      );
      return withSnapshotIfRequested(tab, params, result);
    }

    case "scroll": {
      const tab = await targetTab(params.tabId);
      assertScriptable(tab);
      // Resolve the frame that owns the target: a ref routes to its issuing frame; a selector is
      // located across frames and one match is picked (same rules as click/fill); else the top frame.
      let frameId = 0;
      let nth: number | null = null;
      let pickNote: string | undefined;
      if (params.ref != null) {
        const owner = ownerFrameForRef(tab.id!, params.ref);
        if (owner === null) throw new Error(`ref ${params.ref} is not from the latest snapshot (taking any snapshot invalidates earlier refs) - take a fresh snapshot`);
        if (owner !== undefined) frameId = owner;
      } else if (params.selector) {
        const pick = await locateOne(tab, params.selector);
        if (!pick.chosen)
          throw new Error(
            `Element not found in any frame: ${params.selector}` +
              (pick.skipped ? ` (${pick.skipped} child frame(s) did not respond within ${INJECT_CHILD_MS / 1000}s and were not searched)` : "")
          );
        frameId = pick.chosen.frameId;
        nth = pick.chosen.index;
        pickNote = pick.note;
      }
      const scrollMs = frameId === 0 ? INJECT_TOP_MS : INJECT_CHILD_MS + 2_000;
      const res = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id!, frameIds: [frameId] },
          func: bbScroll as any,
          args: clean([
            {
              ref: params.ref ?? null,
              sel: params.ref != null ? null : params.selector ?? null,
              nth,
              dx: params.dx ?? null,
              dy: params.dy ?? null,
              direction: params.direction ?? null,
              amount: params.amount ?? null,
            },
          ]),
        }),
        scrollMs,
        () => tabTimeoutMsg(tab.id, scrollMs, frameId === 0 ? "scroll" : `scroll (frame ${frameId})`)
      );
      const result: any = res?.[0]?.result;
      if (!result || typeof result !== "object") throw new Error("scroll: no result from the page (frame navigating?)");
      if (typeof result.error === "string") throw new Error(result.error);
      if (frameId !== 0) result.frameId = frameId;
      if (pickNote) result.note = pickNote;
      return withSnapshotIfRequested(tab, params, result);
    }

    case "screenshot": {
      const tab = await targetTab(params.tabId);
      // captureVisibleTab supports jpeg + quality natively, so only fullPage/selector/scale actually
      // need CDP. Routing a plain jpeg through CDP cost a debugger attach (and the banner) for nothing.
      const fmt: "png" | "jpeg" = params.format === "jpeg" ? "jpeg" : "png";
      const rich = params.fullPage || params.selector || params.scale || (params.format && params.format !== "png" && params.format !== "jpeg");
      if (rich) return cdpScreenshot(tab, params);
      // default: banner-free visible-viewport PNG. captureVisibleTab grabs the ACTIVE tab of the given
      // window, so what it actually requires is that our tab is active in its own window - not that
      // Chrome owns OS focus. The two are treated separately on purpose: switching the active tab
      // needs a real repaint before capture, whereas raising an already-visible window does not, and
      // gating the settle on window focus meant a multi-window setup (or Chrome simply not being the
      // frontmost app) paid the full 350ms on every single screenshot.
      // jpeg carries a quality; png ignores it (Chrome rejects quality on png).
      const capOpts =
        fmt === "jpeg"
          ? { format: "jpeg" as const, quality: Math.max(1, Math.min(params.quality ?? 80, 100)) }
          : { format: "png" as const };
      // ACTIVATION AND CAPTURE MUST BE ATOMIC PER WINDOW. captureVisibleTab shoots whatever tab is
      // ACTIVE in the window, so doing the activate outside the lock let a second caller activate its
      // own tab in between - and the first caller then got the OTHER tab pixels back, labelled as its
      // own. That is silently wrong data rather than an error, which for an agent is the worst kind of
      // bug: it would reason confidently about a page it never asked for. Everything from re-reading
      // the tab to the capture now happens inside the window queue.
      const grab = async (): Promise<{ dataUrl: string; meta: any }> => {
        let cur = await chrome.tabs.get(tab.id!); // may have navigated or closed while queued
        // A queued capture can wait seconds for its turn, and by then the tab may be mid-navigation
        // with no committed url yet - captureVisibleTab then refuses with "Cannot access contents of
        // url \"\"". That is a not-ready tab, not a permission problem, so give it a moment to commit.
        for (let i = 0; i < 10 && !cur.url; i++) {
          await sleep(100);
          cur = await chrome.tabs.get(tab.id!);
        }
        const win = await chrome.windows.get(cur.windowId!);
        if (!cur.active) {
          await chrome.tabs.update(cur.id!, { active: true });
          await awaitPaint(cur, 350); // real paint signal, not a blind 350ms - see awaitPaint
        }
        if (!win.focused) {
          await chrome.windows.update(cur.windowId!, { focused: true }).catch(() => {});
          await sleep(60); // window raise - compositor only, no layout
        }
        // Started here so it overlaps the capture but still reflects the tab we are actually shooting.
        const metaPromise = viewportMeta(cur);
        const url = await chrome.tabs.captureVisibleTab(cur.windowId!, capOpts);
        return { dataUrl: url, meta: await metaPromise };
      };
      // Share an identical capture that is already running (see captureInFlight).
      const dedupeKey = `${tab.id}|${fmt}|${capOpts.quality ?? ""}`;
      const once = (): Promise<{ dataUrl: string; meta: any }> => {
        const running = captureInFlight.get(dedupeKey);
        if (running) return running;
        const mine = serializeCapture(tab.windowId!, grab).finally(() => {
          if (captureInFlight.get(dedupeKey) === mine) captureInFlight.delete(dedupeKey);
        });
        captureInFlight.set(dedupeKey, mine);
        return mine;
      };
      let shot: { dataUrl: string; meta: any };
      try {
        shot = await once();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Transient: the compositor can fail a readback, and the quota can still bite after an SW
        // respawn lost the queue timestamps. Retry once through the queue, then fall back to CDP -
        // Page.captureScreenshot has no quota and targets the tab directly, so a screenshot should
        // never hard-fail just because the window was busy a moment ago.
        // A grab that hit the queue's hard timeout (wedged / dialog-frozen tab) goes straight to CDP:
        // retrying it through the same queue would only wait out another timeout.
        if (isTimeout(e)) return cdpScreenshot(tab, { ...params, format: fmt });
        if (!/quota|readback|Failed to capture|Cannot access contents/i.test(msg)) throw e;
        try {
          shot = await serializeCapture(tab.windowId!, grab);
        } catch {
          return cdpScreenshot(tab, { ...params, format: fmt });
        }
      }
      return { base64: shot.dataUrl.replace(/^data:image\/(png|jpeg);base64,/, ""), format: fmt, ...shot.meta };
    }

    case "eval_js": {
      const tab = await targetTab(params.tabId);
      // Force the CDP path (Runtime.evaluate) - bypasses CSP unsafe-eval; shows the debugger banner.
      if (params.cdp) return cdpEvaluate(tab.id!, params.code, params.awaitPromise ?? true);
      // The in-page path awaits a returned thenable too (like the CDP path's awaitPromise), bounded a
      // little inside the server's own timeout so a never-settling promise reports instead of hanging.
      const awaitP = params.awaitPromise !== false;
      const budget = Math.max(1_000, (typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000) - 1_500);
      try {
        return await inject(
        tab,
        async (code: string, awaitP: boolean, ms: number) => {
          try {
            // eslint-disable-next-line no-eval
            let value = (0, eval)(code);
            if (awaitP && value != null && typeof value.then === "function") {
              const TIMEOUT = {};
              let timer: any;
              try {
                value = await Promise.race([
                  Promise.resolve(value),
                  new Promise((res) => {
                    timer = setTimeout(() => res(TIMEOUT), ms);
                  }),
                ]);
              } catch (e) {
                return { error: `Promise rejected: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` };
              } finally {
                clearTimeout(timer);
              }
              if (value === TIMEOUT) return { error: `eval_js: the returned Promise did not settle within ${ms}ms (raise timeoutMs, or pass awaitPromise:false)` };
            }
            let out: string;
            try {
              out = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
            } catch {
              out = String(value);
            }
            return { value: out.slice(0, 50_000) };
          } catch (e) {
            return { error: String(e) };
          }
        },
        [params.code, awaitP, budget],
        "MAIN",
        { timeoutMs: Math.max(INJECT_TOP_MS, budget + 1_000) }
      );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Auto-fallback: if the page CSP blocked in-page eval, evaluate via CDP instead (banner shown).
        const cspBlocked = /unsafe-eval|content security policy|evalerror/i.test(msg);
        if (cspBlocked && !params.noFallback) {
          const r = await cdpEvaluate(tab.id!, params.code, params.awaitPromise ?? true);
          r.via = "cdp-fallback";
          r.note = "in-page eval was blocked by the page CSP; evaluated via CDP (debugger banner shown). Pass noFallback:true to disable, or use cdp:true to skip straight to this path.";
          return r;
        }
        throw e;
      }
    }

    case "cdp_eval": {
      const tab = await targetTab(params.tabId);
      return cdpEvaluate(tab.id!, params.code, params.awaitPromise ?? true);
    }

    case "wait_for": {
      const tab = await targetTab(params.tabId);
      const hasTarget = !!(params.selector || params.text || params.role);
      if (!hasTarget) {
        // No target: a plain sleep of timeoutMs (default 1000ms).
        const ms = params.timeoutMs ?? 1_000;
        await sleep(ms);
        return { slept: ms };
      }
      assertScriptable(tab);
      const timeoutMs = params.timeoutMs ?? 10_000;
      const state: string = params.state ?? "visible";
      if (!["attached", "visible", "hidden", "detached"].includes(state)) throw new Error(`wait_for: unknown state "${state}" (attached|visible|hidden|detached)`);
      if (params.selector) await inject(tab, bbValidateSelector, [params.selector]); // throws a clear syntax error
      const spec = { sel: params.selector ?? null, text: params.text ?? null, role: params.role ?? null, name: params.name ?? null, state };
      const what = [params.selector && `selector ${params.selector}`, params.role && `role=${params.role}${params.name ? ` name~"${params.name}"` : ""}`, params.text && `text "${params.text}"`]
        .filter(Boolean)
        .join(" + ");
      const started = Date.now();
      const deadline = started + timeoutMs;
      const positive = state === "visible" || state === "attached";
      let lastErr: string | null = null;
      const skippedFrames = new Set<number>();
      // Each round probes every frame concurrently for a slice (<=1.5s, re-listing frames between
      // slices so new iframes / navigations are picked up). In-page probes resolve the moment the
      // condition holds. A probe that fails because the page is mid-navigation is just "not yet".
      // Every probe is bounded: a frame that never reaches document_idle (a wedged ad/embed) or a tab
      // behind a JS dialog would otherwise never answer and stall the loop until the hub timeout.
      while (Date.now() < deadline) {
        const sliceEnd = Math.min(deadline, Date.now() + 1_500);
        const ids = await frameList(tab);
        const probe = (frameId: number) =>
          withTimeout(
            chrome.scripting.executeScript({
              target: { tabId: tab.id!, frameIds: [frameId] },
              func: bbWaitProbe as any,
              args: clean([spec, sliceEnd]),
            }),
            frameId === 0 ? Math.max(INJECT_TOP_MS, sliceEnd - Date.now() + 1_000) : sliceEnd - Date.now() + 1_000,
            () => tabTimeoutMsg(tab.id, INJECT_TOP_MS, "wait_for")
          )
            .then((r) => ({ frameId, v: r?.[0]?.result as any }))
            .catch((e) => {
              if (frameId === 0) {
                if (isTimeout(e)) throw e; // the top frame not answering at all is a hung tab, not "not yet"
                lastErr = e instanceof Error ? e.message : String(e);
              } else if (isTimeout(e)) skippedFrames.add(frameId);
              return { frameId, v: null as any };
            });
        if (positive) {
          // First frame that satisfies wins; otherwise wait for every probe's slice to end.
          const hit = await new Promise<{ frameId: number; v: any } | null>((resolve, reject) => {
            let pending = ids.length;
            if (!pending) resolve(null);
            for (const id of ids) {
              probe(id).then(
                (r) => {
                  if (r.v && typeof r.v.error === "string") lastErr = r.v.error;
                  if (r.v?.satisfied) resolve(r);
                  if (--pending === 0) resolve(null);
                },
                reject // top frame timed out: surface the actionable hung-tab error
              );
            }
          });
          if (hit) {
            const out: any = { found: true, state, elapsedMs: Date.now() - started, matchCount: hit.v.count };
            if (skippedFrames.size) out.skippedFrames = [...skippedFrames];
            if (hit.frameId !== 0) out.frameId = hit.frameId;
            if (hit.v.tag) out.tag = hit.v.tag;
            if (hit.v.name) out.name = hit.v.name;
            if (hit.v.ref != null) out.ref = hit.v.ref;
            if (params.selector) out.selector = params.selector;
            return out;
          }
        } else {
          // hidden/detached must hold in EVERY frame that answered (and the top frame must answer).
          const rs = await Promise.all(ids.map(probe));
          const answered = rs.filter((r) => r.v && typeof r.v === "object" && typeof r.v.error !== "string");
          for (const r of rs) if (r.v && typeof r.v.error === "string") lastErr = r.v.error;
          if (answered.some((r) => r.frameId === 0) && answered.every((r) => r.v.satisfied)) {
            const out: any = { found: true, state, elapsedMs: Date.now() - started };
            if (skippedFrames.size) out.skippedFrames = [...skippedFrames];
            return out;
          }
        }
        if (Date.now() < deadline) await sleep(50);
      }
      const skippedNote = skippedFrames.size ? `; ${skippedFrames.size} child frame(s) did not respond and were not checked` : "";
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what} to be ${state}` + (lastErr ? ` (last probe error: ${lastErr})` : "") + skippedNote);
    }

    case "download_resource": {
      const opts: chrome.downloads.DownloadOptions = {
        url: params.url,
        conflictAction: "uniquify",
        saveAs: false,
      };
      if (params.filename) opts.filename = params.filename;
      if (params.headers) {
        opts.headers = Object.entries(params.headers as Record<string, string>).map(([name, value]) => ({
          name,
          value: String(value),
        }));
      }
      const downloadId = await chrome.downloads.download(opts);
      return { downloadId };
    }

    case "download_status": {
      const [item] = await chrome.downloads.search({ id: params.downloadId });
      if (!item) throw new Error(`Unknown downloadId ${params.downloadId}`);
      return {
        downloadId: params.downloadId,
        state: item.state,
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
        fileSize: item.fileSize,
        filename: item.filename,
        mime: item.mime,
        error: item.error,
        exists: item.exists,
        // A dangerous-file verdict or a pause holds a download indefinitely; the server fails fast on them.
        danger: item.danger,
        paused: item.paused,
        canResume: item.canResume,
      };
    }

    case "download_cancel": {
      await chrome.downloads.cancel(params.downloadId);
      return { cancelled: true, downloadId: params.downloadId };
    }

    // ---- intercept (live request/response tampering via CDP Fetch) ----
    case "intercept_start": {
      const tab = await targetTab(params.tabId);
      const s = await ensureAttached(tab.id!);
      const patterns = params.patterns ?? defaultFetchPatterns(params.stage);
      s.interceptRules = Array.isArray(params.rules) ? params.rules : [];
      // A second intercept_start must not just forget requests the previous one is holding: the page's
      // fetches would hang forever. Release them unmodified first (as intercept_stop does).
      const released = await releasePaused(tab.id!, s);
      await cmd(tab.id!, "Fetch.enable", { patterns });
      s.interceptOn = true;
      const out: any = { intercepting: true, tabId: tab.id!, patterns, rules: s.interceptRules.length };
      if (released) out.releasedPaused = released;
      return out;
    }

    case "intercept_pending": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s || !s.interceptOn) return { intercepting: false, count: 0, pending: [] };
      const pending: any[] = [];
      for (const e of s.paused.values()) {
        const row: any = {
          requestId: e.requestId,
          url: e.url,
          method: e.method,
          stage: e.stage,
          resourceType: e.resourceType,
          responseStatusCode: e.responseStatusCode,
          headers: e.headers,
          postData: e.postData != null ? String(e.postData).slice(0, BODY_CAP) : undefined,
        };
        if (params.withBodies && e.stage === "Response") {
          try {
            const r = await cmd(tab.id!, "Fetch.getResponseBody", { requestId: e.requestId });
            row.body = r?.base64Encoded ? b64DecodeUtf8(r.body).slice(0, BODY_CAP) : String(r?.body ?? "").slice(0, BODY_CAP);
          } catch (err) {
            row.bodyError = err instanceof Error ? err.message : String(err);
          }
        }
        pending.push(row);
      }
      return { intercepting: true, count: pending.length, pending };
    }

    case "intercept_resolve": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s || !s.interceptOn) throw new Error("Interception is not active on this tab - call intercept_start first");
      const ids: string[] = params.requestId ? [params.requestId] : params.all ? [...s.paused.keys()] : [];
      if (!ids.length) throw new Error("Provide a requestId (from intercept_pending), or all:true to release everything");
      const done: any[] = [];
      for (const id of ids) {
        const e = s.paused.get(id);
        if (!e) {
          done.push({ requestId: id, error: "not paused (already resolved?)" });
          continue;
        }
        s.paused.delete(id);
        try {
          done.push(await resolvePaused(tab.id!, e, params.action || "continue", params.set, params.response));
        } catch (err) {
          done.push({ requestId: id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { resolved: done };
    }

    case "intercept_stop": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (s) {
        s.interceptOn = false;
        s.interceptRules = [];
        await releasePaused(tab.id!, s);
        try {
          await cmd(tab.id!, "Fetch.disable");
        } catch {
          /* not enabled */
        }
      }
      return { intercepting: false, tabId: tab.id! };
    }

    // ---- fuzz (intruder) ----
    case "fuzz": {
      const tab = await targetTab(params.tabId);
      return doFuzz(tab, params);
    }

    // ---- cookies (chrome.cookies - real flags incl. HttpOnly) ----
    case "cookies_get": {
      const query: chrome.cookies.GetAllDetails = {};
      if (params.url) query.url = params.url;
      if (params.domain) query.domain = params.domain;
      if (params.name) query.name = params.name;
      const cookies = await chrome.cookies.getAll(query);
      return { count: cookies.length, cookies };
    }

    case "cookies_set": {
      if (!params.url || !params.name) throw new Error("cookies_set requires url and name");
      const details: chrome.cookies.SetDetails = { url: params.url, name: params.name, value: params.value ?? "" };
      if (params.domain) details.domain = params.domain;
      if (params.path) details.path = params.path;
      if (params.secure !== undefined) details.secure = params.secure;
      if (params.httpOnly !== undefined) details.httpOnly = params.httpOnly;
      if (params.sameSite) details.sameSite = params.sameSite;
      if (params.expirationDate !== undefined) details.expirationDate = params.expirationDate;
      const cookie = await chrome.cookies.set(details);
      return { set: !!cookie, cookie };
    }

    case "cookies_delete": {
      if (!params.url || !params.name) throw new Error("cookies_delete requires url and name");
      const r = await chrome.cookies.remove({ url: params.url, name: params.name });
      return { deleted: !!r, details: r };
    }

    // ---- web storage (localStorage / sessionStorage) ----
    case "storage_dump": {
      const tab = await targetTab(params.tabId);
      return inject(tab, bbStorage, ["dump", null, null, null, params.kinds ?? null]);
    }

    case "storage_set": {
      const tab = await targetTab(params.tabId);
      if (!params.key) throw new Error("storage_set requires key");
      return inject(tab, bbStorage, ["set", params.area ?? "local", params.key, params.value ?? "", null]);
    }

    case "storage_remove": {
      const tab = await targetTab(params.tabId);
      if (!params.key) throw new Error("storage_remove requires key");
      return inject(tab, bbStorage, ["remove", params.area ?? "local", params.key, null, null]);
    }

    case "storage_clear": {
      const tab = await targetTab(params.tabId);
      return inject(tab, bbStorage, ["clear", params.area ?? "local", null, null, null]);
    }

    // ---- console/log capture ----
    case "console_start": {
      const tab = await targetTab(params.tabId);
      const s = await ensureAttached(tab.id!);
      s.logs = [];
      s.logOn = true;
      await cmd(tab.id!, "Runtime.enable");
      await cmd(tab.id!, "Log.enable");
      return { capturing: true, tabId: tab.id! };
    }

    case "console_get": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s) return { capturing: false, total: 0, logs: [] };
      let logs = s.logs;
      if (params.level) logs = logs.filter((l) => l.level === params.level);
      if (params.pattern) {
        const re = new RegExp(params.pattern, "i");
        logs = logs.filter((l) => re.test(l.text));
      }
      const limit = params.limit ?? 200;
      return { capturing: s.logOn, total: logs.length, logs: logs.slice(-limit) };
    }

    case "console_stop": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (s) {
        s.logOn = false;
        try {
          await cmd(tab.id!, "Log.disable");
        } catch {
          /* not enabled */
        }
      }
      return { capturing: false, tabId: tab.id! };
    }

    // ---- save_page (MHTML single-file evidence snapshot) ----
    case "save_page": {
      const tab = await targetTab(params.tabId);
      await ensureAttached(tab.id!);
      const r = await cmd(tab.id!, "Page.captureSnapshot", { format: "mhtml" });
      return { mhtml: r?.data ?? "", url: tab.url, title: tab.title };
    }

    case "fetch_resources":
      return fetchResources(params);

    // ---- session recording (rrweb → HTML replay); banner-free, scripting only ----
    case "session_record_start": {
      const tab = await targetTab(params.tabId);
      assertScriptable(tab);
      const tabId = tab.id!;
      const rec: RecState = {
        queue: [],
        timer: null,
        allFrames: !!params.allFrames,
        maskInputs: !!params.maskInputs,
        recordCanvas: !!params.recordCanvas,
        canvasFps: params.canvasFps,
        canvasQuality: params.canvasQuality,
        canvasMaxDim: params.canvasMaxDim,
        canvasBudgetBytes: params.canvasBudgetBytes,
      };
      // Register BEFORE injecting: with allFrames the inject can take seconds, and the top frame's
      // first batch (Meta + FullSnapshot) arrives via sendMessage/bb-rec meanwhile - if the state
      // isn't there yet that base snapshot is dropped and the replay has nothing to build from.
      sessionRecordings.set(tabId, rec);
      let injected = false;
      try {
        injected = await injectRecorder(tabId, rec);
      } catch (e) {
        sessionRecordings.delete(tabId);
        throw e;
      }
      if (!injected) {
        sessionRecordings.delete(tabId); // top-frame injection failed - don't strand a dead state
        throw new Error("could not inject the session recorder into the top frame");
      }
      void persistRecordings(); // survive an SW eviction; the page recorder keeps posting bb-rec
      return { recording: true, tabId, allFrames: rec.allFrames, url: tab.url };
    }

    case "session_record_stop": {
      const tab = await targetTab(params.tabId);
      const tabId = tab.id!;
      const rec = sessionRecordings.get(tabId);
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: rec?.allFrames ?? false },
          func: () => (window as any).__bbRec?.stop(),
        });
      } catch {
        /* tab navigated/closed - the final flush below still ships buffered events */
      }
      // The recorder's final batch is relayed via sendMessage (a separate task) - let it reach
      // onMessage/queueRecord before we flush the `done` marker, or the last events are lost.
      await sleep(200);
      if (rec) {
        flushRecord(rec, tabId, true);
        sessionRecordings.delete(tabId);
        void persistRecordings();
      }
      return { stopped: true, tabId, wasRecording: !!rec };
    }

    // Ground truth for session_record_status. The server can answer from its own sink bookkeeping,
    // but that happily reports a recording that is dead in the browser (e.g. after an SW eviction).
    case "session_record_status": {
      const out: any[] = [];
      for (const [tabId, rec] of sessionRecordings) {
        let alive: boolean | null = null;
        let url: string | undefined;
        try {
          const tab = await chrome.tabs.get(tabId);
          url = tab.url;
          const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => !!(window as any).__bbRec?.recording,
          });
          alive = !!res?.result;
        } catch {
          alive = null; // tab gone or not scriptable
        }
        out.push({ tabId, url, allFrames: rec.allFrames, queued: rec.queue.length, recorderAlive: alive });
      }
      return { recordings: out };
    }

    // ---- watch mode ----
    case "watch_start": {
      await ready();
      const tab = await targetTab(params.tabId);
      assertScriptable(tab);
      const tabId = tab.id!;
      const existing = watchForTab(tabId);
      if (existing) {
        // Re-arm on resume. Returning early without injecting means a tab whose listener went dormant
        // (extension reloaded, or the page loaded before this group existed) stays dormant forever,
        // and watch_start reports success while capturing nothing.
        await injectWatchNow(tabId, existing.consoleMode);
        return {
          watching: true,
          watchId: existing.watchId,
          tabId,
          url: tab.url,
          resumed: true,
          inject: lastInject.get(tabId),
        };
      }

      const watchId = `w${Date.now().toString(36)}`;
      const group: WatchGroup = {
        watchId,
        rootTabId: tabId,
        consoleMode: params.console === "calls" ? "calls" : params.console === false ? "off" : "passive",
        startedAt: Date.now(),
        tabs: new Map([[tabId, { tabId, addedAt: Date.now() }]]),
      };
      watchGroups.set(watchId, group);
      tabToWatch.set(tabId, watchId);
      await registerWatchScripts(group.consoleMode !== "off");
      await injectWatchNow(tabId, group.consoleMode);
      await persistWatch();
      return { watching: true, watchId, tabId, url: tab.url, inject: lastInject.get(tabId) };
    }

    case "watch_stop": {
      await ready();
      // Stop ONLY the named watch. Falling back to ALL groups when a watchId is absent is what made
      // stopping one watch kill the others. tabIds is the back-compat path: derive the owning groups
      // from the tabs rather than stopping everything.
      let ids: string[];
      if (params.watchId) ids = [params.watchId];
      else if (Array.isArray(params.tabIds) && params.tabIds.length)
        ids = [...new Set(params.tabIds.map((t: number) => tabToWatch.get(t)).filter(Boolean) as string[])];
      else ids = [...watchGroups.keys()];
      const stopped: string[] = [];
      for (const id of ids) {
        const g = watchGroups.get(id);
        if (!g) continue;
        for (const tabId of g.tabs.keys()) {
          tabToWatch.delete(tabId);
          // Tell any live page to stop buffering. Best-effort: a closed tab needs no telling.
          chrome.scripting
            .executeScript({ target: { tabId, allFrames: true }, func: () => (window as any).__bbWatch?.arm(false) })
            .catch(() => undefined);
        }
        watchGroups.delete(id);
        stopped.push(id);
      }
      if (!watchGroups.size) await unregisterWatchScripts();
      await persistWatch();
      return { stopped, remaining: watchGroups.size };
    }

    case "watch_status": {
      await ready();
      const groups: any[] = [];
      for (const g of watchGroups.values()) {
        const tabs: any[] = [];
        for (const tabId of g.tabs.keys()) {
          let armed: any = null;
          let url: string | undefined;
          let title: string | undefined;
          try {
            const tab = await chrome.tabs.get(tabId);
            url = tab.url;
            title = tab.title;
            const [res] = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => (window as any).__bbWatch?.status?.() ?? null,
            });
            armed = res?.result ?? null;
          } catch {
            armed = null; // gone, or a page content scripts cannot run on
          }
          tabs.push({
            tabId,
            url,
            title,
            listener: armed,
            unscriptable: url ? RESTRICTED.test(url) : undefined,
            inject: lastInject.get(tabId),
          });
        }
        groups.push({ watchId: g.watchId, rootTabId: g.rootTabId, consoleMode: g.consoleMode, startedAt: g.startedAt, tabs });
      }
      let registered: string[] = [];
      try {
        registered = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);
      } catch {
        /* ignore */
      }
      return {
        groups,
        registeredScripts: registered,
        sw: { startedAt: swStartedAt, uptimeMs: Date.now() - swStartedAt },
        outbox: { envelopes: outbox.length, bytes: outboxBytes, dropped: outboxDropped },
        wsConnected: !!ws && ws.readyState === WebSocket.OPEN,
      };
    }

    case "ax_snapshot": {
      const tab = await targetTab(params.tabId);
      return axSnapshot(tab, params);
    }

    // ---- environment emulation (CDP; shows the debugger banner). Thin: the server resolved presets
    //      to concrete metrics/throughput, this just applies them. See extension/src/emulate.ts. ----

    case "emulate_device": {
      const tab = await targetTab(params.tabId);
      await ensureAttached(tab.id!);
      return emulateDevice(tab.id!, params, cmd);
    }

    case "emulate_network": {
      const tab = await targetTab(params.tabId);
      await ensureAttached(tab.id!);
      return emulateNetwork(tab.id!, params, cmd);
    }

    case "emulate_cpu": {
      const tab = await targetTab(params.tabId);
      await ensureAttached(tab.id!);
      return emulateCpu(tab.id!, params.rate, cmd);
    }

    case "emulate_locale": {
      const tab = await targetTab(params.tabId);
      await ensureAttached(tab.id!);
      return emulateLocale(tab.id!, params, cmd);
    }

    case "emulate_geolocation": {
      const tab = await targetTab(params.tabId);
      await ensureAttached(tab.id!);
      return emulateGeolocation(tab.id!, params, cmd);
    }

    case "emulate_reset": {
      const tab = await targetTab(params.tabId);
      await ensureAttached(tab.id!);
      return emulateReset(tab.id!, cmd);
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("bb-keepalive", { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("bb-keepalive", { periodInMinutes: 0.5 });
  connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bb-keepalive") {
    connect(); // no-op when already connected; revives after SW restarts
    idleSweep(); // detach debugger sessions idle past the timeout (removes the banner)
  }
});

// Debugger listeners must be registered synchronously at top level (MV3).
chrome.debugger.onEvent.addListener(onDebuggerEvent);
// The `reason` argument was previously discarded, so a user dismissing the "being debugged" banner
// killed the capture silently - the next net_get_requests just threw "Not capturing". Now it is
// recorded and surfaced through debugger_status / watch_status.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  lastDetach.set(source.tabId, { reason: String(reason ?? "unknown"), at: Date.now() });
  finalizeCapture(source.tabId); // flush + close the sink (user closed banner / DevTools opened / tab gone)
  sessions.delete(source.tabId);
  forgetEmulation(source.tabId);
  keepAlives.delete(source.tabId); // focus emulation died with the session; holders release a stale entry harmlessly
  pendingDialogs.delete(source.tabId);
});
// A committed top-frame navigation means any dialog the old document showed is gone.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) pendingDialogs.delete(d.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  pendingDialogs.delete(tabId);
  finalizeCapture(tabId);
  sessions.delete(tabId);
  forgetEmulation(tabId);
  keepAlives.delete(tabId);
  const rec = sessionRecordings.get(tabId);
  if (rec) {
    sessionRecordings.delete(tabId);
    void persistRecordings();
    // The recorder's final batch is relayed via sendMessage, a separate task. Closing the sink
    // immediately (as this did) discards it. session_record_stop already allows this grace; a tab
    // being closed is exactly when the last events matter most.
    setTimeout(() => flushRecord(rec, tabId, true), 300);
  }
  const g = watchForTab(tabId);
  if (g) {
    g.tabs.delete(tabId);
    tabToWatch.delete(tabId);
    // queue:true - SW-only event; hold it in the outbox across a socket blip (see addTabToGroup).
    shipOrQueue({ type: "watch", watchId: g.watchId, tabId, entries: [{ t: Date.now(), k: "closed" }] }, true);
    // An emptied group is dead; drop it, and when the LAST watch goes, unregister the <all_urls>
    // content script so it stops injecting into every page (mirrors hydrate() and watch_stop).
    if (!g.tabs.size) watchGroups.delete(g.watchId);
    if (!watchGroups.size) void unregisterWatchScripts();
    void persistWatch();
  }
});

// ---- watch mode: follow the human across tabs ----
// A link opened in a new tab is a new tabId with zero state. Without this, watch mode keeps
// confidently describing the OLD tab while the human works in the new one - silently wrong, which is
// worse than not covering it at all. openerTabId covers target=_blank, middle-click, "open in new
// tab" and window.open; onCreatedNavigationTarget covers the rel=noopener cases where it is absent.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null || tab.openerTabId == null) return;
  void ready().then(() => {
    const g = watchForTab(tab.openerTabId!);
    if (g) addTabToGroup(g, tab.id!, tab.openerTabId);
  });
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  void ready().then(() => {
    const g = watchForTab(d.sourceTabId);
    if (g) addTabToGroup(g, d.tabId, d.sourceTabId);
  });
});
// Prerender activation and some back/forward navigations swap the tabId. Without this the tab
// silently drops out of the group mid-session.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // A session recording is scripting-based and injected in the page, which survives the tabId swap, so
  // move it to the new id - its bb-rec messages now arrive as the new tab. A debugger session can't
  // follow the tabId (the CDP attach was to the old target), so clean it up rather than strand it.
  const rec = sessionRecordings.get(removedTabId);
  if (rec) {
    sessionRecordings.delete(removedTabId);
    sessionRecordings.set(addedTabId, rec);
    void persistRecordings();
  }
  if (sessions.has(removedTabId)) void detachSession(removedTabId).catch(() => {});
  void ready().then(() => {
    const g = watchForTab(removedTabId);
    if (!g) return;
    const old = g.tabs.get(removedTabId);
    g.tabs.delete(removedTabId);
    tabToWatch.delete(removedTabId);
    g.tabs.set(addedTabId, { tabId: addedTabId, openerTabId: old?.openerTabId, addedAt: Date.now() });
    tabToWatch.set(addedTabId, g.watchId);
    void persistWatch();
    // Tell the server, or its timeline keeps binding the dead tab id and drops the new tab's net rows
    // (which arrive keyed only by tabId). The `opened` event binds addedTabId server-side.
    shipOrQueue({ type: "watch", watchId: g.watchId, tabId: addedTabId, entries: [{ t: Date.now(), k: "opened" }] }, true);
  });
});
// Which tab the human is actually looking at - the difference between "activity across 6 tabs" and
// "they are on the checkout page". Nearly free, and it also marks unscriptable pages as blind rather
// than letting them look like idleness.
chrome.tabs.onActivated.addListener((info) => {
  void ready().then(async () => {
    const g = watchForTab(info.tabId);
    if (!g) return;
    let url = "";
    try {
      url = (await chrome.tabs.get(info.tabId)).url ?? "";
    } catch {
      /* gone */
    }
    shipOrQueue(
      { type: "watch", watchId: g.watchId, tabId: info.tabId, entries: [{ t: Date.now(), k: "visible", url }] },
      true // SW-only event - hold it across a socket blip (see addTabToGroup)
    );
  });
});
// (The MAIN-world shim for a fresh document is injected from the bb-watch-hello handshake, paired
// with the secret that document's isolated watcher chose - see injectWatchMain.)
// SPA route changes seen from the browser side, belt-and-braces with the page's own history patch.
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  void ready().then(() => {
    const g = watchForTab(d.tabId);
    if (!g) return;
    shipOrQueue(
      { type: "watch", watchId: g.watchId, tabId: d.tabId, entries: [{ t: Date.now(), k: "nav", url: d.url, via: "hint" }] },
      true // SW-only event - hold it across a socket blip (see addTabToGroup)
    );
  });
});
chrome.downloads.onDeterminingFilename.addListener((_item, suggest) => {
  suggest(); // accept Chrome's tentative filename; avoids an interactive save-location prompt
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port)) {
    ws?.close();
    pendingWs?.close();
    reconnectDelay = 1_000;
    replacedUntil = 0;
    connect();
  }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.cmd === "reconnect") {
    ws?.close();
    pendingWs?.close();
    reconnectDelay = 1_000;
    replacedUntil = 0;
    connect();
    sendResponse({ ok: true });
    return false;
  }
  // rrweb event batches relayed from an injected recorder → stream to the session sink.
  if (msg?.cmd === "bb-rec") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      // await hydration: a bb-rec message can be what WOKE the worker after an eviction, arriving
      // before restoreRecordings() has repopulated the map. Without this the first post-respawn batch
      // would find no rec and be dropped.
      void ready().then(() => {
        const rec = sessionRecordings.get(tabId);
        if (rec) queueRecord(rec, tabId, msg.events || []);
      });
    }
    return false;
  }

  // ---- watch mode: the content script asking whether this tab is in scope ----
  if (msg?.cmd === "bb-watch-hello") {
    const tabId = sender.tab?.id;
    void ready().then(() => {
      const g = tabId != null ? watchForTab(tabId) : undefined;
      if (g && g.consoleMode !== "off" && tabId != null && sender.frameId != null && typeof msg.mainNonce === "string" && !msg.mainPaired) {
        void injectWatchMain(tabId, [{ frameId: sender.frameId, nonce: msg.mainNonce }], g.consoleMode).then((main) => {
          if (sender.frameId === 0) lastInject.set(tabId, { isolated: "ok", main, at: Date.now() });
        });
      }
      sendResponse({ ok: true, armed: !!g, watchId: g?.watchId, consoleMode: g?.consoleMode });
    });
    return true; // async: hydration may still be in flight right after an SW restart
  }

  // ---- watch mode: a batch of labeled page events ----
  // The reply is the ACK the page waits for before dropping its own copy. Answering "not shipped"
  // (rather than staying silent) is what keeps custody in the page while the socket is down.
  if (msg?.cmd === "bb-watch") {
    const tabId = sender.tab?.id;
    void ready().then(() => {
      const g = tabId != null ? watchForTab(tabId) : undefined;
      if (!g) return sendResponse({ ok: true, shipped: false, armed: false });
      const shipped = shipOrQueue(
        {
          type: "watch",
          watchId: g.watchId,
          tabId,
          frameId: sender.frameId,
          entries: msg.events || [],
          dropped: msg.dropped || 0,
        },
        // Normally the page keeps custody until this returns true. But a pagehide flush (final:true)
        // comes from a dying document that will NOT retry, so hold it in the outbox instead of losing
        // it when the socket is down; per-event ids let the server drop any duplicate.
        msg.final === true
      );
      sendResponse({ ok: true, shipped, armed: true });
    });
    return true;
  }
  return false;
});

// Re-inject the recorder after a full document load while recording (a navigation destroys the
// injected recorder; rrweb takes a fresh full snapshot and the replay stitches the segments).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  const rec = sessionRecordings.get(tabId);
  if (!rec) return;
  void injectRecorder(tabId, rec).catch(() => {
    /* not scriptable / gone */
  });
});

connect();
