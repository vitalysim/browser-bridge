import { openSync, writeSync, closeSync, fsyncSync } from "fs";

// A per-capture on-disk sink: appends network/WebSocket entries streamed from the extension as
// JSON Lines (one JSON object per line). This is the *durable* record of a capture - it survives
// the in-memory ring's NET_MAX_ENTRIES eviction and (up to the last flushed batch) an abrupt
// service-worker death. It is NOT continuity: when the SW dies the debugger detaches and capture
// stops until restarted. Each line is a captured request/frame row (same shape as net_get_requests),
// so it converts to HAR/curl trivially with jq.
export class CaptureSink {
  readonly path: string;
  private fd: number;
  private closed = false;
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
    writeSync(this.fd, buf);
    // Flush to the OS per batch so a partial file is valid up to the last complete line if the
    // process/SW dies. (Per-batch, not per-line - batches arrive ~every 300ms.)
    try {
      fsyncSync(this.fd);
    } catch {
      /* fsync best-effort */
    }
    this.written += entries.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {
      /* already gone */
    }
  }
}
