// Watch mode - the browsing copilot.
//
// The human browses; a content script (extension/src/watch-entry.ts) emits ALREADY-LABELED semantic
// events from inside the page, the service worker forwards them verbatim, and this module folds them
// into a cursor-addressable timeline the agent can poll.
//
// Why the labeling happens in the page and not here: the only place a click's label exists is the live
// DOM. Deriving it from the rrweb stream instead means rebuilding a node index, and rrweb restarts node
// ids at 1 in every document (verified: consecutive FullSnapshots in a real recording carry maxIds 186,
// 1601, 1230, 1798 - all minId 1), so one missed mutation batch silently mislabels every later click
// with full confidence. Capturing at the source also yields a `selector` the click/fill tools accept,
// which an rrweb node id never could.
//
// This file is deliberately I/O-free and deterministic - `foldEvent` is the unit-tested surface. Disk
// and socket concerns live in tools.ts / hub.ts.

// ---------------------------------------------------------------------------
// Wire format (what the extension sends)
// ---------------------------------------------------------------------------

/** An element as the page saw it, labeled at capture time. */
export interface ElementRef {
  tag: string;
  label?: string;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  href?: string;
  /** CSS-ish path, shadow boundaries joined with " >> ". Consumable by click/fill where stable. */
  selector: string;
  /** The page flagged this field as credential-bearing (type=password, autocomplete=*-password). */
  secret?: boolean;
}

/** One raw event off the wire. `k` is the discriminator; the rest is per-kind. */
export interface RawEvent {
  t: number; // Date.now() in the page
  k:
    | "click"
    | "input"
    | "change"
    | "submit"
    | "key"
    | "focus"
    | "blur"
    | "copy"
    | "paste"
    | "scroll"
    | "nav"
    | "console"
    | "hidden"
    | "visible"
    | "opened"
    | "closed";
  el?: ElementRef;
  value?: string;
  checked?: boolean;
  key?: string;
  code?: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  button?: number;
  x?: number;
  y?: number;
  url?: string;
  from?: string;
  via?: "load" | "spa" | "hint" | "popstate" | "hash";
  title?: string;
  level?: string;
  text?: string;
  src?: string;
  line?: number;
  fields?: { name: string; value: string; secret?: boolean }[];
}

/** Routing metadata the service worker stamps on each batch. */
export interface EventEnvelope {
  tabId: number;
  frameId?: number;
}

/** A net row as streamed by the extension's persist path (see background.ts captureNetRow). */
export interface NetRow {
  kind: "net";
  requestId?: string;
  method?: string;
  url?: string;
  type?: string;
  status?: number;
  mimeType?: string;
  failed?: string;
  ts?: number;
  timing?: any;
}

// ---------------------------------------------------------------------------
// Action model (what the agent reads)
// ---------------------------------------------------------------------------

export type ActionKind =
  | "nav"
  | "click"
  | "input"
  | "submit"
  | "key"
  | "copy"
  | "paste"
  | "scroll"
  | "console"
  | "net"
  | "tab"
  | "gap";

export type GapReason =
  | "extension-disconnected"
  | "sw-restarted"
  | "watch-lost"
  | "ring-evicted"
  | "unscriptable"
  | "tab-closed";

export interface BaseAction {
  seq: number;
  ts: number;
  tabId: number;
  frameId?: number;
  kind: ActionKind;
  /** seq of the user action this was attributed to. Set at commit, never mutated afterwards. */
  causedBy?: number;
  /** True when this came from an agent tool call rather than the human (see WatchSession.noteAgentCall). */
  agent?: boolean;
}

export interface NavAction extends BaseAction {
  kind: "nav";
  url: string;
  from?: string;
  title?: string;
  via: "load" | "spa" | "hint" | "popstate" | "hash";
}
export interface ClickAction extends BaseAction {
  kind: "click";
  target: ElementRef;
  button: "left" | "middle" | "right";
  x?: number;
  y?: number;
}
export interface InputAction extends BaseAction {
  kind: "input";
  target: ElementRef;
  value: string;
  chars: number;
  ms: number;
  checked?: boolean;
  redacted?: true;
}
export interface SubmitAction extends BaseAction {
  kind: "submit";
  target: ElementRef;
  fields?: { name: string; value: string }[];
}
export interface KeyAction extends BaseAction {
  kind: "key";
  key: string;
  text: string;
  repeat?: number;
  target?: ElementRef;
}
export interface ClipAction extends BaseAction {
  kind: "copy" | "paste";
  target?: ElementRef;
  chars?: number;
}
export interface ScrollAction extends BaseAction {
  kind: "scroll";
  y: number;
  dy: number;
  target?: ElementRef;
}
export interface ConsoleAction extends BaseAction {
  kind: "console";
  level: string;
  text: string;
  src?: string;
  line?: number;
}
export interface NetAction extends BaseAction {
  kind: "net";
  method: string;
  url: string;
  status?: number;
  resType?: string;
  failed?: string;
  ms?: number;
  requestId?: string;
}
export interface TabAction extends BaseAction {
  kind: "tab";
  event: "added" | "closed" | "focused" | "replaced" | "hidden" | "visible";
  url?: string;
  title?: string;
}
export interface GapAction extends BaseAction {
  kind: "gap";
  reason: GapReason;
  ms: number;
  note?: string;
}

