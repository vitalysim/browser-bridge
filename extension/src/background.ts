/// <reference types="chrome" />

import { NetRing, applyRedirectResponse, capBody, Semaphore, type NetEntry } from "./net-capture.js";
// Self-contained injected page helpers, kept in their own files so the two hot files stay small:
// bbAct is the ONE find-and-act helper the interaction tools share; bbAxSnapshot is the ARIA walker.
import { bbAct, type BbActParams } from "./dom-act";
import { bbAxSnapshot } from "./ax";
import { emulateDevice, emulateNetwork, emulateCpu, emulateLocale, emulateGeolocation, emulateReset } from "./emulate.js";

// Injected at build time by build.mjs (esbuild define) from extension/package.json - single
// source of truth shared with manifest.json, so the version can't drift.
declare const __BB_VERSION__: string;
declare const __BB_BUILD__: string;
const VERSION = __BB_VERSION__;
const BUILD_AT = __BB_BUILD__;
const PING_INTERVAL_MS = 20_000; // WS traffic resets the MV3 service-worker idle timer (Chrome 116+)
const RECONNECT_MAX_MS = 30_000;

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

async function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  try {
    await connectNow();
  } finally {
    connecting = false;
  }
}

async function connectNow() {
  const { token, port } = await chrome.storage.local.get({ token: "", port: 8765 });
  if (!token) {
    setStatus("no-token", "Set the server token in the extension options.");
    return;
  }
  setStatus("connecting");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  ws = socket;

  socket.onopen = async () => {
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
      })
    );
    pumpOutbox(); // whatever was held while the socket was down
    void markAlive();
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL_MS);
  };

  socket.onmessage = async (event) => {
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "pong") return;
    if (!msg.id || !msg.method) return;
    let reply: any;
    try {
      const result = await dispatch(msg.method, msg.params ?? {});
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
    replyOrQueue(socket, json, reply);
  };

  socket.onclose = () => {
    if (ws !== socket) return; // a superseded/replaced socket closing must not disturb the live one
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    ws = null;
    setStatus("disconnected", "Will retry automatically.");
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose fires next; nothing to do here (and a superseded socket must never touch globals)
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

// Send a dispatch reply on the socket it arrived on, or - when that socket is no longer OPEN
// (superseded by a reconnect, or closing) - hand it to the outbox instead of calling send() on a dead
// socket. A reply the server no longer awaits is ignored by id, so routing a late one is harmless.
// `json` is the already-serialized reply (sent as-is); `obj` is the same value for the outbox path.
function replyOrQueue(socket: WebSocket, json: string, obj: any): void {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(json);
      return;
    } catch {
      /* fall through to the outbox */
    }
  }
  shipOrQueue(obj);
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
  // The MAIN-world shim is NOT registered here: it is injected per-document as an inline function
  // (see bbWatchMainShim), which is why watched tabs re-inject it on every commit.
  void withConsole;
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

/**
 * MAIN-world page-error shim, injected as an INLINE FUNCTION rather than a file.
 *
 * It has to run in the page's own JS world: an isolated-world listener does not receive page script
 * errors (verified - CDP saw an uncaught throw, a rejection and a console.error while an isolated
 * listener saw none). But injecting a FILE into the MAIN world proved unreliable here even with
 * web_accessible_resources set, so this is passed as `func`, which needs no web-accessible resource,
 * no second bundle and no runtime handshake to carry the mode.
 *
 * Must be fully self-contained: it is serialized and evaluated in the page.
 *
 * PASSIVE (always): error / unhandledrejection listeners observe an error AFTER it has unwound, so
 * they add no frame to the page's own stack traces.
 * WRAPPING (mode === "calls" only): replacing console.error/warn DOES sit in the page's call path and
 * puts this extension in the page's stack traces - observed on a real target whose error reporter
 * shipped our filename. Opt-in by name for that reason.
 */
