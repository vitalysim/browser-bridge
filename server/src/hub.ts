import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import { randomUUID } from "crypto";
import { CaptureSink } from "./capture-sink.js";

export const CALL_TIMEOUT_MS = 30_000;

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
/** A streamed capture batch: rrweb events, net rows, or watch-mode page events. */
export interface StreamMsg {
  type: "capture" | "watch";
  stream?: "session";
  watchId?: string;
  tabId: number;
  frameId?: number;
  entries: any[];
  done?: boolean;
}
export type StreamTap = (msg: StreamMsg, receivedAt: number) => void;

export class ExtensionHub {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  // Consumers of the raw inbound stream (watch mode). Taps run BEFORE sink routing and independently
  // of it: watch has no CaptureSink, so anything downstream of the `if (!sink) return` guard in
  // onCapture would never see an event.
  private taps = new Set<StreamTap>();
  private connWatchers = new Set<(connected: boolean) => void>();
  private helloWatchers = new Set<(hello: any) => void>();
  // Active on-disk capture sinks (persist:true captures), keyed by the tab being captured.
  private captureSinks = new Map<number, CaptureSink>();
  // Active session-recording sinks (rrweb events), keyed by tab. Separate map + a stream:"session"
  // discriminator so a recording and a net-capture on the SAME tab don't write to the same file.
  private sessionSinks = new Map<number, CaptureSink>();
  // Optional record sink: when set, every hub.call is appended as a JSONL draft (playbook record-mode).
  private recordSink: CaptureSink | null = null;
  // Events-file path for each active session recording, keyed by tab. Lives on the hub (not a
  // per-MCP-session tool closure) so session_record_stop can resolve the path regardless of which
  // MCP client/session issued session_record_start (start+stop need not share a session).
  private recordingPaths = new Map<number, string>();

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
    this.notifyConn(true);

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
        // The extension re-announces its live watch state on every connect, so a server restart or a
        // service-worker respawn is recoverable without the agent doing anything.
        for (const w of this.helloWatchers) {
          try {
            w(msg);
          } catch {
            /* a watcher must never break the connection */
          }
        }
        return;
      }
      // Unsolicited streamed capture entries (persist captures) - routed to the tab's on-disk sink.
      // Handled before the id-correlation path; capture messages carry no `id`.
      if (msg.type === "capture") {
        this.onCapture(msg);
        return;
      }
      // Watch-mode page events. No sink, no disk - straight to the taps.
      if (msg.type === "watch") {
        this.emitTaps(msg);
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
      // Reject calls still in flight on THIS socket so they fail fast instead of
      // waiting out the full timeout. Only this socket's pending are rejected, so a
      // call issued on a freshly-replaced connection isn't killed by the old one's close.
      for (const [id, p] of this.pending) {
        if (p.socket !== ws) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error("Browser extension disconnected before responding"));
      }
      // Only tear down capture/session sinks when the CURRENT (live) socket closes. If a stale
      // socket is closing because it was just REPLACED (SW respawn / reconnect), this.ws already
      // points at the new socket - closing sinks here would orphan the new connection's sinks and
      // every subsequent capture batch would be silently dropped (truncated JSONL / events file).
      if (this.ws === ws) {
        this.ws = null;
        console.error("[hub] extension disconnected");
        this.notifyConn(false);
        for (const sink of this.captureSinks.values()) sink.close();
        this.captureSinks.clear();
        for (const sink of this.sessionSinks.values()) sink.close();
        this.sessionSinks.clear();
      }
    });
    ws.on("error", (err) => console.error(`[hub] ws error: ${err.message}`));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ---- stream taps + connection lifecycle (watch mode) ----

  registerTap(fn: StreamTap): () => void {
    this.taps.add(fn);
    return () => {
      this.taps.delete(fn);
    };
  }
  onConnectionChange(fn: (connected: boolean) => void): () => void {
    this.connWatchers.add(fn);
    return () => {
      this.connWatchers.delete(fn);
    };
  }
  onHello(fn: (hello: any) => void): () => void {
    this.helloWatchers.add(fn);
    return () => {
      this.helloWatchers.delete(fn);
    };
  }
  private emitTaps(msg: any): void {
    if (!this.taps.size) return;
    const now = Date.now();
    for (const t of this.taps) {
      try {
        t(msg, now);
      } catch {
        /* a tap must never break sink routing or the socket */
      }
    }
  }
  private notifyConn(connected: boolean): void {
    for (const w of this.connWatchers) {
      try {
        w(connected);
      } catch {
        /* ignore */
      }
    }
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

  // ---- session-recording sinks (rrweb events) ----
  sessionSinkPathInUse(path: string): boolean {
    for (const s of this.sessionSinks.values()) if (s.path === path) return true;
    return false;
  }
  registerSessionSink(tabId: number, sink: CaptureSink): void {
    this.sessionSinks.get(tabId)?.close();
    this.sessionSinks.set(tabId, sink);
  }
  closeSessionSink(tabId: number): number | undefined {
    const s = this.sessionSinks.get(tabId);
    if (!s) return undefined;
    s.close();
    this.sessionSinks.delete(tabId);
    return s.written;
  }
  // {tabId, path, written} for each active session recording (for session_record_status).
  sessionSinkList(): { tabId: number; path: string; written: number }[] {
    return [...this.sessionSinks.entries()].map(([tabId, s]) => ({ tabId, path: s.path, written: s.written }));
  }
  // Events-file path bookkeeping for a recording, on the hub so start/stop work across MCP sessions.
  setRecordingPath(tabId: number, path: string): void {
    this.recordingPaths.set(tabId, path);
  }
  getRecordingPath(tabId: number): string | undefined {
    return this.recordingPaths.get(tabId);
  }
  deleteRecordingPath(tabId: number): boolean {
    return this.recordingPaths.delete(tabId);
  }

  // Await every live sink's queued writes. Sink writes are async (see CaptureSink), so a graceful
  // shutdown must drain them or an abrupt exit loses the tail of a capture/recording/playbook draft.
  async drainSinks(): Promise<void> {
    const pending = [
      ...[...this.captureSinks.values()].map((s) => s.drain()),
      ...[...this.sessionSinks.values()].map((s) => s.drain()),
      ...(this.recordSink ? [this.recordSink.drain()] : []),
    ];
    await Promise.all(pending);
  }

  // Route a streamed {type:"capture", stream?, tabId, entries, done} message to the right sink.
  private onCapture(msg: any): void {
    // Taps first, and unconditionally: watch mode registers no sink, so anything after the `if
    // (!sink) return` below would never reach it.
    this.emitTaps(msg);
    const tabId = msg.tabId;
    const sinks = msg.stream === "session" ? this.sessionSinks : this.captureSinks;
    const sink = sinks.get(tabId);
    if (!sink) return; // no sink (already closed, or capture wasn't started for this stream)
    if (Array.isArray(msg.entries) && msg.entries.length) sink.append(msg.entries);
    if (msg.done) {
      sink.close();
      sinks.delete(tabId);
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

  // async so pre-send failures (not-connected guard, socket.send throw) reject the returned Promise
  // instead of throwing synchronously - honoring the Promise<any> contract for every .then/.catch caller.
  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
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