export type Action =
  | NavAction
  | ClickAction
  | InputAction
  | SubmitAction
  | KeyAction
  | ClipAction
  | ScrollAction
  | ConsoleAction
  | NetAction
  | TabAction
  | GapAction;

/** Omit that distributes over a union. A plain Omit<Action,"seq"> collapses to the members' COMMON
 *  keys, which would silently erase every per-kind field. */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

/** An action before commit: same shape, no seq yet. */
export type Staged = DistributiveOmit<Action, "seq">;

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

export type RedactMode = "auto" | "all" | "none";

export interface FoldOpts {
  redact: RedactMode;
  /** Quiescence before a typing burst is finalized into one action. */
  inputIdleMs: number;
  /** Quiescence before a scroll run is finalized. */
  scrollIdleMs: number;
  /** Minimum absolute scroll delta worth an action. */
  scrollMinPx: number;
  include: Set<ActionKind>;
}

export const DEFAULT_INCLUDE: ActionKind[] = [
  "nav",
  "click",
  "input",
  "submit",
  "key",
  "copy",
  "paste",
  "console",
  "net",
  "tab",
  "gap",
];

export function defaultFoldOpts(over: Partial<FoldOpts> = {}): FoldOpts {
  return {
    redact: "auto",
    inputIdleMs: 1500,
    scrollIdleMs: 2000,
    scrollMinPx: 100,
    include: new Set(DEFAULT_INCLUDE),
    ...over,
  };
}

interface InputBurst {
  key: string;
  tabId: number;
  frameId?: number;
  el: ElementRef;
  first: number;
  last: number;
  count: number;
  value: string;
  checked?: boolean;
}

interface ScrollRun {
  tabId: number;
  frameId?: number;
  first: number;
  last: number;
  from: number;
  to: number;
  el?: ElementRef;
}

interface KeyRun {
  tabId: number;
  frameId?: number;
  text: string;
  key: string;
  first: number;
  last: number;
  count: number;
  el?: ElementRef;
}

export interface FoldState {
  opts: FoldOpts;
  input: InputBurst | null;
  scroll: ScrollRun | null;
  keyRun: KeyRun | null;
  /** Last URL seen per tab, so a repeated nav signal (SW hint + page popstate) emits once. */
  lastUrl: Map<number, string>;
  /** Last tab visibility transition emitted, to collapse the run every navigation produces. */
  lastTabEvent: string | null;
}

export function createFoldState(opts: FoldOpts = defaultFoldOpts()): FoldState {
  return { opts, input: null, scroll: null, keyRun: null, lastUrl: new Map(), lastTabEvent: null };
}

