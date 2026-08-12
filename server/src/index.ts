import express from "express";
import { createServer } from "http";
import { randomUUID, randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ExtensionHub } from "./hub.js";
import { registerTools, startWatchNetCapture } from "./tools.js";
import { renderActions, watchRegistry } from "./watch.js";

const PORT = Number(process.env.BRIDGE_PORT ?? 8765);
const HOST = "127.0.0.1";

// Single source of truth for the server version - read from package.json (../package.json
// relative to the compiled dist/index.js) so it can't drift from the release number.
const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return String(JSON.parse(readFileSync(pkgPath, "utf8")).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

function loadToken(): string {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const dir = join(homedir(), ".browser-bridge");
  const file = join(dir, "token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    mkdirSync(dir, { recursive: true });
    const token = randomBytes(16).toString("hex");
    writeFileSync(file, token + "\n", { mode: 0o600 });
    return token;
  }
}

const token = loadToken();

// Ensure the playbooks + recordings homes exist (advertised to agents via the MCP instructions below).
try {
  mkdirSync(join(homedir(), ".browser-bridge", "playbooks"), { recursive: true });
  mkdirSync(join(homedir(), ".browser-bridge", "recordings"), { recursive: true });
} catch {
  /* best-effort */
}

// Delivered to every connected agent (Claude Code + Codex) in the MCP initialize response.
const PLAYBOOK_INSTRUCTIONS =
  "Repeatable browser tasks can be saved as reusable 'playbooks' (Markdown) under ~/.browser-bridge/playbooks/*.md " +
  "(or ./playbooks/*.md in a project). Before a repeatable task, check there for a matching playbook and run it " +
  "(dry-run first). After resolving a new repeatable task, offer to save it: use playbook_record_start/stop to " +
  "capture a draft, then distill it and playbook_save. Format, execution protocol, and safety rules are in " +
  "docs/PLAYBOOKS.md. Never store secrets, cookies, or ephemeral refs/requestIds in a playbook; destructive or " +
  "irreversible steps require explicit confirmation. " +
  "To record a live interaction as a replayable video, use session_record_start / session_record_stop (produces a " +
  "self-contained HTML replay with a play/scrub timeline); see docs/RECORDING.md. " +
  "WATCH MODE: when the user wants you to follow along while THEY browse ('watch what I do', 'monitor this site', " +
  "'tell me what that click sent'), call watch_start, then read the timeline with watch_read({since: cursor}) - it " +
  "returns labeled navigations/clicks/typing/submits plus a next cursor, and watch_read({waitMs}) blocks until " +
  "something happens. Trust health.state: 'blind' means capture is down, not that the user is idle. See docs/WATCH.md.";

const app = express();
app.use(express.json({ limit: "10mb" }));

const httpServer = createServer(app);
const hub = new ExtensionHub(httpServer, token);

// ---- watch mode wiring ----
// The registry is a module singleton (registerTools runs per MCP session), so this is attached once,
// here, rather than inside a tool closure.
hub.registerTap((msg, receivedAt) => {
  if (msg.type === "watch") {
    const session = msg.watchId ? watchRegistry.get(msg.watchId) : watchRegistry.forTab(msg.tabId);
    if (!session) return;
    session.ingest({ tabId: msg.tabId, frameId: msg.frameId }, msg.entries ?? [], receivedAt);
    // A tab the watch just followed needs its own network capture, or "capture everything" silently
    // stops at the tab the watch started on - which is exactly where an OAuth popup or a
    // target=_blank checkout flow goes.
    if (session.netCapture && !session.netTabs.has(msg.tabId)) {
      void startWatchNetCapture(hub, session, msg.tabId).catch((e) => {
        console.error(`[watch] could not capture network on tab ${msg.tabId}: ${e?.message ?? e}`);
      });
    }
    return;
  }
  // Net rows arrive on the capture channel (persist:true with no sink registered). Only fold the
  // ones belonging to a watched tab; a plain net_capture_start is none of watch mode's business.
  if (msg.type === "capture" && !msg.stream) {
    const session = watchRegistry.forTab(msg.tabId);
    if (!session) return;
    const rows = (msg.entries ?? []).filter((e: any) => e && e.kind === "net");
    if (rows.length) session.ingestNet({ tabId: msg.tabId }, rows, receivedAt);
  }
});
hub.onConnectionChange((connected) => watchRegistry.setConnected(connected, Date.now()));
hub.onHello((hello) => {
  // The extension tells us which tabs it is still watching. Re-bind them so a service-worker respawn
  // or a server restart resumes the same timeline instead of silently capturing into nothing.
  const announced = new Set<string>();
  for (const g of hello?.watch?.groups ?? []) {
    announced.add(g.watchId);
    const session = watchRegistry.get(g.watchId);
    if (!session) continue;
    session.markBrowserFound();
    for (const tabId of g.tabs ?? []) watchRegistry.bindTab(tabId, g.watchId);
    if (g.swRestarted) session.noteGap("sw-restarted", g.gapMs ?? 0, Date.now());
  }
  // And the negative direction, which matters more: a session the browser did NOT announce is dead,
  // however healthy the socket looks. Without this the server reports "live" while every page has
  // disarmed itself - the exact silent blindness the timeline is supposed to make impossible.
  for (const session of watchRegistry.list()) {
    if (!announced.has(session.watchId)) session.markBrowserLost(Date.now());
  }
});

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "browser-bridge", version: VERSION }, { instructions: PLAYBOOK_INSTRUCTIONS });
  registerTools(server, hub, VERSION);
  return server;
}

