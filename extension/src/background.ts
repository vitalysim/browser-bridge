/// <reference types="chrome" />

const VERSION = "0.4.6";
const PING_INTERVAL_MS = 20_000; // WS traffic resets the MV3 service-worker idle timer (Chrome 116+)
const RECONNECT_MAX_MS = 30_000;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(status: string, detail = "") {
  chrome.storage.local.set({ bbStatus: status, bbDetail: detail, bbUpdated: Date.now() });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { token, port } = await chrome.storage.local.get({ token: "", port: 8765 });
  if (!token) {
    setStatus("no-token", "Set the server token in the extension options.");
    return;
  }
  setStatus("connecting");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  ws = socket;

  socket.onopen = () => {
    reconnectDelay = 1_000;
    setStatus("connected");
    socket.send(JSON.stringify({ type: "hello", version: VERSION }));
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
    try {
      const result = await dispatch(msg.method, msg.params ?? {});
      socket.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (err) {
      socket.send(JSON.stringify({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  };

  socket.onclose = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (ws === socket) ws = null;
    setStatus("disconnected", "Will retry automatically.");
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose fires next; nothing to do here
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
  // Injected functions signal failure by RETURNING { error } — never by throwing, because
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
  for (const r of results) {
    const v: any = r?.result;
    if (!v || typeof v !== "object") continue;
    if (typeof v.error === "string") throw new Error(v.error);
    if (v.notFound) continue;
    acted = v;
  }
  if (acted) return acted;
  throw new Error("Element not found in any frame — take a fresh snapshot");
}

// ---------- injected page functions ----------
// These are serialized and run IN THE PAGE, so each must be fully self-contained:
// no references to module-scope helpers (esbuild would leave dangling names). Shadow-DOM
// support is via a local deep-walk that recurses into open shadowRoots (closed roots are
// inaccessible by design). Failure is signalled by RETURNING { error } / { notFound }.

function bbPageText() {
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n"),
  };
}

function bbSnapshot(refOffset: number) {
  const SEL =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
  const all: Element[] = [];
  const walk = (root: Document | ShadowRoot) => {
    let els: NodeListOf<Element>;
    try {
      els = root.querySelectorAll("*");
    } catch {
      return;
    }
    for (const el of Array.from(els)) {
      all.push(el);
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) walk(sr);
    }
  };
  walk(document);
  const items: any[] = [];
  let n = 0;
  for (const el of all) {
    const h = el as HTMLElement;
    let ok = false;
    try {
      ok = h.matches(SEL);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    if ((h as any).checkVisibility && !(h as any).checkVisibility()) continue;
    n++;
    const ref = refOffset + n;
    h.setAttribute("data-bb-ref", String(ref));
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
    items.push(entry);
    if (n >= 400) break;
  }
  return { url: location.href, count: items.length, elements: items };
}

function bbInteract(action: string, ref: number | null, sel: string | null, value: string | null) {
  // Self-contained shadow-piercing finder (injected funcs may not reference module-scope helpers).
  const deepFind = (pred: (e: Element) => boolean): HTMLElement | null => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length) {
      const root = stack.pop()!;
      let els: NodeListOf<Element>;
      try {
        els = root.querySelectorAll("*");
      } catch {
        continue;
      }
      for (const el of Array.from(els)) {
        try {
          if (pred(el)) return el as HTMLElement;
        } catch {}
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) stack.push(sr);
      }
    }
    return null;
  };
  const el =
    ref != null
      ? deepFind((e) => e.getAttribute("data-bb-ref") === String(ref))
      : deepFind((e) => {
          try {
            return (e as HTMLElement).matches(sel!);
          } catch {
            return false;
          }
        });
  if (!el) return { notFound: true };

  const setNativeValue = (target: HTMLElement, v: string): boolean => {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(target, v);
      else (target as any).value = v;
    } else if (target instanceof HTMLSelectElement) {
      (target as HTMLSelectElement).value = v;
    } else if (target.isContentEditable) {
      target.textContent = v;
    } else {
      return false;
    }
    return true;
  };

  if (action === "click") {
    el.scrollIntoView({ block: "center" });
    el.click();
    return { clicked: true, tag: el.tagName.toLowerCase(), label: (el.innerText || "").trim().slice(0, 80) };
  }
  if (action === "hover") {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const base: any = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerover", base));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new MouseEvent("mouseenter", base));
    el.dispatchEvent(new MouseEvent("mousemove", base));
    return { hovered: true, tag: el.tagName.toLowerCase() };
  }
  if (action === "fill") {
    el.focus();
    if (!setNativeValue(el, value ?? "")) return { error: `Element <${el.tagName.toLowerCase()}> is not fillable` };
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, tag: el.tagName.toLowerCase() };
  }
  if (action === "type") {
    el.focus();
    const text = value ?? "";
    let cur = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent ?? "";
    for (const ch of Array.from(text)) {
      const opts: any = { key: ch, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      cur += ch;
      setNativeValue(el, cur);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: text.length, tag: el.tagName.toLowerCase() };
  }
  return { error: `Unknown action: ${action}` };
}

