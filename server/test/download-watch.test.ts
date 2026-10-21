// Tests for downloadVerdict (server/src/download-watch.ts): download_resource must fail fast on a
// dangerous-file prompt, a paused item, or a stalled transfer instead of waiting out its 10-minute
// timeout - and an omitted maxBytes means unlimited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadVerdict } from "../src/download-watch.js";

const T0 = 1_000_000;
const fresh = () => ({ lastBytes: 0, lastProgressAt: T0 });

test("complete and interrupted are terminal", () => {
  assert.equal(downloadVerdict({ state: "complete" }, fresh(), { now: T0 }).kind, "complete");
  const v = downloadVerdict({ state: "interrupted", error: "NETWORK_FAILED" }, fresh(), { now: T0 });
  assert.equal(v.kind, "fail");
  assert.match((v as any).message, /NETWORK_FAILED/);
});

test("a dangerous-file verdict fails immediately with an actionable message", () => {
  const v = downloadVerdict({ state: "in_progress", danger: "file", bytesReceived: 10 }, fresh(), { now: T0, downloadId: 7 });
  assert.equal(v.kind, "fail");
  assert.match((v as any).message, /dangerous \(danger: file\) \(downloadId 7\)/);
  assert.match((v as any).message, /chrome:\/\/downloads/);
  assert.equal((v as any).cancel, false, "left for the human to keep/discard");
});

test("safe/accepted/scanning danger states keep waiting", () => {
  for (const danger of ["safe", "accepted", "asyncScanning"]) {
    const v = downloadVerdict({ state: "in_progress", danger, bytesReceived: 5 }, fresh(), { now: T0 });
    assert.equal(v.kind, "wait", danger);
  }
});

test("a paused download fails fast", () => {
  const v = downloadVerdict({ state: "in_progress", danger: "safe", paused: true }, fresh(), { now: T0 });
  assert.equal(v.kind, "fail");
  assert.match((v as any).message, /paused/);
});

test("no byte progress past the stall window fails; progress resets the window", () => {
  const p = fresh();
  assert.equal(downloadVerdict({ state: "in_progress", bytesReceived: 100 }, p, { now: T0 + 1_000 }).kind, "wait");
  assert.equal(p.lastProgressAt, T0 + 1_000);
  // Same bytes, 29s later: still inside the default 30s window.
  assert.equal(downloadVerdict({ state: "in_progress", bytesReceived: 100 }, p, { now: T0 + 30_000 }).kind, "wait");
  const v = downloadVerdict({ state: "in_progress", bytesReceived: 100 }, p, { now: T0 + 31_500 });
  assert.equal(v.kind, "fail");
  assert.match((v as any).message, /no progress for 30s/);
  // stallMs: 0 disables the check.
  assert.equal(downloadVerdict({ state: "in_progress", bytesReceived: 100 }, fresh(), { now: T0 + 999_999, stallMs: 0 }).kind, "wait");
});

test("scanning is exempt from the stall check", () => {
  const v = downloadVerdict({ state: "in_progress", bytesReceived: 0, danger: "asyncScanning" }, fresh(), { now: T0 + 120_000 });
  assert.equal(v.kind, "wait");
});

test("maxBytes: enforced when given, unlimited when omitted", () => {
  const big = { state: "in_progress", totalBytes: 500 * 1024 * 1024, bytesReceived: 1 };
  assert.equal(downloadVerdict(big, fresh(), { now: T0 }).kind, "wait", "no cap = unlimited");
  const v = downloadVerdict(big, fresh(), { now: T0, cap: 100 * 1024 * 1024 });
  assert.equal(v.kind, "fail");
  assert.equal((v as any).cancel, true);
});
