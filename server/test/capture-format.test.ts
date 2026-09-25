// Tests for the pure capture-export helpers (server/src/capture-format.ts): HAR assembly (redirect
// Location, capture-time truncation reporting, and the export-time inline cap) and session-event
// parsing (the streaming reader must produce exactly what the string parser does).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildHar,
  harEntry,
  parseSessionEvents,
  parseSessionEventsStream,
} from "../src/capture-format.js";

const creator = { name: "browser-bridge", version: "test" };
const nowIso = "2020-01-01T00:00:00.000Z";

test("a redirect hop's HAR entry carries its Location and status", () => {
  const { entry } = harEntry(
    { ts: 1000, method: "GET", url: "https://x.test/a", status: 302, redirectLocation: "https://x.test/b" },
    nowIso
  );
  assert.equal(entry.response.status, 302);
  assert.equal(entry.response.redirectURL, "https://x.test/b");
});

test("startedDateTime uses the captured request time, not the export time", () => {
  const { entry } = harEntry({ ts: 1_600_000_000_000, method: "GET", url: "https://x.test/a", status: 200 }, nowIso);
  assert.equal(entry.startedDateTime, new Date(1_600_000_000_000).toISOString());
  // Missing ts falls back to the export time.
  const { entry: e2 } = harEntry({ method: "GET", url: "https://x.test/a", status: 200 }, nowIso);
  assert.equal(e2.startedDateTime, nowIso);
});

test("capture-time truncation is reported in HAR: real size preserved, comment set", () => {
  const { entry, capped } = harEntry(
    {
      method: "GET",
      url: "https://x.test/big",
      status: 200,
      responseBody: "abc",
      responseBodyTruncated: true,
      responseBodyOriginalLength: 5000,
    },
    nowIso
  );
  assert.equal(capped, false, "capped means the EXPORT cap bit, not the capture-time one");
  assert.equal(entry.response.content.size, 5000, "content.size is the real body size");
  assert.equal(entry.response.content.text, "abc");
  assert.match(entry.response.content.comment, /truncated/);
});

test("the export-time byte cap shortens the inlined body and is counted", () => {
  const rows = [
    { method: "GET", url: "https://x.test/a", status: 200, responseBody: "x".repeat(100) },
    { method: "GET", url: "https://x.test/b", status: 200, responseBody: "short" },
  ];
  const { har, bodiesCapped } = buildHar(rows, creator, nowIso, { maxBodyBytes: 10 });
  assert.equal(bodiesCapped, 1, "only the oversized body was capped");
  const [a, b] = har.log.entries;
  assert.equal(a.response.content.text.length, 10);
  assert.equal(a.response.content.size, 100, "the real size is still recorded");
  assert.match(a.response.content.comment, /truncated/);
  assert.equal(b.response.content.text, "short", "the small body is untouched");
});

test("the export-time cap keeps a base64 body decodable", () => {
  const b64 = Buffer.from("z".repeat(300)).toString("base64"); // length 400
  const { har } = buildHar(
    [{ method: "GET", url: "https://x.test/img", status: 200, responseBody: b64, responseBodyBase64: true }],
    creator,
    nowIso,
    { maxBodyBytes: 10 }
  );
  const content = har.log.entries[0].response.content;
  assert.equal(content.encoding, "base64");
  assert.equal(content.text.length % 4, 0, "cut on a base64 boundary");
  assert.doesNotThrow(() => Buffer.from(content.text, "base64"));
});

test("no cap option means bodies are inlined whole", () => {
  const { har, bodiesCapped } = buildHar(
    [{ method: "GET", url: "https://x.test/a", status: 200, responseBody: "x".repeat(100) }],
    creator,
    nowIso
  );
  assert.equal(bodiesCapped, 0);
  assert.equal(har.log.entries[0].response.content.text.length, 100);
});

test("streaming session parse matches the string parser (sorted, filtered, torn-line-tolerant)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-capfmt-"));
  const path = join(dir, "s.events.jsonl");
  try {
    // Out-of-order timestamps, a non-rrweb row, a blank line, and a torn final line (no newline).
    const lines = [
      JSON.stringify({ kind: "rrweb", event: { type: 2, timestamp: 300 } }),
      JSON.stringify({ kind: "meta", note: "ignored" }),
      "",
      JSON.stringify({ kind: "rrweb", event: { type: 0, timestamp: 100 } }),
      JSON.stringify({ kind: "rrweb", event: { type: 3, timestamp: 200 } }),
      '{"kind":"rrweb","event":{"type":9,"timestamp":50', // torn: unterminated JSON
    ];
    const jsonl = lines.join("\n");
    writeFileSync(path, jsonl);

    const fromString = parseSessionEvents(jsonl);
    const fromStream = await parseSessionEventsStream(path);

    assert.deepEqual(
      fromString.map((e) => e.timestamp),
      [100, 200, 300],
      "sorted by timestamp, non-rrweb + blank + torn lines dropped"
    );
    assert.deepEqual(fromStream, fromString, "the streaming reader yields exactly the same events");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