// sessionId -> transport (each MCP client gets its own session; all share the hub)
const transports = new Map<string, StreamableHTTPServerTransport>();

function authorized(req: express.Request): boolean {
  const host = (req.headers.host ?? "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  return req.headers.authorization === `Bearer ${token}`;
}

app.all("/mcp", async (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
      id: null,
    });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport!);
          console.error(`[mcp] session initialized: ${sid}`);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) {
          transports.delete(transport!.sessionId);
          console.error(`[mcp] session closed: ${transport!.sessionId}`);
        }
      };
      await buildMcpServer().connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad request: no valid session. Send an initialize request first." },
        id: null,
      });
      return;
    }
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, extensionConnected: hub.connected });
});

// Watch-mode timeline over plain HTTP. This is what makes watch mode genuinely continuous: MCP is
// pull-only and cannot wake an agent turn, but a Claude Code UserPromptSubmit hook can curl this and
// prepend recent activity to every message - no tool call, no approval prompt, no polling loop.
// Same bearer auth as /mcp; see docs/WATCH.md for the hook snippet.
app.get("/watch", (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ error: "Unauthorized: missing or invalid bearer token" });
    return;
  }
  const session = typeof req.query.watchId === "string" ? watchRegistry.get(req.query.watchId) : watchRegistry.sole();
  if (!session) {
    res.json({ watching: false, actions: [], text: "" });
    return;
  }
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 1000));
  const cursor = typeof req.query.since === "string" ? req.query.since : "";
  const i = cursor.lastIndexOf(":");
  // "<watchId>.<epoch>:<seq>" - the epoch identifies this incarnation, so a cursor from before a
  // server restart is detected rather than silently pointing past the head. See tools.ts parseCursor.
  const head = i > 0 ? cursor.slice(0, i) : "";
  const reset = !!head && head !== `${session.watchId}.${session.epoch}`;
  let sinceSeq = reset || i < 0 ? 0 : Number(cursor.slice(i + 1)) || 0;
  if (!cursor) sinceSeq = Math.max(0, session.lastSeq - limit);

  session.pump(Date.now());
  const out = session.read(sinceSeq, {}, limit, 40_000);
  const nextCursor = `${session.watchId}.${session.epoch}:${Math.max(out.scannedTo, sinceSeq)}`;
  const multiTab = new Set(out.actions.map((a) => a.tabId)).size > 1;
  if (req.query.format === "json") {
    res.json({ watching: true, nextCursor, dropped: out.dropped, more: out.more, reset, actions: out.actions });
    return;
  }
  res.type("text/plain").send(
    (out.actions.length ? renderActions(out.actions, { multiTab }) + "\n" : "") + `cursor: ${nextCursor}\n`
  );
});

// Sink writes are async (see CaptureSink), so drain them before exiting or an abrupt kill loses the
// tail of an in-progress capture / session recording / playbook draft. Guarded against a double
// signal, and time-boxed so a wedged fsync can't hang the shutdown.
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Flush any pending typing burst into the digest before the sinks drain, or the tail of a watch
    // session is lost on SIGTERM.
    for (const s of watchRegistry.list()) {
      try {
        s.pump(Date.now(), true);
      } catch {
        /* best-effort */
      }
    }
    void Promise.race([hub.drainSinks(), new Promise((r) => setTimeout(r, 2_000))]).then(() => process.exit(0));
  });
}

httpServer.listen(PORT, HOST, () => {
  console.error(`[browser-bridge] listening on http://${HOST}:${PORT}`);
  console.error(`[browser-bridge] MCP endpoint:  http://${HOST}:${PORT}/mcp  (Authorization: Bearer <token>)`);
  console.error(`[browser-bridge] extension WS:  ws://${HOST}:${PORT}/ws?token=<token>`);
  console.error(`[browser-bridge] token: ${token}`);
  console.error(`[browser-bridge] token file: ${join(homedir(), ".browser-bridge", "token")}`);
});
