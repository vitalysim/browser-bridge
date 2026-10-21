// Isolated e2e environment for browser-bridge:
//   fixture HTTP server  ->  bridge server (temp HOME, random port + token)  ->  Playwright Chromium
//   (temp profile, temp COPY of the built extension)  ->  MCP client over streamable HTTP.
// Nothing here touches the real ~/.browser-bridge, the real Chrome profile, or the bridge on 8765.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Dialog } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(E2E_DIR, "..");
const FIXTURES = join(E2E_DIR, "fixtures");
export const ARTIFACTS = join(E2E_DIR, ".artifacts");
const REAL_BRIDGE_PORT = 8765;

export const DEFAULT_CALL_TIMEOUT_MS = Number(process.env.E2E_CALL_TIMEOUT_MS ?? 20_000);

export interface CallResult {
  name: string;
  args: any;
  ms: number;
  isError: boolean;
  timedOut: boolean;
  text: string; // first text content (the server's JSON / "Error [...]" string)
  json: any; // parsed `text`, or undefined when it isn't JSON
  content: any[];
}

export class CallTimeoutError extends Error {
  constructor(public readonly result: CallResult) {
    super(`tool '${result.name}' did not answer within ${result.ms}ms (per-call timeout)`);
  }
}

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((res, rej) => {
      const s = createNetServer();
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as any).port as number;
        s.close(() => res(p));
      });
    });
    if (port !== REAL_BRIDGE_PORT) return port;
  }
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

// ---- devtools test routes ----
// Dynamic routes for e2e/src/devtools.test.ts (network/identity/authz/intercept/fuzz/WS/JWT/analyze).
// Deliberately vulnerable where a scenario needs it (BOLA, reflected XSS, weak headers). Loopback only.
import { createHash as dtCreateHash, createHmac as dtCreateHmac } from "node:crypto";

const DT_TOKENS: Record<string, string> = { "alice-token": "alice", "bob-token": "bob" };
const DT_SESSIONS: Record<string, string> = { "sess-alice": "alice", "sess-bob": "bob" };
const DT_ITEMS: Record<string, { id: number; owner: string; note: string }> = {
  "1": { id: 1, owner: "alice", note: "alice-private-note" },
  "2": { id: 2, owner: "bob", note: "bob-private-note" },
  "3": { id: 3, owner: "alice", note: "alice-second-note" },
};
const DT_JWT_SECRET = "devtools-e2e-secret";

function dtCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Bearer first, then the sid session cookie. Returns {user, via} or undefined. */
function dtUser(req: IncomingMessage): { user: string; via: "bearer" | "cookie" } | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  if (m && DT_TOKENS[m[1]]) return { user: DT_TOKENS[m[1]], via: "bearer" };
  const sid = dtCookies(req).sid;
  if (sid && DT_SESSIONS[sid]) return { user: DT_SESSIONS[sid], via: "cookie" };
  return undefined;
}

const dtB64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function dtJwt(payload: object, alg: "HS256" | "none"): string {
  const head = dtB64u(JSON.stringify({ alg, typ: "JWT" }));
  const body = dtB64u(JSON.stringify(payload));
  if (alg === "none") return `${head}.${body}.`;
  return `${head}.${body}.${dtB64u(dtCreateHmac("sha256", DT_JWT_SECRET).update(`${head}.${body}`).digest())}`;
}

function dtJson(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}

function dtReadBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolveBody(""));
  });
}

/** True when the path belongs to the devtools routes (handled asynchronously by devtoolsRoute). */
function isDevtoolsRoute(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/devtools/");
}

