// Tiny logger. Two jobs:
//   - log(): prefix any server line with an ISO timestamp (message otherwise unchanged);
//   - formatCallLine(): one compact line per tool call - name, tabId, duration, outcome, short error.
// Params are NEVER logged: they can carry secrets, cookies, file contents and typed passwords. Neither
// is the bearer token - only the path of the file that holds it.
//
// Where lines go: stderr (unless BRIDGE_LOG_STDERR=0) AND, once initFileLog() ran, a size-rotated file
// (~/.browser-bridge/server.log, server.log.1 … .N, each 0600). The server owns rotation because launchd
// cannot rotate StandardErrorPath: before this, launchd appended stderr to server.log forever (68 MB+).
// The LaunchAgent now points stdout/stderr at a small separate launchd.log and sets BRIDGE_LOG_STDERR=0,
// so that file only catches what happens before the logger exists (a crash at import time, a fatal
// Node error) - see trimLaunchdLog() and scripts/install-service.mjs.
import { openSync, writeSync, closeSync, fstatSync, renameSync, unlinkSync, statSync, readSync, writeFileSync, chmodSync } from "fs";

export type CallOutcome = "ok" | "error" | "notActionable";

export interface FileLogOptions {
  /** Rotate once the live file would exceed this many bytes (default 10 MB). */
  maxBytes?: number;
  /** How many rotated files to keep besides the live one (default 3: .1 .2 .3). */
  keep?: number;
}

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_KEEP = 3;

/** A size-rotating append-only log file. Writes are synchronous (lines are small; ordering and
 *  "the line is on disk before the crash" matter more than throughput). Never throws. */
export class RotatingFile {
  readonly path: string;
  private fd: number | null = null;
  private size = 0;
  private maxBytes: number;
  private keep: number;
  private broken = false;

  constructor(path: string, opts: FileLogOptions = {}) {
    this.path = path;
    this.maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
    this.keep = Math.max(1, Math.floor(opts.keep ?? DEFAULT_LOG_KEEP));
    this.open();
  }

  private open(): void {
    try {
      this.fd = openSync(this.path, "a", 0o600);
      try {
        chmodSync(this.path, 0o600); // an existing file keeps its old mode on open
      } catch {
        /* best-effort */
      }
      this.size = fstatSync(this.fd).size;
      this.broken = false;
    } catch {
      this.fd = null;
      this.broken = true;
    }
  }

  write(line: string): void {
    if (this.broken && this.fd === null) {
      this.open(); // e.g. the dir was recreated; try again, quietly
      if (this.fd === null) return;
    }
    const buf = Buffer.from(line.endsWith("\n") ? line : line + "\n", "utf8");
    if (this.size > 0 && this.size + buf.length > this.maxBytes) this.rotate();
    if (this.fd === null) return;
    try {
      writeSync(this.fd, buf);
      this.size += buf.length;
    } catch {
      /* disk full / fd gone - logging must never take the server down */
    }
  }

  /** server.log -> .1 -> .2 … ; the oldest beyond `keep` is deleted. */
  rotate(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
    try {
      unlinkSync(`${this.path}.${this.keep}`);
    } catch {
      /* not there */
    }
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {
        /* gap in the sequence */
      }
    }
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch {
      /* nothing to rotate */
    }
    this.open();
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      /* ignore */
    }
    this.fd = null;
  }
}

let fileSink: RotatingFile | null = null;
let toStderr = process.env.BRIDGE_LOG_STDERR !== "0";

/** Start mirroring every log line into a rotated file. Returns the sink (tests close it). */
export function initFileLog(path: string, opts: FileLogOptions = {}): RotatingFile {
  fileSink?.close();
  fileSink = new RotatingFile(path, opts);
  return fileSink;
}

/** Stop file logging (tests). */
export function closeFileLog(): void {
  fileSink?.close();
  fileSink = null;
}

/** Override BRIDGE_LOG_STDERR (tests). */
export function setStderrLogging(on: boolean): void {
  toStderr = on;
}

function emit(line: string): void {
  if (toStderr || !fileSink) console.error(line); // with no file sink, stderr is the only record
  fileSink?.write(line);
}

export function log(message: string, now: Date = new Date()): void {
  emit(`${now.toISOString()} ${message}`);
}

/**
 * launchd's StandardErrorPath (launchd.log) is append-only and nobody rotates it. It should stay tiny
 * (pre-logger crashes only), but a crash loop could still grow it - so on startup, if it is over
 * `maxBytes`, keep only its last `keepBytes` (the most recent crash is the useful part). Truncating is
 * safe under launchd: it opened the file O_APPEND, so its next write lands at the new end.
 */
export function trimLaunchdLog(path: string, maxBytes = 1024 * 1024, keepBytes = 256 * 1024): boolean {
  try {
    const size = statSync(path).size;
    if (size <= maxBytes) return false;
    const fd = openSync(path, "r");
    const tail = Buffer.alloc(Math.min(keepBytes, size));
    try {
      readSync(fd, tail, 0, tail.length, size - tail.length);
    } finally {
      closeSync(fd);
    }
    writeFileSync(path, Buffer.concat([Buffer.from(`[trimmed ${size - tail.length} older bytes]\n`), tail]), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const MAX_DETAIL = 200;

/** Collapse to one line and cap at 200 chars, so one call is always exactly one log line. */
export function shortDetail(s: string, max = MAX_DETAIL): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export interface CallLogEntry {
  tool: string;
  tabId?: unknown;
  ms: number;
  outcome: CallOutcome;
  detail?: string;
}

export function formatCallLine(e: CallLogEntry, now: Date = new Date()): string {
  const parts = [now.toISOString(), "[call]", e.tool];
  // Only a numeric tabId is logged - never echo an arbitrary caller-supplied value.
  if (typeof e.tabId === "number" && Number.isFinite(e.tabId)) parts.push(`tab=${e.tabId}`);
  parts.push(`${Math.round(e.ms)}ms`, e.outcome);
  if (e.detail) parts.push(shortDetail(e.detail));
  return parts.join(" ");
}

export function logCall(e: CallLogEntry): void {
  emit(formatCallLine(e));
}
