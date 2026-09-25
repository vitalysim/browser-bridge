// Tests for the session-recording tail-loss fix: CaptureSink.drain() must flush every queued write,
// and ExtensionHub.settleSessionSink() must wait for the recorder's streamed `done` (or a bounded
// timeout) and drain the sink before session_record_stop reads the file. onCapture is exercised
// white-box (it's how the extension's streamed batches reach the hub); the hub is built on a
// non-listening http server so no real socket is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExtensionHub } from "../src/hub.js";
import { CaptureSink } from "../src/capture-sink.js";
import { parseSessionEventsStream } from "../src/capture-format.js";

const rrweb = (timestamp: number) => ({ kind: "rrweb", event: { type: 3, timestamp } });

function tmp(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "bb-sink-"));
  return { dir, path: join(dir, "s.events.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function hub(): ExtensionHub {
  return new ExtensionHub(createServer(), "tok"); // never listened on; no real WS
}

test("CaptureSink.drain flushes every write queued right up to close()", async () => {
  const { path, cleanup } = tmp();
  try {
    const sink = new CaptureSink(path);
    for (let i = 0; i < 50; i++) sink.append([rrweb(i)]);
    sink.close(); // close is chained AFTER the queued writes, not before
    await sink.drain();
    const events = await parseSessionEventsStream(path);
    assert.equal(events.length, 50, "no tail lost between the last append and the close");
  } finally {
    cleanup();
  }
});

test("settleSessionSink waits for a `done` that arrives after the stop ack, then drains it", async () => {
  const { path, cleanup } = tmp();
  const h = hub();
  try {
    const sink = new CaptureSink(path);
    h.registerSessionSink(5, sink);
    // The stop ack has been received; settle begins waiting for the streamed `done`.
    const settled = h.settleSessionSink(5, 3000);
    // The recorder's final batch + done marker arrive afterwards (the race the fix closes).
    (h as any).onCapture({ type: "capture", stream: "session", tabId: 5, entries: [rrweb(1), rrweb(2)], done: true });
    await settled;
    const events = await parseSessionEventsStream(path);
    assert.deepEqual(events.map((e) => e.timestamp), [1, 2], "the post-ack tail is present in the file");
  } finally {
    cleanup();
  }
});

test("settleSessionSink drains when the `done` already arrived before it was called", async () => {
  const { path, cleanup } = tmp();
  const h = hub();
  try {
    const sink = new CaptureSink(path);
    h.registerSessionSink(5, sink);
    (h as any).onCapture({ type: "capture", stream: "session", tabId: 5, entries: [rrweb(1), rrweb(2), rrweb(3)], done: true });
    await h.settleSessionSink(5, 3000); // done already processed -> drains the retained sink
    const events = await parseSessionEventsStream(path);
    assert.equal(events.length, 3);
  } finally {
    cleanup();
  }
});

test("settleSessionSink is bounded: it times out and still drains what was buffered", async () => {
  const { path, cleanup } = tmp();
  const h = hub();
  try {
    const sink = new CaptureSink(path);
    sink.append([rrweb(1)]); // buffered, but the `done` never comes (extension died mid-stop)
    h.registerSessionSink(5, sink);
    const t0 = Date.now();
    await h.settleSessionSink(5, 80);
    assert.ok(Date.now() - t0 >= 60, "waited out (roughly) the bounded timeout");
    const events = await parseSessionEventsStream(path);
    assert.equal(events.length, 1, "the buffered event is still flushed, not lost");
  } finally {
    cleanup();
  }
});
