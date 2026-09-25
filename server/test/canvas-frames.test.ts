// Canvas-frame parsing tests. The recorder streams <canvas>/WebGL frames as rrweb CanvasMutation
// events; the replay player and the MP4 exporter both rebuild a per-canvas frame index from them. This
// pins that parse: given a recorded events stream, the right frames come back out, keyed by the rrweb
// id that lines them up with the replayed canvas, non-blank, and de-duplicated. Pure - no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  extractCanvasFrames,
  indexCanvasFramesById,
  frameFromEvent,
  canvasNotes,
  base64ByteLength,
  isLikelyBlankFrame,
  type CanvasFrame,
} from "../src/canvas-frames.js";

/** Parse a session events JSONL (rows {kind:"rrweb", event}) the way session_record_stop does. */
function loadEvents(name: string): any[] {
  const jsonl = readFileSync(fileURLToPath(new URL("./fixtures/" + name, import.meta.url)), "utf8");
  const out: any[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row && row.kind === "rrweb" && row.event) out.push(row.event);
  }
  return out;
}

test("captured canvas frames are recovered from the events stream, non-blank", () => {
  const events = loadEvents("canvas-events.jsonl");
  const frames = extractCanvasFrames(events);
  // 2D (2 frames) + WebGL + same-origin iframe + open-shadow-DOM = 5 frames across 4 canvases.
  assert.equal(frames.length, 5, "every emitted frame is parsed");
  for (const f of frames) {
    assert.ok(f.byteLength > 120, "a real WebP/PNG frame clears the blank floor");
    assert.equal(isLikelyBlankFrame(f), false, "no captured frame reads as blank");
    assert.ok(f.mime.length > 0, "the frame carries its encode type");
  }
});

test("frames are indexed per canvas id and sorted by time", () => {
  const events = loadEvents("canvas-events.jsonl");
  const byId = indexCanvasFramesById(events);
  assert.deepEqual([...byId.keys()].sort((a, b) => a - b), [10, 20, 30, 40], "one list per canvas, keyed by rrweb id");

  const twoD = byId.get(10)!;
  assert.equal(twoD.length, 2, "the animated 2D canvas kept both distinct frames");
  assert.ok(twoD[0].timestamp < twoD[1].timestamp, "sorted ascending in time");
  assert.notEqual(twoD[0].base64, twoD[1].base64, "dedup let a genuine pixel change through (frames differ)");
});

test("base64ByteLength matches a real decode", () => {
  const events = loadEvents("canvas-events.jsonl");
  for (const f of extractCanvasFrames(events)) {
    assert.equal(f.byteLength, Buffer.from(f.base64, "base64").length, "declared byte length equals the decoded size");
  }
  assert.equal(base64ByteLength(""), 0);
  assert.equal(base64ByteLength("AAAA"), 3, "4 base64 chars, no padding -> 3 bytes");
  assert.equal(base64ByteLength("AAA="), 2);
  assert.equal(base64ByteLength("AA=="), 1);
});

test("a skipped (cross-origin-tainted) canvas leaves a one-time note, not a frame", () => {
  const events = loadEvents("canvas-events.jsonl");
  const notes = canvasNotes(events);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, 50);
  assert.equal(notes[0].reason, "tainted");
  assert.equal(indexCanvasFramesById(events).has(50), false, "the tainted canvas produced no frame");
});

test("non-canvas events are ignored by the frame parser", () => {
  const events = loadEvents("canvas-events.jsonl");
  const meta = events.find((e) => e.type === 4);
  const mouse = events.find((e) => e.type === 3 && e.data && e.data.source === 1);
  assert.equal(frameFromEvent(meta), null, "a Meta event is not a canvas frame");
  assert.equal(frameFromEvent(mouse), null, "a MouseMove is not a canvas frame");
  assert.equal(frameFromEvent(null), null);
  assert.equal(frameFromEvent({ type: 3, data: { source: 9 } }), null, "a canvas mutation with no image is not a frame");
});

test("isLikelyBlankFrame flags a degenerate empty encode", () => {
  const blank: CanvasFrame = { id: 1, timestamp: 0, mime: "image/webp", base64: "AAAA", byteLength: 3 };
  assert.equal(isLikelyBlankFrame(blank), true, "3 bytes is below the floor");
  const real: CanvasFrame = { id: 1, timestamp: 0, mime: "image/webp", base64: "", byteLength: 900 };
  assert.equal(isLikelyBlankFrame(real), false);
});