function bbWatchMainShim(mode: string) {
  const w = window as any;
  const relay = (obj: any) => {
    try {
      window.dispatchEvent(new CustomEvent("bb-watch-main", { detail: JSON.stringify(obj) }));
    } catch {
      /* unserializable - drop rather than throw inside the page */
    }
  };
  const fmt = (args: any[]): string =>
    args
      .map((a: any) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ")
      .slice(0, 500);
  const wrapConsole = () => {
    if (w.__bbWatchWrapped) return;
    w.__bbWatchWrapped = 1;
    for (const level of ["error", "warn"]) {
      const orig = (console as any)[level]?.bind(console);
      if (!orig) continue;
      (console as any)[level] = (...args: any[]) => {
        try {
          relay({ kind: "console", level, text: fmt(args) });
        } catch {
          /* never break the page's own logging */
        }
        return orig(...args);
      };
    }
  };
  // SPA route changes are only observable from the MAIN world: history.pushState/replaceState run in
  // the page's own JS and fire no event an isolated listener can see (popstate/hashchange are the
  // only ones that reach the isolated world, and pushState is neither). Patch them here and relay to
  // the isolated watcher, which emits them as via:"spa" navigations. `replace` is carried through so
  // the fold can leave a search-as-you-type burst intact instead of splitting it per keystroke.
  const patchHistory = () => {
    if (w.__bbWatchHist) return;
    w.__bbWatchHist = 1;
    for (const m of ["pushState", "replaceState"] as const) {
      const orig = (history as any)[m];
      if (typeof orig !== "function") continue;
      (history as any)[m] = function (this: History, ...args: any[]) {
        const r = orig.apply(this, args);
        try {
          relay({ kind: "nav", replace: m === "replaceState" });
        } catch {
          /* never break the page's navigation */
        }
        return r;
      };
    }
  };
  if (w.__bbWatchMain) {
    patchHistory();
    if (mode === "calls") wrapConsole();
    return true;
  }
  window.addEventListener("error", (e: any) => {
    relay({ kind: "console", level: "error", text: String(e.message ?? "").slice(0, 500), src: e.filename, line: e.lineno });
  });
  window.addEventListener("unhandledrejection", (e: any) => {
    relay({ kind: "console", level: "error", text: "Unhandled rejection: " + fmt([e?.reason]) });
  });
  patchHistory();
  if (mode === "calls") wrapConsole();
  w.__bbWatchMain = 1;
  return true;
}

async function injectWatchNow(tabId: number, consoleMode: "off" | "passive" | "calls"): Promise<void> {
  const jobs: Promise<unknown>[] = [
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["vendor/bb-watch.js"] }),
  ];
  if (consoleMode !== "off") {
    jobs.push(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: bbWatchMainShim,
        args: [consoleMode],
        world: "MAIN",
      } as chrome.scripting.ScriptInjection<any, any>)
    );
  }
  // Report what failed rather than swallowing it. A silently-failed injection looks exactly like a
  // quiet user, which is the failure mode this whole feature is built to avoid.
  const [isolated, main] = await Promise.all(
    jobs.map((p) => p.then(() => "ok").catch((e) => String(e?.message ?? e).slice(0, 200)))
  );
  lastInject.set(tabId, { isolated, main: consoleMode === "off" ? "skipped" : main ?? "ok", at: Date.now() });
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

async function inject<T>(tab: chrome.tabs.Tab, func: (...args: any[]) => T, args: any[] = [], world: "ISOLATED" | "MAIN" = "ISOLATED"): Promise<T> {
  assertScriptable(tab);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    world,
    func: func as any,
    args: clean(args),
  });
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
async function injectAllFrames(
  tab: chrome.tabs.Tab,
  func: (...args: any[]) => any,
  args: any[] = [],
  world: "ISOLATED" | "MAIN" = "ISOLATED"
): Promise<chrome.scripting.InjectionResult[]> {
  assertScriptable(tab);
  return chrome.scripting.executeScript({
    target: { tabId: tab.id!, allFrames: true },
    world,
    func: func as any,
    args: clean(args),
  });
}

// Run an element-interaction func in every frame; exactly the frame that owns the element acts.
// Frames without the element return { notFound: true }; a real failure returns { error }.
async function injectAllAggregate(tab: chrome.tabs.Tab, func: (...args: any[]) => any, args: any[] = []): Promise<any> {
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
async function actAllFrames(tab: chrome.tabs.Tab, args: any[]): Promise<{ result: any; frameId: number | null }> {
  const results = await injectAllFrames(tab, bbAct, args);
  let acted: any = null;
  let ownerFrame: number | null = null;
  let stale = false;
  for (const r of results) {
    const v: any = r?.result;
    if (!v || typeof v !== "object") continue;
    if (typeof v.error === "string") throw new Error(v.error);
    if (v.staleRef) { stale = true; continue; }
    if (v.notFound) continue;
    acted = v;
    ownerFrame = r.frameId; // this frame owns the element (result may be notActionable)
  }
  if (acted) return { result: acted, frameId: ownerFrame };
  return { result: stale ? { staleRef: true } : { notFound: true }, frameId: null };
}

// A retry once the owning frame is known: run bbAct in just that one frame.
async function actInFrame(tab: chrome.tabs.Tab, frameId: number, args: any[]): Promise<any> {
  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id!, frameIds: [frameId] },
    world: "ISOLATED",
    func: bbAct as any,
    args: clean(args),
  });
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

