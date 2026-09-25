// Tests for findWatchNetRow (server/src/tools.ts): watch_detail's lookup of a full network row from
// the per-tab watch capture JSONL. Verifies it returns the LAST matching row (tail-first scan),
// searches every attached tab, tolerates torn lines, and returns null on a miss / when no capture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findWatchNetRow } from "../src/tools.js";

// A minimal stand-in for WatchSession — findWatchNetRow only reads netCapture + netTabs.
function fakeSession(basePath: string, netTabs: number[]): any {
  return { netCapture: { basePath }, netTabs };
}

test("findWatchNetRow returns the last matching row and searches all attached tabs", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-watch-detail-"));
  try {
    const base = join(dir, "watch");
    // tab 1: two rows share a requestId (a redirect reused it) — the tail one must win.
    writeFileSync(
      `${base}.net.1.jsonl`,
      [
        JSON.stringify({ kind: "net", requestId: "R1", status: 302, url: "http://a/old" }),
        JSON.stringify({ kind: "net", requestId: "R1", status: 200, url: "http://a/new" }),
        "{ torn line, not json",
      ].join("\n") + "\n"
    );
    // tab 2: a different request, in a second attached tab.
    writeFileSync(
      `${base}.net.2.jsonl`,
      JSON.stringify({ kind: "net", requestId: "R2", status: 201, url: "http://b/create" }) + "\n"
    );
    const s = fakeSession(base, [1, 2]);

    assert.equal(findWatchNetRow(s, "R1")?.status, 200, "tail-most row for R1");
    assert.equal(findWatchNetRow(s, "R2")?.url, "http://b/create", "row found in a second tab");
    assert.equal(findWatchNetRow(s, "NOPE"), null, "miss returns null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWatchNetRow returns null when the session has no network capture", () => {
  assert.equal(findWatchNetRow({ netCapture: null, netTabs: [] } as any, "R1"), null);
});

test("findWatchNetRow ignores a substring hit that is not a real net row for that id", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-watch-detail-"));
  try {
    const base = join(dir, "watch");
    // A console row that merely mentions the id in a body must not be mistaken for the net row.
    writeFileSync(
      `${base}.net.1.jsonl`,
      JSON.stringify({ kind: "console", text: "requested R9 from server" }) + "\n"
    );
    assert.equal(findWatchNetRow(fakeSession(base, [1]), "R9"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