async function devtoolsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const p = url.pathname;
  const body = await dtReadBody(req);
  // Login: cookie session (sid HttpOnly) + a readable prefs cookie, and the user's bearer token.
  if (p === "/api/login") {
    const user = url.searchParams.get("user") ?? "";
    if (user !== "alice" && user !== "bob") return dtJson(res, 400, { error: "unknown user" });
    return dtJson(res, 200, { user, token: `${user}-token` }, {
      "set-cookie": [`sid=sess-${user}; Path=/; HttpOnly; SameSite=Lax`, `prefs=theme-${user}; Path=/; SameSite=Lax`],
    });
  }
  if (p === "/api/me") {
    const u = dtUser(req);
    return u ? dtJson(res, 200, { user: u.user, via: u.via }) : dtJson(res, 401, { error: "unauthorized" });
  }
  // BOLA: any authenticated user can read any item - no ownership check.
  let m = /^\/api\/items\/(\d+)$/.exec(p);
  if (m) {
    if (!dtUser(req)) return dtJson(res, 401, { error: "unauthorized" });
    const item = DT_ITEMS[m[1]];
    return item ? dtJson(res, 200, item) : dtJson(res, 404, { error: "no such item" });
  }
  // Correctly protected twin (negative control for authz_matrix).
  m = /^\/api\/secure-items\/(\d+)$/.exec(p);
  if (m) {
    const u = dtUser(req);
    if (!u) return dtJson(res, 401, { error: "unauthorized" });
    const item = DT_ITEMS[m[1]];
    if (!item) return dtJson(res, 404, { error: "no such item" });
    return item.owner === u.user ? dtJson(res, 200, item) : dtJson(res, 403, { error: "forbidden" });
  }
  // Echo: what the server actually received.
  if (p === "/api/echo") {
    return dtJson(res, 200, { method: req.method, url: req.url, headers: req.headers, cookies: dtCookies(req), body });
  }
  // Reflected parameter (unescaped). A quote breaks the "query" with a 500 + long SQL error.
  if (p === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    if (q.includes("'")) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`SQL syntax error near '${q}': ` + "You have an error in your SQL syntax; check the manual. ".repeat(12));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<p>Results for: ${q}</p>` + `<ul>${"<li>static result row</li>".repeat(10)}</ul>`);
    return;
  }
  // JWT issuer: HS256 by default; alg=none and exp=past for the risky variants.
  if (p === "/api/jwt") {
    const now = Math.floor(Date.now() / 1000);
    const sub = url.searchParams.get("sub") ?? "alice";
    const exp = url.searchParams.get("exp") === "past" ? now - 3600 : now + 3600;
    const alg = url.searchParams.get("alg") === "none" ? "none" : "HS256";
    return dtJson(res, 200, { token: dtJwt({ sub, role: sub === "alice" ? "admin" : "user", iat: now, exp }, alg) });
  }
  // A page with weak security headers, a non-HttpOnly session cookie, and leaked secrets in the body.
  if (p === "/devtools/analyze") {
    const jwt = dtJwt({ sub: "leak", iat: 1700000000 }, "HS256");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
      "x-powered-by": "Express 4.18.2",
      server: "nginx/1.18.0",
      "set-cookie": ["session_token=abc123; Path=/"],
    });
    res.end(
      `<!doctype html><html><head><title>analyze target</title><script src="/devtools/analyze-bundle.js"></script></head>` +
        `<body><h1>Analyze me</h1><script>window.cfg = {awsKey: "AKIAIOSFODNN7EXAMPLE", session: "${jwt}"};</script></body></html>`
    );
    return;
  }
  if (p === "/devtools/analyze-bundle.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    res.end(`window.bundleToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab";`);
    return;
  }
  dtJson(res, 404, { error: "no such devtools route" });
}

/** Minimal RFC 6455 echo server on /ws/echo: text frames come back as "echo:<payload>". */
function devtoolsUpgrade(req: IncomingMessage, socket: Socket): void {
  const url = new URL(req.url ?? "/", "http://x");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/ws/echo" || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = dtCreateHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (opcode: number, payload: Buffer) => {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]);
    socket.write(Buffer.concat([head, payload]));
  };
  let buf = Buffer.alloc(0);
  socket.on("error", () => undefined);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        socket.destroy(); // 64-bit lengths are not needed by the scenarios
        return;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i % 4)];
      buf = buf.subarray(off + len);
      if (opcode === 0x1) send(0x1, Buffer.from("echo:" + payload.toString("utf8")));
      else if (opcode === 0x9) send(0xa, payload);
      else if (opcode === 0x8) {
        send(0x8, payload.subarray(0, 2));
        socket.end();
        return;
      }
    }
  });
}
// ---- end devtools test routes ----

