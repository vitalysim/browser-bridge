// Tests for the pure network-capture helpers the extension uses (extension/src/net-capture.ts).
// These have no chrome/DOM dependencies, so they run under the same node:test harness as the rest.
// They cover the two subtle things the old plain-array approach got wrong: redirect chains sharing a
// requestId, and O(1) eviction that stays correct across those shared ids - plus body truncation and
// the body-fetch concurrency limiter.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NetRing,
  applyRedirectResponse,
  capBody,
  Semaphore,
  type NetEntry,
} from "../../extension/src/net-capture.js";

const entry = (requestId: string, over: Partial<NetEntry> = {}): NetEntry => ({
  requestId,
  method: "GET",
  url: `https://x.test/${requestId}`,
  ...over,
});

test("a 302 -> 200 chain keeps distinct hops and resolves the id to the latest one", () => {
  const ring = new NetRing(500);
  // hop 1: initial request
  ring.push(entry("1", { url: "https://x.test/a" }));
  // hop 2: CDP re-fires requestWillBeSent with the SAME id + the 302's redirectResponse
  applyRedirectResponse(ring.get("1"), { status: 302, headers: { location: "https://x.test/b" } }, "https://x.test/b");
  ring.push(entry("1", { url: "https://x.test/b" }));

  const list = ring.list();
  assert.equal(list.length, 2, "both hops are kept as their own entries");
  // The first hop is finalized as the redirect it was.
  assert.equal(list[0].status, 302);
  assert.equal(list[0].redirectLocation, "https://x.test/b");
  assert.equal(list[0].finished, true);
  // The id resolves to the LATEST hop, and the final 200 attaches there - not to hop 1.
  const latest = ring.get("1")!;
  assert.equal(latest, list[1]);
  assert.equal(latest.url, "https://x.test/b");
  latest.status = 200;
  latest.finished = true;
  assert.equal(ring.list()[0].status, 302, "the intermediate hop still shows 302");
  assert.equal(ring.list()[1].status, 200, "the final hop shows 200");
});

test("eviction reports a requestId only when its LAST hop leaves the ring", () => {
  const ring = new NetRing(2);
  ring.push(entry("1"));
  // redirect hop reuses id 1
  applyRedirectResponse(ring.get("1"), { status: 302, headers: {} });
  ring.push(entry("1", { url: "https://x.test/1b" }));
  assert.equal(ring.size, 2);

  // Pushing id 2 evicts the OLDEST entry (hop 1 of id 1), but id 1 still has a live hop -> not "gone".
  const goneA = ring.push(entry("2"));
  assert.equal(goneA, undefined, "id 1 still has a later hop, so its side-data must not be dropped");
  assert.equal(ring.get("1")?.url, "https://x.test/1b", "id 1 still resolves to its surviving hop");

  // Pushing id 3 evicts the surviving hop of id 1 -> now id 1 is fully gone and reported.
  const goneB = ring.push(entry("3"));
  assert.equal(goneB, "1");
  assert.equal(ring.get("1"), undefined);
});

test("the ring evicts oldest-first and stays bounded to max", () => {
  const ring = new NetRing(3);
  for (let i = 1; i <= 10; i++) ring.push(entry(String(i)));
  assert.equal(ring.size, 3);
  assert.deepEqual(ring.list().map((e) => e.requestId), ["8", "9", "10"]);
  assert.equal(ring.get("7"), undefined, "evicted ids no longer resolve");
  assert.equal(ring.get("10")?.requestId, "10");
});

test("push after many evictions does not grow the backing store without bound", () => {
  // Regression guard for the head-pointer compaction: 100k pushes on a 10-cap ring must not retain
  // ~100k entries. We can't read buf directly, but list()/size must stay at the cap.
  const ring = new NetRing(10);
  for (let i = 0; i < 100_000; i++) ring.push(entry(String(i)));
  assert.equal(ring.size, 10);
  assert.equal(ring.list().length, 10);
  assert.equal(ring.list()[9].requestId, "99999");
});

test("capBody: a short body is untouched", () => {
  const r = capBody("hello", false, 100);
  assert.equal(r.body, "hello");
  assert.equal(r.truncated, undefined);
  assert.equal(r.originalLength, undefined);
});

test("capBody: a long text body truncates structurally, with no appended marker", () => {
  const raw = "x".repeat(200);
  const r = capBody(raw, false, 100);
  assert.equal(r.body, "x".repeat(100), "cut cleanly at the cap, no '…[truncated]' suffix");
  assert.equal(r.truncated, true);
  assert.equal(r.originalLength, 200);
});

test("capBody: a base64 body stays decodable (cut to a multiple of 4)", () => {
  const raw = Buffer.from("y".repeat(300)).toString("base64"); // length 400
  const r = capBody(raw, true, 10);
  assert.equal(r.truncated, true);
  assert.equal(r.originalLength, raw.length);
  assert.equal(r.body.length % 4, 0, "kept on a base64 boundary");
  assert.doesNotThrow(() => Buffer.from(r.body, "base64"), "the truncated base64 still decodes");
});

test("Semaphore admits at most `max` at once and completes them all", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  const task = () =>
    sem.run(
      () =>
        new Promise<void>((resolve) => {
          active++;
          peak = Math.max(peak, active);
          gates.push(() => {
            active--;
            resolve();
          });
        })
    );
  const all = [task(), task(), task(), task(), task()];
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(active, 2, "only two are admitted while the rest wait");

  // Release admitted tasks one at a time; each release should admit exactly one waiter.
  while (gates.length) {
    gates.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  }
  await Promise.all(all);
  assert.equal(peak, 2, "concurrency never exceeded the limit");
});
