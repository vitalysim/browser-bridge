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

function startFixtureServer(): Promise<{ server: Server; sockets: Set<Socket>; port: number }> {
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
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
    this.serverLog = createWriteStream(join(ARTIFACTS, "server.log"));
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
      const res: any = await Promise.race([
        this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }),
        sleep(timeoutMs + 2_000).then(() => {
          throw Object.assign(new Error("transport wedged"), { code: -32001 });
        }),
      ]);
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
