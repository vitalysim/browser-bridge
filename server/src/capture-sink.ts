import { openSync, write, fsync, close } from "fs";

// A per-capture on-disk sink: appends network/WebSocket entries streamed from the extension as
// JSON Lines (one JSON object per line). This is the *durable* record of a capture - it survives
// the in-memory ring's NET_MAX_ENTRIES eviction and (up to the last flushed batch) an abrupt
// service-worker death. It is NOT continuity: when the SW dies the debugger detaches and capture
// stops until restarted. Each line is a captured request/frame row (same shape as net_get_requests),
// so it converts to HAR/curl trivially with jq.
//
// Writes go through a serial promise chain rather than writeSync/fsyncSync: `append` sits on the hot
// path of EVERY hub.call while playbook record-mode is on (hub.call -> recordSink.append), and a
// synchronous fsync there blocks the whole Node event loop per browser action. The chain preserves
// write ordering and still fsyncs per batch, so the durability guarantee above is unchanged - the
// flush just no longer blocks. (The guarantee concerns *service-worker* death; the server process
// stays alive and drains. `drain()` covers the abrupt-server-kill case at shutdown.)
export class CaptureSink {
  readonly path: string;
  private fd: number;
  private closed = false;
  // Serial write chain. Each append/close links onto it, so batches land in call order.
  private queue: Promise<void> = Promise.resolve();
  written = 0;

  // Opens (truncating) the file synchronously so a bad path/permission fails the net_capture_start
  // call that created it, rather than surfacing later on an async write mid-stream.
  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, "w"); // throws on invalid dir / no permission → caught by the caller
  }

  append(entries: any[]): void {
    if (this.closed || !entries?.length) return;
    let buf = "";
    for (const e of entries) {
      try {
        buf += JSON.stringify(e) + "\n";
      } catch {
        buf += JSON.stringify({ kind: "error", note: "unserializable capture entry" }) + "\n";
      }
    }
    // Counted synchronously: closeCaptureSink/closeSessionSink/stopRecording read `written`
    // immediately after close(), before the chain has necessarily drained.
    this.written += entries.length;
    this.queue = this.queue.then(() => this.writeAndSync(buf)).catch(() => {
      /* best-effort, as before - a failed batch must not break the chain for later ones */
    });
  }

  // Flush to the OS per batch so a partial file is valid up to the last complete line if the
  // process/SW dies. (Per-batch, not per-line - batches arrive ~every 300ms.)
  private writeAndSync(buf: string): Promise<void> {
    return new Promise<void>((resolve) => {
      write(this.fd, buf, () => {
        fsync(this.fd, () => resolve()); // fsync best-effort
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Chained, not immediate: closing the fd before queued writes drain would lose them.
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          close(this.fd, () => resolve()); // already gone / bad fd → ignore
        })
    );
  }

  // Resolves once every queued write (and the close, if issued) has hit disk. For graceful
  // shutdown and for tests that need to read the file back.
  drain(): Promise<void> {
    return this.queue;
  }
}
