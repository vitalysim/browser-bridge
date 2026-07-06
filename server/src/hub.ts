import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import { randomUUID } from "crypto";

const CALL_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds the single WebSocket connection from the Chrome extension and
 * correlates request/response messages by id.
 */
export class ExtensionHub {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();

  constructor(httpServer: HttpServer, token: string) {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin ?? "";
      if (!origin.startsWith("chrome-extension://")) {
        console.error(`[hub] rejected WS: bad origin ${origin}`);
        socket.destroy();
        return;
      }
      if (url.searchParams.get("token") !== token) {
        console.error("[hub] rejected WS: bad token");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, req));
    });
  }

  private attach(ws: WebSocket, req: IncomingMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.error("[hub] replacing existing extension connection");
      this.ws.close(4000, "replaced by new connection");
    }
    this.ws = ws;
    console.error(`[hub] extension connected (${req.headers.origin})`);

    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "hello") {
        console.error(`[hub] extension hello: v${msg.version}`);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "unknown extension error"));
    });

    ws.on("close", () => {
      if (this.ws === ws) {
        this.ws = null;
        console.error("[hub] extension disconnected");
      }
    });
    ws.on("error", (err) => console.error(`[hub] ws error: ${err.message}`));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
    if (!this.connected) {
      throw new Error(
        "Browser extension is not connected. Make sure Chrome is running, the Browser Bridge " +
          "extension is loaded, and the token in the extension options matches the server token."
      );
    }
    const id = randomUUID();
    this.ws!.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}