function bbFileUpload(sel: string | null, ref: number | null, filename: string, mimeType: string | null, b64: string) {
  const deepFind = (pred: (e: Element) => boolean): HTMLElement | null => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length) {
      const root = stack.pop()!;
      let els: NodeListOf<Element>;
      try {
        els = root.querySelectorAll("*");
      } catch {
        continue;
      }
      for (const el of Array.from(els)) {
        try {
          if (pred(el)) return el as HTMLElement;
        } catch {}
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) stack.push(sr);
      }
    }
    return null;
  };
  const el =
    ref != null
      ? deepFind((e) => e.getAttribute("data-bb-ref") === String(ref))
      : deepFind((e) => {
          try {
            return (e as HTMLElement).matches(sel!);
          } catch {
            return false;
          }
        });
  if (!el) return { notFound: true };
  if (!(el instanceof HTMLInputElement) || el.type !== "file") return { error: "Target is not an <input type=file>" };
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { error: "Invalid base64 content" };
  }
  const file = new File([bytes as BlobPart], filename, { type: mimeType || "application/octet-stream" });
  const dt = new DataTransfer();
  dt.items.add(file);
  (el as HTMLInputElement).files = dt.files;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { uploaded: filename, size: bytes.length };
}

function waitForComplete(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve anyway; caller can still read partial page
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Back/forward via the page's own history — chrome.tabs.goBack/goForward fail spuriously
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
  while (Date.now() < deadline) {
    await sleep(150);
    const t = await chrome.tabs.get(tab.id!);
    if (t.url && t.url !== before) {
      navigated = true;
      await sleep(300); // brief settle
      break;
    }
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
const IDLE_DETACH_MS = 5 * 60_000;

interface NetEntry {
  requestId: string;
  method?: string;
  url?: string;
  type?: string;
  status?: number;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  timing?: any;
  finished?: boolean;
  failed?: string;
  ts?: number;
}

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

interface Session {
  attachedAt: number;
  lastUsedAt: number;
  net: NetEntry[];
  netOn: boolean;
  netFilter?: string; // if set, only buffer requests whose URL contains this
  extra: Map<string, ExtraInfo>; // requestId -> raw ExtraInfo headers (incl. Set-Cookie / sent Cookie)
  wsUrls: Map<string, string>; // ws requestId -> url
  wsFrames: WsFrame[];
  refNodes: Map<number, number>; // deep-snapshot ref -> CDP backendNodeId
  deepGen: number; // bumped on every deep snapshot; folded into ref numbers so stale/foreign refs can't collide
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

async function ensureAttached(tabId: number): Promise<Session> {
  let s = sessions.get(tabId);
  if (!s) {
    await attach(tabId);
    await cmd(tabId, "DOM.enable");
    await cmd(tabId, "Page.enable");
    s = {
      attachedAt: Date.now(),
      lastUsedAt: Date.now(),
      net: [],
      netOn: false,
      extra: new Map(),
      wsUrls: new Map(),
      wsFrames: [],
      refNodes: new Map(),
      deepGen: 0,
    };
    sessions.set(tabId, s);
  }
  s.lastUsedAt = Date.now();
  return s;
}

async function detachSession(tabId: number): Promise<void> {
  sessions.delete(tabId);
  try {
    await new Promise<void>((resolve) => chrome.debugger.detach({ tabId }, () => resolve()));
  } catch {
    /* already gone */
  }
}

function idleSweep() {
  const now = Date.now();
  for (const [tabId, s] of sessions) {
    if (now - s.lastUsedAt > IDLE_DETACH_MS) void detachSession(tabId);
  }
}

// Buffer Network.* CDP events into the per-tab session (listener registered synchronously below).
function onDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params: any) {
  const tabId = source.tabId;
  if (tabId == null) return;
  const s = sessions.get(tabId);
  if (!s || !s.netOn) return;
  const find = (id: string) => s.net.find((e) => e.requestId === id);
  if (method === "Network.requestWillBeSent") {
    const url = params.request?.url ?? "";
    if (s.netFilter && !url.includes(s.netFilter)) return;
    if (s.net.length >= NET_MAX_ENTRIES) s.net.shift();
    s.net.push({
      requestId: params.requestId,
      method: params.request?.method,
      url: params.request?.url,
      type: params.type,
      requestHeaders: params.request?.headers,
      requestBody: params.request?.postData ? String(params.request.postData).slice(0, BODY_CAP) : undefined,
      ts: Date.now(),
    });
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
  } else if (method === "Network.responseReceivedExtraInfo") {
    // raw response headers incl. Set-Cookie (dropped from Network.responseReceived.headers)
    const x = s.extra.get(params.requestId) ?? {};
    x.respHeaders = params.headers;
    const sc = params.headers?.["set-cookie"] ?? params.headers?.["Set-Cookie"];
    if (sc) x.setCookie = String(sc).split("\n");
    s.extra.set(params.requestId, x);
  } else if (method === "Network.loadingFinished") {
    const e = find(params.requestId);
    if (e) e.finished = true;
  } else if (method === "Network.loadingFailed") {
    const e = find(params.requestId);
    if (e) e.failed = params.errorText || "failed";
  } else if (method === "Network.webSocketCreated") {
    s.wsUrls.set(params.requestId, params.url);
    pushWs(s, { requestId: params.requestId, url: params.url, dir: "create", ts: Date.now() });
  } else if (method === "Network.webSocketFrameSent") {
    pushWs(s, wsFrame(s, params, "sent"));
  } else if (method === "Network.webSocketFrameReceived") {
    pushWs(s, wsFrame(s, params, "received"));
  } else if (method === "Network.webSocketClosed") {
    pushWs(s, { requestId: params.requestId, url: s.wsUrls.get(params.requestId), dir: "close", ts: Date.now() });
  } else if (method === "Network.eventSourceMessageReceived") {
    pushWs(s, {
      requestId: params.requestId,
      url: s.wsUrls.get(params.requestId),
      dir: "sse",
      payload: String(params.data ?? "").slice(0, BODY_CAP),
      ts: Date.now(),
    });
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

async function getResponseBody(tabId: number, requestId: string): Promise<{ body: string; base64: boolean }> {
  const r = await cmd(tabId, "Network.getResponseBody", { requestId });
  let body = r?.body ?? "";
  if (typeof body === "string" && body.length > BODY_CAP) body = body.slice(0, BODY_CAP) + "\n…[truncated]";
  return { body, base64: !!r?.base64Encoded };
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
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
    const e = s?.net.find((x) => x.requestId === params.requestId);
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
    if (!id) throw new Error(`identity '${params.identity}' not captured — call identity_capture first`);
    if (id.bearer) {
      headers["authorization"] = id.bearer;
      credentials = "omit";
    } else {
      note = `identity '${params.identity}' has no bearer; used the current tab session (cookie-jar swap not supported via background fetch)`;
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
      `ref ${ref} is from a plain snapshot() call, not snapshot({deep:true}) — trusted actions require a ref from a deep snapshot. Take a fresh snapshot with deep:true and use the ref it returns.`
    );
  }
  const backendNodeId = s?.refNodes.get(ref);
  if (!backendNodeId) throw new Error(`ref ${ref} is not in the current deep snapshot for this tab (it may be from an older, since-replaced snapshot) — take a fresh snapshot with deep:true`);
  const { nodeIds } = await cmd(tabId, "DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] });
  const nodeId = nodeIds?.[0];
  if (!nodeId) throw new Error(`ref ${ref} node is gone — take a fresh snapshot`);
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

// Full-page / high-DPI / element screenshot via CDP Page.captureScreenshot (shows the debugger banner).
// `scale` is the FINAL output multiplier over CSS pixels (default 1 = CSS-resolution; 2 = retina).
// CDP's clip.scale multiplies on top of the display's device pixel ratio, so we divide the DPR out to
// keep output dimensions predictable (= CSS size × scale) and default file sizes reasonable.
async function cdpScreenshot(tab: chrome.tabs.Tab, params: any): Promise<any> {
  const tabId = tab.id!;
  // Surface capture requires the tab to be visible/active, else it returns empty.
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId!, { focused: true }).catch(() => {});
  await ensureAttached(tabId);
  await sleep(250);

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
  // Large PNGs can exceed chrome.debugger's result-size limit and come back empty — fall back to JPEG.
  if (!data && format === "png") {
    data = await capture("jpeg", 92);
    outFormat = "jpeg";
  }
  if (!data) throw new Error("Screenshot returned empty — the page may be too large; try a smaller scale, a selector, or format:'jpeg'.");
  return { base64: data, format: outFormat, fellBackToJpeg: outFormat !== format || undefined };
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

async function dispatch(method: string, params: any): Promise<any> {
  switch (method) {
    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
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
      const results = await injectAllFrames(tab, bbPageText);
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
      assertScriptable(tab);
      let frames: { frameId: number }[];
      try {
        frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id! })) ?? [{ frameId: 0 }];
      } catch {
        frames = [{ frameId: 0 }];
      }
      let offset = 0;
      const all: any[] = [];
      for (const f of frames) {
        let res: chrome.scripting.InjectionResult[];
        try {
          res = await chrome.scripting.executeScript({
            target: { tabId: tab.id!, frameIds: [f.frameId] },
            func: bbSnapshot as any,
            args: [offset],
          });
        } catch {
          continue; // frame not injectable (about:blank, sandboxed, gone)
        }
        const v = res?.[0]?.result as any;
        if (!v || !v.elements) continue;
        for (const e of v.elements) all.push(f.frameId === 0 ? e : { ...e, frameId: f.frameId });
        offset += v.count;
        if (all.length >= 400) break;
      }
      return { url: tab.url, count: all.length, elements: all };
    }

    case "click": {
      const tab = await targetTab(params.tabId);
      if (params.trusted) return trustedAction(tab.id!, "click", params.ref, params.selector);
      return injectAllAggregate(tab, bbInteract, ["click", params.ref, params.selector, null]);
    }

    case "fill":
      return injectAllAggregate(await targetTab(params.tabId), bbInteract, ["fill", params.ref, params.selector, params.value]);

    case "hover": {
      const tab = await targetTab(params.tabId);
      if (params.trusted) return trustedAction(tab.id!, "hover", params.ref, params.selector);
      return injectAllAggregate(tab, bbInteract, ["hover", params.ref, params.selector, null]);
    }

    case "type": {
      const tab = await targetTab(params.tabId);
      if (params.trusted) return trustedAction(tab.id!, "type", params.ref, params.selector, params.text);
      return injectAllAggregate(tab, bbInteract, ["type", params.ref, params.selector, params.text]);
    }

    case "file_upload": {
      const tab = await targetTab(params.tabId);
      if (params.path) {
        await ensureAttached(tab.id!);
        const nodeId = await cdpResolve(tab.id!, params.ref ?? null, params.selector ?? null);
        await cmd(tab.id!, "DOM.setFileInputFiles", { files: [params.path], nodeId });
        return { uploaded: params.path, trusted: true };
      }
      return injectAllAggregate(tab, bbFileUpload, [
        params.selector,
        params.ref,
        params.filename,
        params.mimeType,
        params.base64,
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
      await cmd(tab.id!, "Network.enable");
      s.net = [];
      s.extra = new Map();
      s.wsUrls = new Map();
      s.wsFrames = [];
      s.netOn = true;
      s.netFilter = params.urlFilter || undefined;
      return { capturing: true, tabId: tab.id!, note: "Now navigate/reload the tab to capture its load traffic (incl. Set-Cookie and WebSocket frames). Banner is showing while attached." };
    }

    case "net_get_requests": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s) throw new Error("Not capturing on this tab — call net_capture_start first.");
      s.lastUsedAt = Date.now();
      const filter: string | undefined = params.urlFilter;
      let entries = s.net.filter((e) => !filter || (e.url ?? "").includes(filter));
      const limit = params.limit ?? 100;
      if (entries.length > limit) entries = entries.slice(-limit);
      const out: any[] = [];
      for (const e of entries) {
        const x = s.extra.get(e.requestId);
        const row: any = {
          requestId: e.requestId,
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
        if (params.includeBodies && e.finished && !e.failed) {
          try {
            const b = await getResponseBody(tab.id!, e.requestId);
            row.responseBody = b.body;
            row.responseBodyBase64 = b.base64;
          } catch (err) {
            row.responseBodyError = err instanceof Error ? err.message : String(err);
          }
        }
        out.push(row);
      }
      return { count: out.length, totalBuffered: s.net.length, requests: out };
    }

    case "net_get_body": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s) throw new Error("Not capturing on this tab — call net_capture_start first.");
      s.lastUsedAt = Date.now();
      const b = await getResponseBody(tab.id!, params.requestId);
      return { requestId: params.requestId, base64: b.base64, body: b.body };
    }

    case "net_get_ws_frames": {
      const tab = await targetTab(params.tabId);
      const s = sessions.get(tab.id!);
      if (!s) throw new Error("Not capturing on this tab — call net_capture_start first.");
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
        for (let i = s.net.length - 1; i >= 0 && !bearer; i--) {
          const h = s.extra.get(s.net[i].requestId)?.reqHeaders ?? s.net[i].requestHeaders;
          if (h) bearer = (h as any).authorization ?? (h as any).Authorization;
        }
      }
      identities.set(params.name, { cookies, storage, bearer });
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

    case "identity_purge":
      return { purged: identities.delete(params.name), name: params.name };

    case "replay_request": {
      const tab = await targetTab(params.tabId);
      return doReplay(tab, params);
    }

    case "authz_matrix": {
      const tab = await targetTab(params.tabId);
      const reqIds: string[] = params.requestIds ?? [];
      const idents: string[] = params.identities ?? [];
      if (!reqIds.length || !idents.length) throw new Error("Provide requestIds[] and identities[]");
      const s = sessions.get(tab.id!);
      const rows: any[] = [];
      const runOne = async (rid: string, urlOverride?: string, label?: string) => {
        const e = s?.net.find((x) => x.requestId === rid);
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
          const e = s?.net.find((x) => x.requestId === rid);
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
        return s
          ? { tabId: params.tabId, attached: true, capturing: s.netOn, bufferedRequests: s.net.length, deepRefs: s.refNodes.size, idleMs: Date.now() - s.lastUsedAt }
          : { tabId: params.tabId, attached: false };
      }
      return {
        sessions: [...sessions.entries()].map(([tabId, s]) => ({
          tabId,
          capturing: s.netOn,
          bufferedRequests: s.net.length,
          idleMs: Date.now() - s.lastUsedAt,
        })),
      };
    }

    case "press_key": {
      const tab = await targetTab(params.tabId);
      return inject(
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
    }

    case "scroll": {
      const tab = await targetTab(params.tabId);
      return inject(
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
    }

    case "screenshot": {
      const tab = await targetTab(params.tabId);
      const rich = params.fullPage || params.selector || params.scale || (params.format && params.format !== "png");
      if (rich) return cdpScreenshot(tab, params);
      // default: banner-free visible-viewport PNG
      await chrome.tabs.update(tab.id!, { active: true });
      await chrome.windows.update(tab.windowId!, { focused: true });
      await sleep(350);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "png" });
      return { base64: dataUrl.replace(/^data:image\/png;base64,/, ""), format: "png" };
    }

    case "eval_js": {
      const tab = await targetTab(params.tabId);
      const result = await inject(
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
      if (result && (result as any).error) throw new Error((result as any).error);
      return result;
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
        await sleep(250);
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for selector: ${params.selector}`);
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
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) sessions.delete(source.tabId); // user closed banner / DevTools opened / tab gone
});
chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port)) {
    ws?.close();
    reconnectDelay = 1_000;
    connect();
  }
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cmd === "reconnect") {
    ws?.close();
    reconnectDelay = 1_000;
    connect();
    sendResponse({ ok: true });
  }
  return false;
});

connect();
