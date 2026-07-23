import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import { randomUUID } from "crypto";
import { CaptureSink } from "./capture-sink.js";

const CALL_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  socket: WebSocket; // the connection this call was sent on; used to reject it if that socket closes
}

/**
 * Holds the single WebSocket connection from the Chrome extension and
 * correlates request/response messages by id.
 */
export class ExtensionHub {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  // Active on-disk capture sinks (persist:true captures), keyed by the tab being captured.
  private captureSinks = new Map<number, CaptureSink>();
  // Optional record sink: when set, every hub.call is appended as a JSONL draft (playbook record-mode).
  private recordSink: CaptureSink | null = null;

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
      // Unsolicited streamed capture entries (persist captures) - routed to the tab's on-disk sink.
      // Handled before the id-correlation path; capture messages carry no `id`.
      if (msg.type === "capture") {
        this.onCapture(msg);
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
      // Reject calls still in flight on THIS socket so they fail fast instead of
      // waiting out the full timeout. Only this socket's pending are rejected, so a
      // call issued on a freshly-replaced connection isn't killed by the old one's close.
      for (const [id, p] of this.pending) {
        if (p.socket !== ws) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error("Browser extension disconnected before responding"));
      }
      // The extension streaming these captures is gone - close every sink so no handle leaks.
      for (const sink of this.captureSinks.values()) sink.close();
      this.captureSinks.clear();
    });
    ws.on("error", (err) => console.error(`[hub] ws error: ${err.message}`));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ---- on-disk capture sinks (persist:true captures) ----

  // True if some active capture is already writing this exact path (reject a second one).
  captureSinkPathInUse(path: string): boolean {
    for (const s of this.captureSinks.values()) if (s.path === path) return true;
    return false;
  }

  // Register a sink (already opened by the tool so a bad path fails synchronously) for a tab.
  // Replaces/closes any prior sink on that tab.
  registerCaptureSink(tabId: number, sink: CaptureSink): void {
    this.captureSinks.get(tabId)?.close();
    this.captureSinks.set(tabId, sink);
  }

  closeCaptureSink(tabId: number): number | undefined {
    const s = this.captureSinks.get(tabId);
    if (!s) return undefined;
    s.close();
    this.captureSinks.delete(tabId);
    return s.written;
  }

  // Route a streamed {type:"capture", tabId, entries, done} message to the tab's sink.
  private onCapture(msg: any): void {
    const tabId = msg.tabId;
    const sink = this.captureSinks.get(tabId);
    if (!sink) return; // no sink (already closed, or capture wasn't started with persist)
    if (Array.isArray(msg.entries) && msg.entries.length) sink.append(msg.entries);
    if (msg.done) {
      sink.close();
      this.captureSinks.delete(tabId);
    }
  }

  // ---- record mode: append every hub.call to a JSONL draft (seed for a playbook) ----
  // The draft is a raw tool-call log; the agent distills it into a durable playbook (ephemeral
  // refs/requestIds must become role/text locators, and any secret-bearing params must be stripped).
  startRecording(savePath: string): { saved: string } {
    this.recordSink?.close(); // replace any prior recording
    this.recordSink = new CaptureSink(savePath); // opens (truncating) now; a bad path throws here
    return { saved: savePath };
  }
  stopRecording(): { saved: string; count: number } | null {
    if (!this.recordSink) return null;
    const out = { saved: this.recordSink.path, count: this.recordSink.written };
    this.recordSink.close();
    this.recordSink = null;
    return out;
  }
  get recording(): boolean {
    return this.recordSink !== null;
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
    if (!this.connected) {
      throw new Error(
        "Browser extension is not connected. Make sure Chrome is running, the Browser Bridge " +
          "extension is loaded, and the token in the extension options matches the server token."
      );
    }
    const id = randomUUID();
    const socket = this.ws!;
    socket.send(JSON.stringify({ id, method, params }));
    this.recordSink?.append([{ ts: Date.now(), method, params }]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, socket });
    });
  }
}