function bbSnapshot(refOffset: number) {
  const SEL =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
  const items: any[] = [];
  // Fresh ref registry each snapshot: ref (number) -> Element, kept on the frame's ISOLATED-world
  // global so a later click/fill/hover/type injection (same world) resolves the ref WITHOUT mutating
  // the page DOM. Reassign a new Map (never merge) so detached nodes from prior snapshots don't leak.
  // INVARIANT: every ref locator must inject in the ISOLATED world - a MAIN-world locator sees a
  // different `window` and would miss this registry.
  const bbRefs: Map<number, Element> = ((window as any).__bbRefs = new Map());
  let n = 0;
  // Single fused pass: match-and-emit during the walk instead of materializing EVERY element in the
  // document into an array and re-looping it. Emission order is identical - the old walk pushed a
  // host then immediately recursed into its shadow root, which is exactly this traversal order - and
  // the 400 cap now stops the walk itself rather than only the second loop, so a huge page no longer
  // traverses tens of thousands of nodes it will never emit. Same elements, same refs, less work.
  const walk = (root: Document | ShadowRoot) => {
    if (n >= 400) return;
    let els: NodeListOf<Element>;
    try {
      els = root.querySelectorAll("*");
    } catch {
      return;
    }
    for (const el of Array.from(els)) {
      if (n >= 400) return;
      const h = el as HTMLElement;
      let ok = false;
      try {
        ok = h.matches(SEL);
      } catch {
        ok = false;
      }
      if (ok && (!(h as any).checkVisibility || (h as any).checkVisibility())) emit(h);
      const sr = h.shadowRoot;
      if (sr) walk(sr);
    }
  };
  const emit = (h: HTMLElement) => {
    n++;
    const ref = refOffset + n;
    bbRefs.set(ref, h);
    const label = ((h.innerText ||
      (h as HTMLInputElement).value ||
      (h as HTMLInputElement).placeholder ||
      h.getAttribute("aria-label") ||
      h.getAttribute("title") ||
      "") as string)
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);
    const entry: any = { ref, tag: h.tagName.toLowerCase(), label };
    if (h.tagName === "A") entry.href = (h as HTMLAnchorElement).href.slice(0, 120);
    if (h.tagName === "INPUT") entry.type = (h as HTMLInputElement).type;
    const role = h.getAttribute("role");
    if (role) entry.role = role;
    // actionability hints (elements listed are already visible; add enabled + viewport position)
    const enabled = !(h as any).disabled && h.getAttribute("aria-disabled") !== "true";
    if (!enabled) entry.enabled = false;
    const r = h.getBoundingClientRect();
    entry.inViewport = r.bottom > 0 && r.right > 0 && r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
    items.push(entry);
  };
  walk(document);
  return { url: location.href, count: items.length, elements: items };
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
function waitForComplete(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void (async () => {
      await sleep(250); // grace: let a real cross-document nav flip to 'loading' before we poll
      while (!done && Date.now() < deadline) {
        let status: string | undefined;
        try {
          status = (await chrome.tabs.get(tabId)).status;
        } catch {
          return finish(); // tab closed/gone
        }
        if (status === "complete") return finish();
        await sleep(150);
      }
      finish(); // timeout ceiling - resolve anyway; caller can read a partial page
    })();
  });
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

async function throttleCapture(windowId: number): Promise<void> {
  const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - (lastCaptureAt.get(windowId) ?? 0));
  if (wait > 0) await sleep(wait);
  lastCaptureAt.set(windowId, Date.now());
}

