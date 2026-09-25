// classifyError + truncateForText: pure result-shaping. The property that matters and can't be
// eyeballed in prod is that truncated output is ALWAYS valid JSON (or a plainly-flagged string cut).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, truncateForText } from "../src/result.js";

test("classifyError honours an explicit code from the extension", () => {
  const e = Object.assign(new Error("whatever"), { code: "RESULT_TOO_LARGE" });
  assert.equal(classifyError(e), "RESULT_TOO_LARGE");
});

test("classifyError ignores an unknown explicit code and falls back to the message", () => {
  const e = Object.assign(new Error("Extension call 'click' timed out after 30000ms"), { code: "BOGUS" });
  assert.equal(classifyError(e), "TIMEOUT");
});

test("classifyError maps the common messages", () => {
  assert.equal(classifyError(new Error("Extension call 'x' timed out after 30000ms")), "TIMEOUT");
  assert.equal(classifyError(new Error("Browser extension is not connected. Make sure Chrome…")), "NO_EXTENSION");
  assert.equal(classifyError(new Error("Browser extension disconnected before responding")), "NO_EXTENSION");
  assert.equal(classifyError(new Error("No tab with id 42")), "TAB_NOT_FOUND");
  assert.equal(classifyError(new Error("No active tab found")), "TAB_NOT_FOUND");
  assert.equal(classifyError(new Error("Cannot script this page (chrome://settings). Browser-internal…")), "NOT_SCRIPTABLE");
  assert.equal(classifyError(new Error("Refused to connect because it violates the Content Security Policy")), "CSP_BLOCKED");
  assert.equal(classifyError(new Error("something odd happened")), "UNKNOWN");
  assert.equal(classifyError(""), "UNKNOWN");
});

test("a short value passes through untouched and un-truncated", () => {
  const r = truncateForText({ a: 1, b: "hi" }, 60_000);
  assert.equal(r.truncated, false);
  assert.deepEqual(JSON.parse(r.text), { a: 1, b: "hi" });
});

test("a plain oversized string gets a clean cut and an explicit flag", () => {
  const r = truncateForText("x".repeat(1000), 200);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 200 + 40);
  assert.match(r.text, /truncated: \d+ of 1000 chars/);
});

test("a large top-level array is trimmed to a valid-JSON envelope that fits", () => {
  const arr = Array.from({ length: 500 }, (_, i) => ({ i, pad: "abcdefghij" }));
  const max = 2_000;
  const r = truncateForText(arr, max);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= max, `len ${r.text.length} > ${max}`);
  const parsed = JSON.parse(r.text); // must not throw
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.total, 500);
  assert.ok(parsed.returned < 500 && parsed.returned === parsed.items.length);
  assert.equal(parsed.hint, "narrow with limit/filter");
});

test("an object holding a large array trims that array in place and stays valid JSON", () => {
  const obj = { meta: "keep me", rows: Array.from({ length: 400 }, (_, i) => ({ i, s: "payload-payload" })) };
  const max = 2_000;
  const r = truncateForText(obj, max);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= max);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.meta, "keep me");
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.total, 400);
  assert.equal(parsed.truncatedField, "rows");
  assert.equal(parsed.rows.length, parsed.returned);
});

test("an oversized payload with no array falls back to a valid-JSON prefix preview", () => {
  const obj = { blob: "z".repeat(5000), n: 1 };
  const max = 1_000;
  const r = truncateForText(obj, max);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= max);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.truncated, true);
  assert.equal(typeof parsed.preview, "string");
  assert.ok(parsed.bytes > max);
});

test("truncated output is always parseable even when single items are huge", () => {
  const arr = [{ big: "q".repeat(5000) }, { big: "q".repeat(5000) }];
  const r = truncateForText(arr, 500);
  assert.equal(r.truncated, true);
  const parsed = JSON.parse(r.text); // the point: no invalid JSON even when nothing fits
  assert.equal(parsed.truncated, true);
});