function startFixtureServer(): Promise<{ server: Server; sockets: Set<Socket>; port: number }> {
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    // ---- devtools test routes ----
    if (isDevtoolsRoute(url.pathname)) {
      void devtoolsRoute(req, res, url).catch(() => res.destroy());
      return;
    }
    // ---- end devtools test routes ----
    if (url.pathname === "/hang") {
      // Send headers + part of a document, then never finish. The socket is destroyed at teardown.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.write("<!doctype html><html><body><p>still loading");
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "") || "index.html";
    const file = join(FIXTURES, rel);
    if (!file.startsWith(FIXTURES) || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  // ---- devtools test routes ----
  server.on("upgrade", (req, socket) => devtoolsUpgrade(req, socket as Socket));
  // ---- end devtools test routes ----
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res({ server, sockets, port: (server.address() as any).port }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs: number, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      lastErr = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}${lastErr ? ` (last error: ${String(lastErr)})` : ""}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => (console.error(`[e2e] ${what} timed out`), r(undefined)), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class Harness {
  readonly token = randomBytes(24).toString("hex");
  bridgePort = 0;
  fixturePort = 0;
  tmpRoot = "";
  userDataDir = "";
  headless = process.env.E2E_HEADED !== "1";
  toolSchemas = new Map<string, any>();
  pendingDialogs: Dialog[] = [];
  seenDialogs: { type: string; message: string; at: number }[] = [];

  private fixture?: { server: Server; sockets: Set<Socket> };
  private serverProc?: ChildProcess;
  private serverLog?: WriteStream;
  context?: BrowserContext;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tornDown = false;
  private exitHook = () => this.killSync();
  private browserProc?: ChildProcess;

  /**
   * rawBrowser: launch Chromium WITHOUT Playwright attached to its pages. Playwright enables
   * Emulation.setFocusEmulationEnabled on every page it controls, which in Chromium counts as a
   * "capturer" and keeps background tabs visibilityState:'visible' with rAF running - so a
   * hidden-tab scenario cannot be reproduced under Playwright. Raw mode spawns the same Chromium
   * build directly, configures the extension over a one-off CDP session to its service worker only,
   * and detaches. No dialog tracking in this mode.
   */
  constructor(readonly opts: { rawBrowser?: boolean; logName?: string } = {}) {}

  fixtureUrl(path: string): string {
    return `http://127.0.0.1:${this.fixturePort}/${path.replace(/^\//, "")}`;
  }

  async setup(): Promise<void> {
    process.once("exit", this.exitHook);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        void this.teardown().finally(() => process.exit(130));
      });
    }
    mkdirSync(ARTIFACTS, { recursive: true });
    this.tmpRoot = mkdtempSync(join(tmpdir(), "bb-e2e-"));
    const fakeHome = join(this.tmpRoot, "home");
    mkdirSync(fakeHome, { recursive: true });

    // 1. fixtures
    const fx = await startFixtureServer();
    this.fixture = fx;
    this.fixturePort = fx.port;

    // 2. bridge server, fully sandboxed: temp HOME (it writes ~/.browser-bridge/*), random port + token
    const serverEntry = join(REPO, "server", "dist", "index.js");
    if (!existsSync(serverEntry)) throw new Error(`server build missing: ${serverEntry} (run npm run build:deps)`);
    this.bridgePort = await freePort();
    if (this.bridgePort === REAL_BRIDGE_PORT) throw new Error("refusing to use the real bridge port");
    this.serverLog = createWriteStream(join(ARTIFACTS, this.opts.logName ?? "server.log"));
    this.serverProc = spawn(process.execPath, [serverEntry], {
      cwd: join(REPO, "server"),
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, BRIDGE_PORT: String(this.bridgePort), BRIDGE_TOKEN: this.token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.serverProc.stdout!.pipe(this.serverLog, { end: false });
    this.serverProc.stderr!.pipe(this.serverLog, { end: false });
    await waitFor("bridge /health", async () => (await this.health()).ok, 15_000);

    // 3. Chromium (Playwright's bundled build) with a temp profile + a temp COPY of the extension
    const extSrc = join(REPO, "extension");
    if (!existsSync(join(extSrc, "background.js"))) throw new Error("extension build missing: extension/background.js (run npm run build:deps)");
    const extDir = join(this.tmpRoot, "extension");
    cpSync(extSrc, extDir, {
      recursive: true,
      filter: (src) => !/[/\\](node_modules|src)([/\\]|$)/.test(src.slice(extSrc.length)) && !/\.(ts|mjs)$|package(-lock)?\.json$|tsconfig\.json$/.test(src),
    });
    this.userDataDir = join(this.tmpRoot, "profile");
    if (this.opts.rawBrowser) {
      await this.launchRaw(extDir);
    } else {
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        channel: "chromium",
        headless: this.headless,
        viewport: null,
        args: [
          `--disable-extensions-except=${extDir}`,
          `--load-extension=${extDir}`,
          "--window-size=1280,900",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
      // Real Chrome never auto-dismisses a JS dialog; Playwright does when nobody listens. Listening
      // (and NOT answering) keeps the real-browser behaviour; scenarios answer them explicitly.
      this.context.on("dialog", (d) => {
        this.pendingDialogs.push(d);
        this.seenDialogs.push({ type: d.type(), message: d.message(), at: Date.now() });
      });

      let sw = this.context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
      if (!sw) sw = await this.context.waitForEvent("serviceworker", { timeout: 15_000 });
      await sw.evaluate(
        ({ token, port }) => (globalThis as any).chrome.storage.local.set({ token, port }),
        { token: this.token, port: this.bridgePort }
      );
    }
    await waitFor("extensionConnected:true", async () => (await this.health()).extensionConnected === true, 20_000);

    // 4. MCP client
    this.transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${this.bridgePort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    });
    this.client = new Client({ name: "browser-bridge-e2e", version: "0.0.0" });
    await this.client.connect(this.transport);
    const { tools } = await this.client.listTools();
    for (const t of tools) this.toolSchemas.set(t.name, t.inputSchema);
  }

  private async launchRaw(extDir: string): Promise<void> {
    mkdirSync(this.userDataDir, { recursive: true });
    // CDP over --remote-debugging-pipe (fds 3/4), as Playwright does: extension APIs are hidden from a
    // --remote-debugging-port client, but a pipe client may evaluate in the extension's worker.
    const proc = spawn(
      chromium.executablePath(),
      [
        `--user-data-dir=${this.userDataDir}`,
        "--remote-debugging-pipe",
        ...(this.headless ? ["--headless=new"] : []),
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        "--window-size=1280,900",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        // Chrome 137+ ignores --load-extension unless this feature is off.
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-component-update",
        "--password-store=basic",
        "--use-mock-keychain",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
    );
    this.browserProc = proc;
    const out = proc.stdio[3] as NodeJS.WritableStream;
    const inp = proc.stdio[4] as NodeJS.ReadableStream;
    let id = 0;
    let buf = "";
    const pending = new Map<number, (m: any) => void>();
    inp.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\0")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(raw);
          if (m.id != null) pending.get(m.id)?.(m);
        } catch {}
      }
    });
    inp.on("error", () => {});
    out.on("error", () => {});
    const send = (method: string, params: any = {}, sessionId?: string) =>
      new Promise<any>((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => (pending.delete(i), rej(new Error(`${method}: no answer in 10s`))), 10_000);
        pending.set(i, (m) => {
          clearTimeout(timer);
          pending.delete(i);
          if (m.error) rej(new Error(`${method}: ${m.error.message}`));
          else res(m.result);
        });
        out.write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
      });
    // Our SW is a chrome-extension://<id>/background.js worker that has chrome.debugger + storage
    // (Chrome's own component extensions also run background.js workers). It may need a moment
    // before chrome.storage is usable, so attach + evaluate until the write succeeds.
    const expr = `globalThis.chrome?.debugger && chrome.storage ? chrome.storage.local.set(${JSON.stringify({ token: this.token, port: this.bridgePort })}).then(() => true) : false`;
    await waitFor(
      "extension service worker configured",
      async () => {
        const infos = (await send("Target.getTargets")).targetInfos as any[];
        for (const sw of infos.filter((t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url))) {
          const { sessionId } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
          try {
            const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true }, sessionId);
            if (r?.result?.value === true) return true;
          } finally {
            await send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
          }
        }
        return false;
      },
      20_000
    );
    // Kept open (browser-level, attached to no page) so a scenario can attach to a page itself via
    // rawCdp when it needs to measure something the bridge does not expose.
    this.rawCdp = send;
  }

  rawCdp?: (method: string, params?: any, sessionId?: string) => Promise<any>;

  async health(): Promise<{ ok?: boolean; extensionConnected?: boolean }> {
    const r = await fetch(`http://127.0.0.1:${this.bridgePort}/health`);
    return (await r.json()) as any;
  }

  hasTool(name: string): boolean {
    return this.toolSchemas.has(name);
  }

  hasParam(tool: string, param: string): boolean {
    return !!this.toolSchemas.get(tool)?.properties?.[param];
  }

  /** Call an MCP tool with a hard per-call timeout. A timeout throws CallTimeoutError unless allowTimeout. */
  async call(name: string, args: any = {}, opts: { timeoutMs?: number; allowTimeout?: boolean } = {}): Promise<CallResult> {
    if (!this.client) throw new Error("harness not set up");
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const t0 = Date.now();
    const base = { name, args, isError: false, timedOut: false, text: "", json: undefined, content: [] as any[] };
    try {
      // Belt and braces: the SDK's own request timeout (which also sends notifications/cancelled), and
      // a race in case the transport itself wedges.
      // The race timer is cleared once the call settles (and unref'd), so a long per-call timeout can't
      // keep the test process alive for minutes after teardown.
      let wedge: ReturnType<typeof setTimeout> | undefined;
      const res: any = await Promise.race([
        this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }),
        new Promise((_, reject) => {
          wedge = setTimeout(() => reject(Object.assign(new Error("transport wedged"), { code: -32001 })), timeoutMs + 2_000);
          wedge.unref?.();
        }),
      ]).finally(() => clearTimeout(wedge));
      const text = (res.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { ...base, ms: Date.now() - t0, isError: !!res.isError, text, json, content: res.content ?? [] };
    } catch (e: any) {
      const ms = Date.now() - t0;
      const timedOut = e?.code === -32001 || /timed? ?out/i.test(String(e?.message));
      if (!timedOut) throw e;
      const r: CallResult = { ...base, ms, timedOut: true, text: `TIMEOUT after ${ms}ms` };
      if (opts.allowTimeout) return r;
      throw new CallTimeoutError(r);
    }
  }

  async dismissPendingDialogs(accept = false): Promise<number> {
    let n = 0;
    while (this.pendingDialogs.length) {
      const d = this.pendingDialogs.shift()!;
      try {
        await (accept ? d.accept() : d.dismiss());
        n++;
      } catch {
        /* page already gone */
      }
    }
    return n;
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    await this.dismissPendingDialogs().catch(() => undefined);
    if (this.transport) await withTimeout(this.transport.terminateSession().catch(() => undefined), 3_000, "mcp terminateSession");
    if (this.client) await withTimeout(this.client.close().catch(() => undefined), 3_000, "mcp close");
    if (this.context) await withTimeout(this.context.close().catch(() => undefined), 10_000, "chromium close");
    if (this.browserProc && this.browserProc.exitCode === null) {
      const exited = new Promise((r) => this.browserProc!.once("exit", r));
      this.browserProc.kill("SIGTERM");
      await withTimeout(exited, 5_000, "raw chromium SIGTERM");
    }
    this.killChromiumByProfile();
    if (this.serverProc && this.serverProc.exitCode === null) {
      const exited = new Promise((r) => this.serverProc!.once("exit", r));
      this.serverProc.kill("SIGTERM");
      if (!(await withTimeout(exited.then(() => true), 4_000, "bridge server SIGTERM"))) this.serverProc.kill("SIGKILL");
    }
    this.serverLog?.end();
    if (this.fixture) {
      for (const s of this.fixture.sockets) s.destroy();
      await withTimeout(new Promise((r) => this.fixture!.server.close(r)), 3_000, "fixture server close");
    }
    if (this.tmpRoot) {
      try {
        rmSync(this.tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    process.removeListener("exit", this.exitHook);
  }

  /** Last resort for a Chromium that outlived context.close(): match our unique temp profile path only. */
  private killChromiumByProfile(): void {
    if (!this.userDataDir) return;
    try {
      execFileSync("pkill", ["-9", "-f", `--user-data-dir=${this.userDataDir}`], { stdio: "ignore" });
    } catch {
      /* nothing matched - the normal case */
    }
  }

  private killSync(): void {
    try {
      if (this.serverProc && this.serverProc.exitCode === null) this.serverProc.kill("SIGKILL");
    } catch {}
    this.killChromiumByProfile();
  }
}

export function trim(s: string, n = 400): string {
  s = String(s ?? "").replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;
}