// Back/forward via the page's own history - chrome.tabs.goBack/goForward fail spuriously
// ("Cannot find a next page in history") even when history exists. Polls for the URL change
// so bfcache (instant) restores don't wait on a load-complete event that never fires.
async function navByHistory(tab: chrome.tabs.Tab, direction: "back" | "forward"): Promise<any> {
  const before = (await chrome.tabs.get(tab.id!)).url;
  await inject(tab, (dir: string) => {
    if (dir === "back") history.back();
    else history.forward();
  }, [direction]);
  const deadline = Date.now() + 6_000;
  let navigated = false;
  // Check BEFORE sleeping: a bfcache restore is effectively instant, and sleeping first charged it a
  // flat 150ms it never needed.
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tab.id!);
    if (t.url && t.url !== before) {
      navigated = true;
      await sleep(300); // brief settle
      break;
    }
    await sleep(150);
  }
  const fresh = await chrome.tabs.get(tab.id!);
  return { tabId: fresh.id, title: fresh.title, url: fresh.url, navigated };
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

function cmd(tabId: number, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
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
    p = (async () => {
      await attach(tabId);
      // If an enable fails AFTER a successful attach, detach so we don't strand an orphaned debugger
      // (stuck "being debugged" banner + a leaked attach that nothing will ever clean up).
      try {
        await Promise.all([cmd(tabId, "DOM.enable"), cmd(tabId, "Page.enable")]);
      } catch (e) {
        await detachSession(tabId).catch(() => {});
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
  try {
    await new Promise<void>((resolve) => chrome.debugger.detach({ tabId }, () => resolve()));
  } catch {
    /* already gone */
  }
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
    if (s.netOn || s.interceptOn || s.logOn || s.paused.size > 0) continue;
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

  // Build request headers: preserve content-type/accept from the base, apply explicit overrides,
  // and drop headers fetch() forbids (Cookie/Host/Content-Length). Identity is handled via credentials.
  const headers: Record<string, string> = {};
  const bh = base.headers || {};
  const baseCT = bh["content-type"] ?? bh["Content-Type"];
  const baseAccept = bh["accept"] ?? bh["Accept"];
  if (baseCT && body != null) headers["content-type"] = baseCT;
  if (baseAccept) headers["accept"] = baseAccept;
  for (const [k, v] of Object.entries(ov.headers || {})) {
    if (!/^(cookie|host|content-length)$/i.test(k)) headers[k] = v as string;
  }

  // identity: current session (default) · anon (no cookies) · captured bearer
  let credentials: RequestCredentials = "include";
  let note: string | undefined;
  if (params.identity === "anon") {
    credentials = "omit";
  } else if (params.identity) {
    const id = identities.get(params.identity);
    if (!id) throw new Error(`identity '${params.identity}' not captured - call identity_capture first`);
    if (id.bearer) {
      headers["authorization"] = id.bearer;
      credentials = "omit";
    } else {
      note = `identity '${params.identity}' has no bearer; used the current tab session (cookie-jar swap not supported via background fetch)`;
    }
  }

  // viaAppClient: run through the PAGE'S OWN fetch (main world) so the app's CSRF tokens, auth
  // interceptors, and service worker apply. Practically same-origin (page CSP connect-src / CORS).
  if (params.viaAppClient) {
    const ta = Date.now();
    try {
      const res: any = await inject(
        tab,
        async (u: string, m: string, hh: Record<string, string>, b: string | null) => {
          try {
            const r = await fetch(u, { method: m, headers: hh, body: b ?? undefined, credentials: "include" });
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
        [url, method, headers, body ?? null],
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
    const r = await fetch(url, { method, headers, body: body ?? undefined, credentials });
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
    }), []);
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
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    clip = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, scale: clipScale };
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
  const loc = await inject(tab, bbAct, ["locate", { sel: params.selector ?? null, ref: params.ref ?? null }]);
  if (!loc || loc.notFound || loc.staleRef) throw new Error("Target not found (or since re-rendered) for trusted paste - take a fresh snapshot or check the selector.");
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

async function trustedAction(tabId: number, action: string, ref: number | null, selector: string | null, text?: string): Promise<any> {
  await ensureAttached(tabId);
  const nodeId = await cdpResolve(tabId, ref, selector);
  if (action === "type") {
    await cmd(tabId, "DOM.focus", { nodeId });
    for (const ch of Array.from(text ?? "")) {
      await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
      await cmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(15); // real inter-keystroke timing
    }
    return { typed: (text ?? "").length, trusted: true };
  }
  const { x, y } = await cdpCenter(tabId, nodeId);
  await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  if (action === "hover") return { hovered: true, trusted: true, x, y };
  if (action === "click") {
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await cmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { clicked: true, trusted: true, x, y };
  }
  throw new Error(`Unknown trusted action: ${action}`);
}

// ---- coordinate-level trusted input (CDP Input) — for canvas / remote-desktop / game targets ----
// Coords are CSS VIEWPORT pixels (top-left origin). Screenshots are device pixels, so map with the
// dpr the screenshot tool returns: inputCoord = screenshotPixel / dpr.
const CDP_MODS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, win: 4, shift: 8 };

// Resolve a key name ("Enter", "ArrowUp", "c", "F5") → { key, code, vk } for CDP Input.dispatchKeyEvent.
function keyInfo(name: string): { key: string; code: string; vk: number } {
  const named: Record<string, [string, string, number]> = {
    enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13],
    tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46],
    space: [" ", "Space", 32], spacebar: [" ", "Space", 32],
    up: ["ArrowUp", "ArrowUp", 38], arrowup: ["ArrowUp", "ArrowUp", 38],
    down: ["ArrowDown", "ArrowDown", 40], arrowdown: ["ArrowDown", "ArrowDown", 40],
    left: ["ArrowLeft", "ArrowLeft", 37], arrowleft: ["ArrowLeft", "ArrowLeft", 37],
    right: ["ArrowRight", "ArrowRight", 39], arrowright: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36], end: ["End", "End", 35],
    pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
    insert: ["Insert", "Insert", 45], ins: ["Insert", "Insert", 45],
  };
  const lk = name.toLowerCase();
  if (named[lk]) return { key: named[lk][0], code: named[lk][1], vk: named[lk][2] };
  const fm = /^f([1-9]|1[0-2])$/i.exec(name);
  if (fm) { const n = Number(fm[1]); return { key: "F" + n, code: "F" + n, vk: 111 + n }; }
  if (name.length === 1) {
    const ch = name;
    const up = ch.toUpperCase();
    if (/[a-z]/i.test(ch)) return { key: ch, code: "Key" + up, vk: up.charCodeAt(0) };
    if (/[0-9]/.test(ch)) return { key: ch, code: "Digit" + ch, vk: ch.charCodeAt(0) };
    return { key: ch, code: "", vk: up.charCodeAt(0) };
  }
  return { key: name, code: "", vk: 0 };
}

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
async function cdpDeepSnapshot(tabId: number): Promise<any> {
  const s = await ensureAttached(tabId);
  const { root } = await cmd(tabId, "DOM.getDocument", { depth: -1, pierce: true });
  const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
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
    if (attrs.role && ["button", "link", "tab", "menuitem"].includes(attrs.role)) return true;
    if (attrs.contenteditable === "true") return true;
    return false;
  };
  const walk = (node: any) => {
    if (!node || n >= 400) return;
    if (node.nodeType === 1) {
      const attrs = attrsOf(node);
      if (isInteractive(node, attrs)) {
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
  return { url: root.documentURL, count: items.length, elements: items, deep: true };
}

// Banner-free shallow snapshot across all frames, injected concurrently. Each frame's ref offset
// is derived from its index (not its neighbor's actual element count) so every frame's injection
// can fire in parallel instead of waiting on the previous frame to resolve first; bbSnapshot caps
// at 400 elements per frame, so a 500-wide stride can never let two frames' ref ranges collide.
async function shallowSnapshot(tab: chrome.tabs.Tab): Promise<any> {
  assertScriptable(tab);
  let frames: { frameId: number }[];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id! })) ?? [{ frameId: 0 }];
  } catch {
    frames = [{ frameId: 0 }];
  }
  const FRAME_REF_STRIDE = 500;
  const results = await Promise.all(
    frames.map(async (f, i) => {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id!, frameIds: [f.frameId] },
          func: bbSnapshot as any,
          args: [i * FRAME_REF_STRIDE],
        });
        return { frameId: f.frameId, v: res?.[0]?.result as any };
      } catch {
        return null; // frame not injectable (about:blank, sandboxed, gone)
      }
    })
  );
  const all: any[] = [];
  for (const r of results) {
    if (!r || !r.v || !r.v.elements) continue;
    for (const e of r.v.elements) all.push(r.frameId === 0 ? e : { ...e, frameId: r.frameId });
  }
  if (all.length > 400) all.length = 400;
  return { url: tab.url, count: all.length, elements: all };
}

