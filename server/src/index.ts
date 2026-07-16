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
import { registerTools } from "./tools.js";

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
const app = express();
app.use(express.json({ limit: "10mb" }));

const httpServer = createServer(app);
const hub = new ExtensionHub(httpServer, token);

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "browser-bridge", version: VERSION });
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

httpServer.listen(PORT, HOST, () => {
  console.error(`[browser-bridge] listening on http://${HOST}:${PORT}`);
  console.error(`[browser-bridge] MCP endpoint:  http://${HOST}:${PORT}/mcp  (Authorization: Bearer <token>)`);
  console.error(`[browser-bridge] extension WS:  ws://${HOST}:${PORT}/ws?token=<token>`);
  console.error(`[browser-bridge] token: ${token}`);
  console.error(`[browser-bridge] token file: ${join(homedir(), ".browser-bridge", "token")}`);
});