const SPECIAL_KEYS: Record<string, string> = {
  Enter: "↵",
  Tab: "⇥",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowRight: "→",
  ArrowDown: "↓",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** Human-readable keystroke, or null when the key is an ordinary printable character.
 *  Printables are deliberately dropped: the coalesced `input` action already carries the typed text,
 *  and a per-character stream is both noisy and the password-leak path. */
export function formatKey(e: RawEvent): string | null {
  const mods: string[] = [];
  if (e.meta) mods.push("⌘");
  if (e.ctrl) mods.push("⌃");
  if (e.alt) mods.push("⌥");
  if (e.shift && (e.ctrl || e.meta || e.alt)) mods.push("⇧");
  const k = e.key ?? "";
  const special = SPECIAL_KEYS[k];
  if (!special && !mods.length) return null; // plain printable - covered by `input`
  const base = special ?? (k.length === 1 ? k.toUpperCase() : k);
  return mods.length ? mods.join("") + base : base;
}

const SECRET_NAME = /pass|secret|token|otp|cvv|ssn|card|pin\b/i;

function isSecret(el: ElementRef | undefined, mode: RedactMode): boolean {
  if (mode === "none") return false;
  if (mode === "all") return true;
  if (!el) return false;
  if (el.secret) return true; // the page already decided (type=password, autocomplete=*-password)
  if ((el.type ?? "").toLowerCase() === "password") return true;
  return SECRET_NAME.test(el.name ?? "") || SECRET_NAME.test(el.id ?? "");
}

function redactValue(v: string): string {
  return `•••• (${v.length} chars)`;
}

/** Stable identity for a typing burst: the same field keeps accumulating, a different one finalizes. */
function burstKey(env: EventEnvelope, el: ElementRef): string {
  return `${env.tabId}:${env.frameId ?? 0}:${el.selector}`;
}

function finalizeInput(state: FoldState, out: Staged[]): void {
  const b = state.input;
  state.input = null;
  if (!b || !state.opts.include.has("input")) return;
  const secret = isSecret(b.el, state.opts.redact);
  const action: Omit<InputAction, "seq"> = {
    ts: b.last,
    tabId: b.tabId,
    frameId: b.frameId,
    kind: "input",
    target: b.el,
    value: secret ? redactValue(b.value) : b.value,
    chars: b.count,
    ms: Math.max(0, b.last - b.first),
  };
  if (secret) action.redacted = true;
  if (b.checked !== undefined) action.checked = b.checked;
  out.push(action);
}

function finalizeScroll(state: FoldState, out: Staged[]): void {
  const s = state.scroll;
  state.scroll = null;
  if (!s || !state.opts.include.has("scroll")) return;
  const dy = s.to - s.from;
  if (Math.abs(dy) < state.opts.scrollMinPx) return;
  out.push({ ts: s.last, tabId: s.tabId, frameId: s.frameId, kind: "scroll", y: s.to, dy, target: s.el });
}

function finalizeKeyRun(state: FoldState, out: Staged[]): void {
  const k = state.keyRun;
  state.keyRun = null;
  if (!k || !state.opts.include.has("key")) return;
  const a: Omit<KeyAction, "seq"> = {
    ts: k.last,
    tabId: k.tabId,
    frameId: k.frameId,
    kind: "key",
    key: k.key,
    text: k.text,
    target: k.el,
  };
  if (k.count > 1) a.repeat = k.count;
  out.push(a);
}

/** Finalize every open coalescer. Called before a user-visible boundary and before every read. */
function finalizeAll(state: FoldState, out: Staged[]): void {
  finalizeInput(state, out);
  finalizeKeyRun(state, out);
  finalizeScroll(state, out);
}

/**
 * Fold one raw page event into zero or more staged actions.
 *
 * Deterministic and I/O-free: given the same state and event sequence it always produces the same
 * actions. `state` is mutated in place (the coalescers are the whole point); callers that need
 * isolation create a fresh state with createFoldState().
 */
export function foldEvent(state: FoldState, env: EventEnvelope, ev: RawEvent): Staged[] {
  const out: Staged[] = [];
  const inc = state.opts.include;
  const base = { ts: ev.t, tabId: env.tabId, frameId: env.frameId };

  switch (ev.k) {
    case "input":
    case "change": {
      if (!ev.el) break;
      const key = burstKey(env, ev.el);
      // A different field ends the previous burst - typing never straddles two inputs.
      if (state.input && state.input.key !== key) finalizeInput(state, out);
      if (!state.input) {
        state.input = {
          key,
          tabId: env.tabId,
          frameId: env.frameId,
          el: ev.el,
          first: ev.t,
          last: ev.t,
          count: 0,
          value: "",
        };
      }
      const b = state.input!;
      b.last = ev.t;
      b.value = ev.value ?? "";
      if (ev.checked !== undefined) b.checked = ev.checked;
      // `change` is the committed value - one discrete edit, not a keystroke in a run.
      if (ev.k === "change") {
        b.count = Math.max(1, b.count);
        finalizeInput(state, out);
      } else {
        b.count++;
      }
      break;
    }

    case "click": {
      finalizeAll(state, out);
      if (!inc.has("click") || !ev.el) break;
      const button = ev.button === 2 ? "right" : ev.button === 1 ? "middle" : "left";
      out.push({ ...base, kind: "click", target: ev.el, button, x: ev.x, y: ev.y });
      break;
    }

    case "submit": {
      finalizeAll(state, out);
      if (!inc.has("submit") || !ev.el) break;
      const fields = (ev.fields ?? [])
        .filter((f) => f.name)
        .map((f) => ({
          name: f.name,
          value:
            f.secret || state.opts.redact === "all" || (state.opts.redact === "auto" && SECRET_NAME.test(f.name))
              ? redactValue(f.value ?? "")
              : f.value ?? "",
        }));
      out.push({ ...base, kind: "submit", target: ev.el, fields: fields.length ? fields : undefined });
      break;
    }

    case "key": {
      const text = formatKey(ev);
      if (!text) break; // printable - the input coalescer owns it
      // Enter/Tab/Escape commit the field being typed into, so the input lands before the key.
      if (ev.key === "Enter" || ev.key === "Tab" || ev.key === "Escape") finalizeInput(state, out);
      if (!inc.has("key")) break;
      const run = state.keyRun;
      if (run && run.text === text && run.tabId === env.tabId) {
        run.last = ev.t;
        run.count++;
      } else {
        finalizeKeyRun(state, out);
        state.keyRun = {
          tabId: env.tabId,
          frameId: env.frameId,
          text,
          key: ev.key ?? "",
          first: ev.t,
          last: ev.t,
          count: 1,
          el: ev.el,
        };
      }
      break;
    }

    case "blur": {
      finalizeInput(state, out);
      break;
    }

    case "focus": {
      // Focusing a different element ends the current burst; refocusing the same one does not.
      if (state.input && ev.el && state.input.key !== burstKey(env, ev.el)) finalizeInput(state, out);
      break;
    }

    case "scroll": {
      if (!inc.has("scroll")) break;
      const y = ev.y ?? 0;
      const run = state.scroll;
      if (run && run.tabId === env.tabId && ev.t - run.last <= state.opts.scrollIdleMs) {
        run.last = ev.t;
        run.to = y;
      } else {
        finalizeScroll(state, out);
        state.scroll = { tabId: env.tabId, frameId: env.frameId, first: ev.t, last: ev.t, from: y, to: y, el: ev.el };
      }
      break;
    }

    case "nav": {
      finalizeAll(state, out);
      const url = ev.url ?? "";
      if (!url) break;
      // Not navigations of the tab: about:blank / blob: / data: documents, and a SUBFRAME reporting
      // its own initial load. The listener runs in every frame, so each iframe would otherwise
      // announce itself as a page navigation the human never made.
      if (/^(about|blob|data|chrome-extension):/i.test(url)) break;
      if (env.frameId !== undefined && env.frameId !== 0 && (ev.via ?? "load") === "load") break;
      // The same navigation reaches us twice by design (the page's popstate and the SW's
      // webNavigation hint). Dedupe on URL so belt-and-braces coverage doesn't double-report.
      if (state.lastUrl.get(env.tabId) === url) break;
      const from = state.lastUrl.get(env.tabId);
      state.lastUrl.set(env.tabId, url);
      if (!inc.has("nav")) break;
      out.push({ ...base, kind: "nav", url, from, title: ev.title, via: ev.via ?? "load" });
      break;
    }

    case "copy":
    case "paste": {
      if (!inc.has(ev.k)) break;
      out.push({ ...base, kind: ev.k, target: ev.el, chars: ev.text ? ev.text.length : undefined });
      break;
    }

    case "console": {
      if (!inc.has("console")) break;
      out.push({
        ...base,
        kind: "console",
        level: ev.level ?? "log",
        text: (ev.text ?? "").slice(0, 500),
        src: ev.src,
        line: ev.line,
      });
      break;
    }

    case "hidden":
    case "visible":
    case "opened":
    case "closed": {
      finalizeAll(state, out);
      if (!inc.has("tab")) break;
      const event = ev.k === "opened" ? "added" : ev.k === "closed" ? "closed" : ev.k;
      // A navigation fires visibilitychange in every document of the tab - the outgoing page, and any
      // about:blank the browser passes through - so the raw stream carries runs of identical entries.
      // Report the transition, not each document's opinion of it.
      const url = ev.url && !/^about:/.test(ev.url) ? ev.url : undefined;
      const key = `${env.tabId}:${event}`;
      if ((event === "hidden" || event === "visible") && state.lastTabEvent === key) break;
      state.lastTabEvent = event === "hidden" || event === "visible" ? key : null;
      out.push({ ...base, kind: "tab", event, url, title: ev.title });
      break;
    }
  }

  return out;
}

/** Fold a network row from the capture stream. */
export function foldNetRow(state: FoldState, env: EventEnvelope, row: NetRow, receivedAt: number): Staged[] {
  if (!state.opts.include.has("net")) return [];
  // Only the human's own traffic. Other installed extensions inject scripts and fire fetches into
  // every page - observed live as a stream of `chrome-extension://invalid/ net::ERR_FAILED` rows that
  // buried the real requests. The rrweb replay path strips foreign-extension nodes for the same reason.
  const url = row.url ?? "";
  if (!/^https?:\/\//i.test(url)) return [];
  const type = row.type ?? "";
  const interesting =
    /^(Document|XHR|Fetch|WebSocket|EventSource)$/i.test(type) || (row.status ?? 0) >= 400 || !!row.failed;
  if (!interesting) return []; // drop the 80 images/fonts/CSS of a page load, keep what means something
  const ts = row.ts ?? receivedAt;
  return [
    {
      ts,
      tabId: env.tabId,
      kind: "net",
      method: (row.method ?? "GET").toUpperCase(),
      url: row.url ?? "",
      status: row.status,
      resType: type || undefined,
      failed: row.failed,
      ms: row.ts ? Math.max(0, receivedAt - row.ts) : undefined,
      requestId: row.requestId,
    },
  ];
}

/** Finalize coalescers whose quiescence window has elapsed. Called before every read and on a timer. */
export function foldFlush(state: FoldState, now: number, force = false): Staged[] {
  const out: Staged[] = [];
  if (state.input && (force || now - state.input.last >= state.opts.inputIdleMs)) finalizeInput(state, out);
  if (state.keyRun && (force || now - state.keyRun.last >= state.opts.inputIdleMs)) finalizeKeyRun(state, out);
  if (state.scroll && (force || now - state.scroll.last >= state.opts.scrollIdleMs)) finalizeScroll(state, out);
  return out;
}

// ---------------------------------------------------------------------------
// Ring
// ---------------------------------------------------------------------------

export interface ScanResult {
  actions: Action[];
  /** Last seq examined - the cursor advances past filtered-out actions so a filtered reader never rescans. */
  scannedTo: number;
  more: boolean;
  remaining: number;
}

/**
 * Bounded action ring. Capped by BOTH count and bytes: 5000 tiny clicks and 5000 fat console rows
 * have wildly different footprints, and only the byte cap bounds an 8-hour session's memory.
 */
export class ActionRing {
  private buf: Action[] = [];
  private bytes = 0;
  minSeq = 1;
  maxSeq = 0;
  evicted = 0;

  constructor(private maxCount = 5000, private maxBytes = 4 * 1024 * 1024) {}

  push(a: Action): void {
    this.buf.push(a);
    this.bytes += approxBytes(a);
    this.maxSeq = a.seq;
    while (this.buf.length > this.maxCount || this.bytes > this.maxBytes) {
      const old = this.buf.shift();
      if (!old) break;
      this.bytes -= approxBytes(old);
      this.evicted++;
      this.minSeq = old.seq + 1;
    }
    if (this.buf.length === 1) this.minSeq = a.seq;
  }

  get size(): number {
    return this.buf.length;
  }
  get byteSize(): number {
    return this.bytes;
  }

  scan(sinceSeq: number, match: (a: Action) => boolean, limit: number, charBudget: number): ScanResult {
    const actions: Action[] = [];
    let scannedTo = sinceSeq;
    let spent = 0;
    let more = false;
    let remaining = 0;
    for (const a of this.buf) {
      if (a.seq <= sinceSeq) continue;
      if (more) {
        if (match(a)) remaining++;
        continue;
      }
      if (!match(a)) {
        scannedTo = a.seq; // advance past it: a filtered reader must not re-walk this range
        continue;
      }
      const cost = approxBytes(a);
      if (actions.length >= limit || (actions.length > 0 && spent + cost > charBudget)) {
        more = true;
        remaining++;
        continue;
      }
      actions.push(a);
      spent += cost;
      scannedTo = a.seq;
    }
    return { actions, scannedTo, more, remaining };
  }
}

function approxBytes(a: Action): number {
  // Cheap and stable - an exact JSON.stringify per push would dominate the hot path.
  let n = 80;
  const anyA = a as any;
  if (anyA.url) n += String(anyA.url).length;
  if (anyA.value) n += String(anyA.value).length;
  if (anyA.text) n += String(anyA.text).length;
  if (anyA.target) n += (anyA.target.selector?.length ?? 0) + (anyA.target.label?.length ?? 0);
  return n;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Minimal sink contract so this module never imports fs. tools.ts passes a CaptureSink. */
export interface AppendSink {
  path: string;
  append(rows: any[]): void;
  close(): void;
}

export interface WatchOpts {
  redact: RedactMode;
  include: Set<ActionKind>;
  ringCount: number;
  ringBytes: number;
  /** Actions are held this long before commit so streams that arrive in different batches interleave
   *  by true time. Below this, seq order and ts order can disagree and cursors get subtly wrong. */
  reorderMs: number;
  network: boolean;
  console: boolean;
}

export function defaultWatchOpts(over: Partial<WatchOpts> = {}): WatchOpts {
  return {
    redact: "auto",
    include: new Set(DEFAULT_INCLUDE),
    ringCount: 5000,
    ringBytes: 4 * 1024 * 1024,
    reorderMs: 400,
    network: false,
    console: false,
    ...over,
  };
}

export interface WatchHealth {
  state: "live" | "blind" | "stopped";
  extensionConnected: boolean;
  lastEventAgeMs: number | null;
  tabs: number[];
  ring: { size: number; bytes: number; minSeq: number; maxSeq: number; evicted: number };
  warnings: string[];
}

interface Waiter {
  match: (a: Action) => boolean;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  settle: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

/** Causality windows, ms. Chaining beats fan-out: see pickCause. */
const CAUSE_WINDOW = {
  clickToNav: 3000,
  clickToNet: 1500,
  submitToAny: 3000,
  keyToAny: 3000,
  navToNet: 5000,
  userToConsole: 2000,
};

export class WatchSession {
  readonly watchId: string;
  readonly startedAt: number;
  readonly opts: WatchOpts;
  readonly rootTabId: number;
  readonly tabs = new Set<number>();

  private ring: ActionRing;
  private folds = new Map<number, FoldState>();
  private staged: Staged[] = [];
  private seq = 0;
  private lastCommittedTs = 0;
  private waiters = new Set<Waiter>();
  private sink: AppendSink | null = null;
  private stopped = false;

  lastEventAt = 0;
  blindSince: number | null = null;
  /** The extension reconnected but no longer knows about this watch (it was reloaded or updated).
   *  The socket being up says nothing about whether any PAGE is still instrumented. */
  browserLost = false;
  /** Set when the watch persists full network traffic. Carried on the session so a tab that JOINS
   *  later (a link opened in a new tab) gets its own capture too - otherwise "capture everything"
   *  would quietly stop at the tab the watch started on. */
  netCapture: { basePath: string; bodies: boolean; maxEntries: number } | null = null;
  /** Tabs that already have a network capture attached, so a re-announce doesn't double-attach. */
  readonly netTabs = new Set<number>();

  // Causality bookkeeping - a short tail of recent user actions, per tab.
  private lastClick = new Map<number, Action>();
  private lastSubmit = new Map<number, Action>();
  private lastKey = new Map<number, Action>();
  private lastNav = new Map<number, Action>();
  /** Windows during which incoming actions are attributed to the agent rather than the human. */
  private agentCalls: { from: number; to: number }[] = [];

  constructor(watchId: string, rootTabId: number, opts: WatchOpts, now: number) {
    this.watchId = watchId;
    this.rootTabId = rootTabId;
    this.opts = opts;
    this.startedAt = now;
    this.ring = new ActionRing(opts.ringCount, opts.ringBytes);
    this.tabs.add(rootTabId);
  }

  /**
   * Identifies this INCARNATION of the watch, not just the watch.
   *
   * The extension persists its watch group across a server restart, so the watchId survives while the
   * server's seq counter restarts at 0. Without an epoch, a pre-restart cursor like "w123:12" is
   * accepted as same-session and silently points past the head - the reader gets 0 actions and
   * dropped:0 while activity is happening. Verified against a live browser before this existed.
   */
  get epoch(): string {
    return this.startedAt.toString(36);
  }
  get cursorAt(): string {
    return `${this.watchId}.${this.epoch}:${this.seq}`;
  }

  setSink(sink: AppendSink | null): void {
    this.sink = sink;
  }
  get digestPath(): string | null {
    return this.sink?.path ?? null;
  }
  get isStopped(): boolean {
    return this.stopped;
  }

  private fold(tabId: number): FoldState {
    let f = this.folds.get(tabId);
    if (!f) {
      f = createFoldState(defaultFoldOpts({ redact: this.opts.redact, include: this.opts.include }));
      this.folds.set(tabId, f);
    }
    return f;
  }

  addTab(tabId: number, now: number, url?: string): void {
    if (this.tabs.has(tabId)) return;
    this.tabs.add(tabId);
    this.stage([{ ts: now, tabId, kind: "tab", event: "added", url }]);
  }

  removeTab(tabId: number, now: number): void {
    if (!this.tabs.delete(tabId)) return;
    const f = this.folds.get(tabId);
    if (f) this.stage(foldFlush(f, now, true));
    this.folds.delete(tabId);
    this.stage([{ ts: now, tabId, kind: "tab", event: "closed" }]);
  }

  /** Feed a batch of raw page events. */
  ingest(env: EventEnvelope, events: RawEvent[], receivedAt: number): void {
    if (this.stopped) return;
    const f = this.fold(env.tabId);
    for (const ev of events) {
      if (!ev || typeof ev.t !== "number") continue;
      this.lastEventAt = Math.max(this.lastEventAt, ev.t);
      this.stage(foldEvent(f, env, ev));
    }
    this.commitDue(receivedAt);
  }

  /** Feed network rows from the capture stream. */
  ingestNet(env: EventEnvelope, rows: NetRow[], receivedAt: number): void {
    if (this.stopped || !this.opts.network) return;
    const f = this.fold(env.tabId);
    for (const row of rows) this.stage(foldNetRow(f, env, row, receivedAt));
    this.commitDue(receivedAt);
  }

  /**
   * The browser side of this watch is gone even though the socket is fine.
   *
   * Found in testing: toggling the extension off and on cleared its watch group, every page disarmed
   * itself, and capture was completely dead - while this session still reported state:"live" with no
   * warnings, because the socket had reconnected. Socket health is not capture health.
   */
  markBrowserLost(now: number): void {
    if (this.browserLost || this.stopped) return;
    this.browserLost = true;
    this.noteGap("watch-lost", 0, now, this.rootTabId, "the extension no longer has this watch - call watch_start again");
    this.releaseWaiters(); // a pending long poll must not hang waiting for a page that will never report
  }

  /** The extension re-announced this watch, so it is genuinely live again. */
  markBrowserFound(): void {
    this.browserLost = false;
  }

  /** Record a blindness window as a first-class timeline entry. Silence and breakage must not look alike. */
  noteGap(reason: GapReason, ms: number, now: number, tabId = this.rootTabId, note?: string): void {
    if (!this.opts.include.has("gap")) return;
    this.stage([{ ts: now, tabId, kind: "gap", reason, ms, note }]);
    this.commitDue(now);
  }

  /** Mark a window as agent-driven so the timeline can distinguish the agent's clicks from the human's. */
  noteAgentCall(from: number, to: number): void {
    this.agentCalls.push({ from, to });
    if (this.agentCalls.length > 200) this.agentCalls.splice(0, this.agentCalls.length - 200);
  }

  private stage(actions: Staged[]): void {
    for (const a of actions) this.staged.push(a);
  }

  /**
   * Promote staged actions older than the reorder window into the ring, assigning seq in ts order.
   * Pass Infinity to drain everything (stop, tests, file folding).
   */
  commitDue(now: number): Action[] {
    const cutoff = now === Infinity ? Infinity : now - this.opts.reorderMs;
    if (!this.staged.length) return [];
    const ready: Staged[] = [];
    const held: Staged[] = [];
    for (const a of this.staged) (a.ts <= cutoff ? ready : held).push(a);
    this.staged = held;
    if (!ready.length) return [];
    ready.sort((x, y) => x.ts - y.ts);

    const committed: Action[] = [];
    for (const s of ready) {
      // A late arrival keeps its true ts but never reorders the cursor.
      const ts = Math.max(s.ts, this.lastCommittedTs);
      this.lastCommittedTs = ts;
      const action = { ...s, seq: ++this.seq } as Action;
      if (this.isAgentWindow(action.ts)) action.agent = true;
      this.linkCause(action);
      this.rememberCause(action);
      this.ring.push(action);
      committed.push(action);
    }
    if (committed.length) {
      this.sink?.append(committed);
      this.wake(committed);
    }
    return committed;
  }

  private isAgentWindow(ts: number): boolean {
    for (const w of this.agentCalls) if (ts >= w.from && ts <= w.to) return true;
    return false;
  }

  private rememberCause(a: Action): void {
    if (a.kind === "click") this.lastClick.set(a.tabId, a);
    else if (a.kind === "submit") this.lastSubmit.set(a.tabId, a);
    else if (a.kind === "key") this.lastKey.set(a.tabId, a);
    else if (a.kind === "nav") this.lastNav.set(a.tabId, a);
  }

  /**
   * Attribute an effect to the user action that caused it.
   *
   * The rule that matters is CHAINING, not fan-out: once a nav has been attributed to a click, the
   * page load's requests attach to the NAV, not back to the click. Otherwise one click on "Publish"
   * collects eighty stylesheet and image requests and the causal link stops meaning anything.
   */
  private linkCause(a: Action): void {
    if (a.kind !== "net" && a.kind !== "console" && a.kind !== "nav") return;
    const tab = a.tabId;
    const click = this.lastClick.get(tab);
    const submit = this.lastSubmit.get(tab);
    const key = this.lastKey.get(tab);
    const nav = this.lastNav.get(tab);

    const within = (c: Action | undefined, ms: number) => (c && a.ts >= c.ts && a.ts - c.ts <= ms ? c : undefined);

    if (a.kind === "nav") {
      const cause =
        within(submit, CAUSE_WINDOW.submitToAny) ?? within(click, CAUSE_WINDOW.clickToNav) ?? within(key, CAUSE_WINDOW.keyToAny);
      if (cause) a.causedBy = cause.seq;
      return;
    }

    if (a.kind === "console") {
      const cause =
        within(nav, CAUSE_WINDOW.userToConsole) ??
        within(click, CAUSE_WINDOW.userToConsole) ??
        within(submit, CAUSE_WINDOW.userToConsole) ??
        within(key, CAUSE_WINDOW.userToConsole);
      if (cause) a.causedBy = cause.seq;
      return;
    }

    // net: a nav supersedes whatever caused the nav, for as long as its window lasts.
    const n = within(nav, CAUSE_WINDOW.navToNet);
    const s = within(submit, CAUSE_WINDOW.submitToAny);
    const c = within(click, CAUSE_WINDOW.clickToNet);
    const k = within(key, CAUSE_WINDOW.keyToAny);
    let best: Action | undefined;
    if (n && (!c || n.ts >= c.ts) && (!s || n.ts >= s.ts)) best = n;
    else best = [s, c, k].filter(Boolean).sort((x, y) => y!.ts - x!.ts)[0];
    if (best) a.causedBy = best.seq;
  }

  /** Finalize idle coalescers, then commit. Every read calls this so nothing sits invisible. */
  pump(now: number, force = false): void {
    for (const f of this.folds.values()) this.stage(foldFlush(f, now, force));
    this.commitDue(force ? Infinity : now);
  }

  read(
    sinceSeq: number,
    filter: { tabId?: number; include?: Set<ActionKind> },
    limit: number,
    charBudget: number
  ): ScanResult & { dropped: number } {
    const match = (a: Action) => {
      if (filter.tabId !== undefined && a.tabId !== filter.tabId) return false;
      if (filter.include && !filter.include.has(a.kind)) return false;
      return true;
    };
    const res = this.ring.scan(sinceSeq, match, limit, charBudget);
    const dropped = sinceSeq > 0 && sinceSeq + 1 < this.ring.minSeq ? this.ring.minSeq - sinceSeq - 1 : 0;
    return { ...res, dropped };
  }

  get lastSeq(): number {
    return this.seq;
  }

  health(extensionConnected: boolean, now: number): WatchHealth {
    const warnings: string[] = [];
    if (!extensionConnected) warnings.push("extension disconnected - no events are being captured");
    if (this.browserLost)
      warnings.push("the extension no longer has this watch (it was reloaded or updated) - nothing is being captured; call watch_start again");
    if (this.ring.evicted > 0) warnings.push(`${this.ring.evicted} actions evicted from the ring`);
    const age = this.lastEventAt ? now - this.lastEventAt : null;
    return {
      state: this.stopped ? "stopped" : extensionConnected && !this.browserLost ? "live" : "blind",
      extensionConnected,
      lastEventAgeMs: age,
      tabs: [...this.tabs],
      ring: {
        size: this.ring.size,
        bytes: this.ring.byteSize,
        minSeq: this.ring.minSeq,
        maxSeq: this.ring.maxSeq,
        evicted: this.ring.evicted,
      },
      warnings,
    };
  }

  // ---- long poll ----

  /** Resolve when an action matching `match` commits, or after timeoutMs. `signal` aborts early. */
  wait(match: (a: Action) => boolean, timeoutMs: number, settleMs: number, signal?: { addEventListener?: any }): Promise<void> {
    return new Promise<void>((resolve) => {
      const w: Waiter = { match, resolve, timer: null, settle: null, done: false };
      const finish = () => {
        if (w.done) return;
        w.done = true;
        if (w.timer) clearTimeout(w.timer);
        if (w.settle) clearTimeout(w.settle);
        this.waiters.delete(w);
        resolve();
      };
      w.resolve = finish;
      w.timer = setTimeout(finish, timeoutMs);
      this.waiters.add(w);
      // A cancelled client (Esc, disconnect) must not leave a resolver and a timer behind.
      try {
        signal?.addEventListener?.("abort", finish, { once: true });
      } catch {
        /* no signal available (e.g. inside browser_batch) */
      }
      (w as any).settleMs = settleMs;
    });
  }

  private wake(committed: Action[]): void {
    if (!this.waiters.size) return;
    for (const w of [...this.waiters]) {
      if (w.done || w.settle) continue;
      if (!committed.some(w.match)) continue;
      // Settle briefly so a burst returns as one batch instead of one action per round trip.
      const ms = (w as any).settleMs ?? 0;
      if (ms > 0) w.settle = setTimeout(() => w.resolve(), ms);
      else w.resolve();
    }
  }

  /** Release every pending waiter - used when the extension drops or the watch stops. */
  releaseWaiters(): void {
    for (const w of [...this.waiters]) w.resolve();
  }

  stop(now: number): void {
    this.pump(now, true);
    this.stopped = true;
    this.releaseWaiters();
    this.sink?.close();
  }
}

// ---------------------------------------------------------------------------
// Registry (module singleton - registerTools runs per MCP session, so this cannot live in a closure)
// ---------------------------------------------------------------------------

export class WatchRegistry {
  private sessions = new Map<string, WatchSession>();
  private byTab = new Map<number, string>();
  extensionConnected = true;

  /**
   * The EXTENSION mints the watchId and this adopts it, rather than each side generating its own.
   * The id travels on every streamed batch, so if the two disagreed, every lookup would silently
   * fall back to matching by tabId - which breaks the moment a watch spans more than one tab.
   */
  create(watchId: string, rootTabId: number, opts: WatchOpts, now: number): WatchSession {
    const s = new WatchSession(watchId, rootTabId, opts, now);
    this.sessions.set(s.watchId, s);
    this.byTab.set(rootTabId, s.watchId);
    return s;
  }

  get(watchId: string): WatchSession | undefined {
    return this.sessions.get(watchId);
  }

  forTab(tabId: number): WatchSession | undefined {
    const id = this.byTab.get(tabId);
    return id ? this.sessions.get(id) : undefined;
  }

  bindTab(tabId: number, watchId: string): void {
    this.byTab.set(tabId, watchId);
  }

  unbindTab(tabId: number): void {
    this.byTab.delete(tabId);
  }

  /** The single active watch, when there is exactly one - the common case for the no-args tools. */
  sole(): WatchSession | undefined {
    const live = [...this.sessions.values()].filter((s) => !s.isStopped);
    return live.length === 1 ? live[0] : live[live.length - 1];
  }

  list(): WatchSession[] {
    return [...this.sessions.values()];
  }

  remove(watchId: string): void {
    const s = this.sessions.get(watchId);
    if (!s) return;
    for (const [tab, id] of [...this.byTab]) if (id === watchId) this.byTab.delete(tab);
    this.sessions.delete(watchId);
  }

  /** Called from the hub when the extension socket goes up or down. */
  setConnected(connected: boolean, now: number): void {
    if (connected === this.extensionConnected) return;
    this.extensionConnected = connected;
    for (const s of this.sessions.values()) {
      if (s.isStopped) continue;
      if (!connected) {
        s.blindSince = now;
        s.releaseWaiters(); // a pending long poll must return "blind", not hang for 25s
      } else if (s.blindSince) {
        s.noteGap("extension-disconnected", now - s.blindSince, now);
        s.blindSince = null;
      }
    }
  }
}

export const watchRegistry = new WatchRegistry();

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}

function shortUrl(u: string, max = 72): string {
  if (!u) return "";
  let s = u;
  try {
    const parsed = new URL(u);
    s = parsed.pathname + parsed.search;
    if (!s || s === "/") s = parsed.host + parsed.pathname;
  } catch {
    /* not absolute - print as-is */
  }
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function elStr(el: ElementRef | undefined): string {
  if (!el) return "";
  let s = `<${el.tag}`;
  if (el.id) s += `#${el.id}`;
  else if (el.name) s += `[name=${el.name}]`;
  else if (el.type) s += `[${el.type}]`;
  s += ">";
  if (el.label) s += ` "${el.label.length > 48 ? el.label.slice(0, 47) + "…" : el.label}"`;
  return s;
}

export interface RenderOpts {
  multiTab: boolean;
  header?: string;
}

/** One line per action. Compact on purpose: textResult pretty-prints JSON, which is ~4x the tokens
 *  and reads far worse as a narrative. */
export function renderActions(actions: Action[], opts: RenderOpts): string {
  const lines: string[] = [];
  if (opts.header) lines.push(opts.header);
  for (const a of actions) {
    const prefix = opts.multiTab ? `[t${a.tabId}] ` : "";
    let body: string;
    switch (a.kind) {
      case "nav":
        body = `nav      ${shortUrl(a.url)}${a.via !== "load" ? `  (${a.via})` : ""}${a.title ? `  "${a.title}"` : ""}`;
        break;
      case "click":
        body = `click    ${elStr(a.target)}${a.button !== "left" ? `  (${a.button})` : ""}`;
        break;
      case "input":
        body = `input    ${elStr(a.target)} = ${JSON.stringify(a.value)}   (${a.chars} keys / ${(a.ms / 1000).toFixed(1)}s)`;
        break;
      case "submit":
        body = `submit   ${elStr(a.target)}${a.fields?.length ? `  ${a.fields.map((f) => `${f.name}=${JSON.stringify(f.value)}`).join(" ")}` : ""}`;
        break;
      case "key":
        body = `key      ${a.text}${a.repeat ? ` ×${a.repeat}` : ""}`;
        break;
      case "copy":
      case "paste":
        body = `${a.kind.padEnd(8)} ${elStr(a.target)}${a.chars ? `  (${a.chars} chars)` : ""}`;
        break;
      case "scroll":
        body = `scroll   y=${a.y} (${a.dy > 0 ? "+" : ""}${a.dy})`;
        break;
      case "console":
        body = `console  ${a.level} ${JSON.stringify(a.text)}${a.src ? `  ${shortUrl(a.src, 40)}:${a.line ?? 0}` : ""}`;
        break;
      case "net":
        body = `net      ${a.method} ${shortUrl(a.url)} → ${a.failed ? a.failed : a.status ?? "?"}${a.ms !== undefined ? ` (${a.ms}ms)` : ""}`;
        break;
      case "tab":
        body = `tab      ${a.event}${a.url ? `  ${shortUrl(a.url)}` : ""}`;
        break;
      case "gap":
        body = `gap      ${a.reason} (${(a.ms / 1000).toFixed(1)}s)${a.note ? `  ${a.note}` : ""}`;
        break;
      default:
        body = String((a as any).kind);
    }
    const cause = a.causedBy ? `   ← #${a.causedBy}` : "";
    const who = a.agent ? " [agent]" : "";
    lines.push(`${prefix}${hhmmss(a.ts)}  #${a.seq} ${body}${cause}${who}`);
  }
  return lines.join("\n");
}