// Banner-free accessibility-tree snapshot, injected per-frame (same scheme as shallowSnapshot: each
// frame gets a disjoint ref-offset stride, and each interactive node is registered in that frame's
// window.__bbRefs so its ref works with click/fill/hover/type). The extension returns the structured
// per-frame trees; the server renders the compact text (server/src/ax.ts).
async function axSnapshot(tab: chrome.tabs.Tab): Promise<any> {
  assertScriptable(tab);
  let frames: { frameId: number }[];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id! })) ?? [{ frameId: 0 }];
  } catch {
    frames = [{ frameId: 0 }];
  }
  const FRAME_REF_STRIDE = 500;
  const results = await Promise.all(
    frames.map(async (f, i) => {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id!, frameIds: [f.frameId] },
          func: bbAxSnapshot as any,
          args: [i * FRAME_REF_STRIDE],
        });
        return { frameId: f.frameId, v: res?.[0]?.result as any };
      } catch {
        return null; // frame not injectable (about:blank, sandboxed, gone)
      }
    })
  );
  const outFrames: any[] = [];
  for (const r of results) {
    if (!r || !r.v) continue;
    outFrames.push({ frameId: r.frameId, url: r.v.url, root: r.v.root ?? null, truncated: !!r.v.truncated });
  }
  return { url: tab.url, frames: outFrames };
}

// Optionally attaches a fresh shallow snapshot to an interaction result (params.withSnapshot),
// so a caller doing e.g. click-then-observe can skip a separate follow-up snapshot() call.
// A snapshot failure is reported inline rather than masking the (already-succeeded) action result.
async function withSnapshotIfRequested(tab: chrome.tabs.Tab, params: any, result: any): Promise<any> {
  if (!params?.withSnapshot || !result || typeof result !== "object") return result;
  try {
    result.snapshot = await shallowSnapshot(tab);
  } catch (e) {
    result.snapshot = { error: e instanceof Error ? e.message : String(e) };
  }
  return result;
}

// Run a synthetic interaction with auto-wait actionability retry + trusted escalation.
// Retries while the element is missing or transiently not-actionable (hidden/disabled) up to
// params.timeoutMs (default 5000). For click, if the target is COVERED by an overlay, it escalates
// to a real trusted CDP click (unless noEscalate/autoTrusted:false), which scrolls it into view and
// clicks the real coordinates - reporting via:"trusted". Structured {notActionable, reason} otherwise.
async function interact(tab: chrome.tabs.Tab, action: string, ref: number | null, sel: string | null, value: string | null, params: any): Promise<any> {
  const timeoutMs = params.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  const args: any[] = [action, { ref, sel, value } satisfies BbActParams];
  let last: any = null;
  let ownerFrame: number | null = null; // once a frame owns the element, retry only there
  for (;;) {
    if (ownerFrame == null) {
      const r = await actAllFrames(tab, args);
      last = r.result;
      ownerFrame = r.frameId;
    } else {
      last = await actInFrame(tab, ownerFrame, args);
      if (last?.notFound) ownerFrame = null; // the frame lost the element - re-search all frames
    }
    if (last?.staleRef) last = { notFound: true }; // a dead ref won't recover; report as not found
    const retryable = last && (last.notFound || (last.notActionable && last.reason !== "covered"));
    if (!retryable || Date.now() >= deadline) break;
    await sleep(150);
  }
  if (action === "click" && last?.notActionable && last.reason === "covered" && params.autoTrusted !== false && !params.noEscalate) {
    try {
      const t = await trustedAction(tab.id!, "click", ref, sel);
      return { ...t, via: "trusted", wasCovered: true, coveredBy: last.coveredBy };
    } catch {
      return last; // trusted also failed - report the covered state
    }
  }
  if (last?.notFound) return { notActionable: true, reason: `not-found-after-${timeoutMs}ms`, ref, selector: sel };
  return last;
}

async function dispatch(method: string, params: any): Promise<any> {
  switch (method) {
    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
      if (params?.short) {
        return tabs.map((t) => ({ id: t.id, title: t.title, origin: safeOrigin(t.url), active: t.active }));
      }
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }

    case "tab_new": {
      const tab = await chrome.tabs.create({ url: params.url });
      await waitForComplete(tab.id!);
      const fresh = await chrome.tabs.get(tab.id!);
      return { tabId: fresh.id, title: fresh.title, url: fresh.url };
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
      await chrome.tabs.update(tab.id!, { url: params.url });
      await waitForComplete(tab.id!);
      const fresh = await chrome.tabs.get(tab.id!);
      return { tabId: fresh.id, title: fresh.title, url: fresh.url };
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
      return { title: top?.title ?? tab.title, url: top?.url ?? tab.url, text: combined };
    }

    case "snapshot": {
      const tab = await targetTab(params.tabId);
      if (params.deep) return cdpDeepSnapshot(tab.id!);
      return shallowSnapshot(tab);
    }

    case "click": {
      const tab = await targetTab(params.tabId);
      const result = params.trusted
        ? { ...(await trustedAction(tab.id!, "click", params.ref, params.selector)), via: "trusted" }
        : await interact(tab, "click", params.ref, params.selector, null, params);
      return withSnapshotIfRequested(tab, params, result);
    }

    case "fill": {
      const tab = await targetTab(params.tabId);
      const result = await interact(tab, "fill", params.ref, params.selector, params.value ?? null, params);
      return withSnapshotIfRequested(tab, params, result);
    }

    case "hover": {
      const tab = await targetTab(params.tabId);
      const result = params.trusted
        ? await trustedAction(tab.id!, "hover", params.ref, params.selector)
        : await interact(tab, "hover", params.ref, params.selector, null, params);
      return withSnapshotIfRequested(tab, params, result);
    }

    case "type": {
      const tab = await targetTab(params.tabId);
      const result = params.trusted
        ? await trustedAction(tab.id!, "type", params.ref, params.selector, params.text)
        : await interact(tab, "type", params.ref, params.selector, params.text ?? null, params);
      return withSnapshotIfRequested(tab, params, result);
    }

    case "input": {
      const tab = await targetTab(params.tabId);
      return cdpInput(tab.id!, params);
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
      return navByHistory(await targetTab(params.tabId), "back");

    case "go_forward":
      return navByHistory(await targetTab(params.tabId), "forward");

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
        if (params.includeBodies && e.finished && !e.failed) {
          try {
            const b = await bodyFetchSem.run(() => getResponseBody(tab.id!, e.requestId));
            row.responseBody = b.body;
            row.responseBodyBase64 = b.base64;
            if (b.truncated) {
              row.responseBodyTruncated = true;
              row.responseBodyOriginalLength = b.originalLength;
            }
          } catch (err) {
            row.responseBodyError = err instanceof Error ? err.message : String(err);
          }
        }
        out.push(row);
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
          ? { tabId: params.tabId, attached: true, capturing: s.netOn, bufferedRequests: s.net.size, deepRefs: s.refNodes.size, idleMs: Date.now() - s.lastUsedAt }
          : { tabId: params.tabId, attached: false, lastDetach: detach };
      }
      return {
        sessions: [...sessions.entries()].map(([tabId, s]) => ({
          tabId,
          capturing: s.netOn,
          bufferedRequests: s.net.size,
          idleMs: Date.now() - s.lastUsedAt,
        })),
        // Why a capture stopped, when it stopped on its own. "canceled_by_user" = the human dismissed
        // the debugging banner; "replaced_with_devtools" = they opened DevTools on that tab.
        lastDetach: [...lastDetach.entries()].map(([tabId, d]) => ({ tabId, ...d })),
      };
    }

    case "press_key": {
      const tab = await targetTab(params.tabId);
      const result = await inject(
        tab,
        (key: string) => {
          const el = (document.activeElement as HTMLElement) ?? document.body;
          const opts = { key, bubbles: true, cancelable: true };
          el.dispatchEvent(new KeyboardEvent("keydown", opts));
          el.dispatchEvent(new KeyboardEvent("keyup", opts));
          if (key === "Enter") {
            const form = (el as HTMLInputElement).form;
            if (form) form.requestSubmit();
          }
          return { pressed: key, target: el.tagName.toLowerCase() };
        },
        [params.key]
      );
      return withSnapshotIfRequested(tab, params, result);
    }

    case "scroll": {
      const tab = await targetTab(params.tabId);
      const result = await inject(
        tab,
        (dy: number | undefined, sel: string | undefined) => {
          if (sel) {
            const el = document.querySelector(sel);
            if (!el) return { error: `Element not found: ${sel}` };
            el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
            return { scrolledTo: sel };
          }
          window.scrollBy(0, dy ?? 600);
          return { scrolledBy: dy ?? 600, scrollY: window.scrollY };
        },
        [params.dy, params.selector]
      );
      return withSnapshotIfRequested(tab, params, result);
    }

    case "screenshot": {
      const tab = await targetTab(params.tabId);
      const rich = params.fullPage || params.selector || params.scale || (params.format && params.format !== "png");
      if (rich) return cdpScreenshot(tab, params);
      // default: banner-free visible-viewport PNG. captureVisibleTab grabs the ACTIVE tab of the given
      // window, so what it actually requires is that our tab is active in its own window - not that
      // Chrome owns OS focus. The two are treated separately on purpose: switching the active tab
      // needs a real repaint before capture, whereas raising an already-visible window does not, and
      // gating the settle on window focus meant a multi-window setup (or Chrome simply not being the
      // frontmost app) paid the full 350ms on every single screenshot.
      const win = await chrome.windows.get(tab.windowId!);
      if (!tab.active) {
        await chrome.tabs.update(tab.id!, { active: true });
        await sleep(350); // tab switch - let the newly-shown tab paint
      }
      if (!win.focused) {
        await chrome.windows.update(tab.windowId!, { focused: true }).catch(() => {});
        await sleep(60); // window raise - compositor only, no layout
      }
      // The returned meta already reports visibilityState/hidden, so a caller capturing an occluded
      // or minimized window is still warned that the frame may be throttled or stale.
      await throttleCapture(tab.windowId!);
      let dataUrl: string;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "png" });
      } catch (e) {
        // Belt-and-braces: the throttle's timestamps live in service-worker memory, so an SW respawn
        // between captures can still land inside the quota window. One spaced retry covers it.
        if (!/quota/i.test(e instanceof Error ? e.message : String(e))) throw e;
        await sleep(MIN_CAPTURE_INTERVAL_MS);
        lastCaptureAt.set(tab.windowId!, Date.now());
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "png" });
      }
      const meta = await viewportMeta(tab);
      return { base64: dataUrl.replace(/^data:image\/png;base64,/, ""), format: "png", ...meta };
    }

    case "eval_js": {
      const tab = await targetTab(params.tabId);
      // Force the CDP path (Runtime.evaluate) - bypasses CSP unsafe-eval; shows the debugger banner.
      if (params.cdp) return cdpEvaluate(tab.id!, params.code, params.awaitPromise ?? true);
      try {
        return await inject(
        tab,
        (code: string) => {
          try {
            // eslint-disable-next-line no-eval
            const value = (0, eval)(code);
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
        [params.code],
        "MAIN"
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
      const timeoutMs = params.timeoutMs ?? (params.selector ? 10_000 : 1_000);
      if (!params.selector) {
        await sleep(timeoutMs);
        return { slept: timeoutMs };
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = await inject(tab, (sel: string) => !!document.querySelector(sel), [params.selector]);
        if (found) return { found: true, selector: params.selector };
        await sleep(100); // 250ms meant ~125ms of average overshoot past the element appearing

      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for selector: ${params.selector}`);
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
      s.paused.clear();
      await cmd(tab.id!, "Fetch.enable", { patterns });
      s.interceptOn = true;
      return { intercepting: true, tabId: tab.id!, patterns, rules: s.interceptRules.length };
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
        for (const e of s.paused.values()) {
          try {
            await cmd(tab.id!, e.stage === "Response" ? "Fetch.continueResponse" : "Fetch.continueRequest", { requestId: e.requestId });
          } catch {
            /* already gone */
          }
        }
        s.paused.clear();
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
      return axSnapshot(tab);
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
});
chrome.tabs.onRemoved.addListener((tabId) => {
  finalizeCapture(tabId);
  sessions.delete(tabId);
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
// SPA route changes seen from the browser side, belt-and-braces with the page's own history patch
// (which only exists when console:true registered the MAIN-world script).
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  void ready().then(() => {
    const g = watchForTab(d.tabId);
    if (!g || g.consoleMode === "off") return;
    // A fresh document has no shim: it is injected as an inline function, not a registered script.
    chrome.scripting
      .executeScript({
        target: { tabId: d.tabId, allFrames: true },
        func: bbWatchMainShim,
        args: [g.consoleMode],
        world: "MAIN",
      } as chrome.scripting.ScriptInjection<any, any>)
      .catch(() => undefined);
  });
});
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
    reconnectDelay = 1_000;
    connect();
  }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.cmd === "reconnect") {
    ws?.close();
    reconnectDelay = 1_000;
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
