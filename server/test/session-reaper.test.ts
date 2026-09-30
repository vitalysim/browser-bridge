// Tests for sessionsToReap (server/src/session-reaper.ts): which MCP sessions are safe to close.
// The critical invariant is that a session with a request in flight is NEVER reaped - a watch_read
// long poll sits open ~25s and must not be killed mid-flight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionsToReap, type SessionState } from "../src/session-reaper.js";

const NOW = 1_000_000_000;
const mk = (rows: Record<string, [number, number]>): Map<string, SessionState> =>
  new Map(Object.entries(rows).map(([id, [lastSeen, inflight]]) => [id, { lastSeen, inflight }]));

test("reaps sessions idle past the TTL, keeps fresh ones", () => {
  const s = mk({
    stale: [NOW - 2 * 3600_000, 0],
    fresh: [NOW - 1000, 0],
    edge: [NOW - 3600_000 + 5000, 0], // just inside the 1h TTL
  });
  assert.deepEqual(sessionsToReap(s, NOW).sort(), ["stale"]);
});

test("never reaps a session with a request in flight, however idle it looks", () => {
  const s = mk({ longPoll: [NOW - 10 * 3600_000, 1] });
  assert.deepEqual(sessionsToReap(s, NOW), [], "in-flight session must survive");
  // ...but once the poll finishes it becomes eligible.
  s.get("longPoll")!.inflight = 0;
  assert.deepEqual(sessionsToReap(s, NOW), ["longPoll"]);
});

test("over the cap, evicts the least-recently-seen idle sessions", () => {
  const rows: Record<string, [number, number]> = {};
  for (let i = 0; i < 10; i++) rows["s" + i] = [NOW - i * 1000, 0]; // s9 oldest, s0 newest
  const reaped = sessionsToReap(mk(rows), NOW, 3600_000, 6);
  assert.equal(reaped.length, 4, "10 sessions, cap 6 -> drop 4");
  assert.deepEqual(reaped.sort(), ["s6", "s7", "s8", "s9"], "oldest four");
});

test("the cap cannot evict in-flight sessions even when they are the oldest", () => {
  const rows: Record<string, [number, number]> = {
    busyOld: [NOW - 900_000, 2],
    a: [NOW - 3000, 0],
    b: [NOW - 2000, 0],
    c: [NOW - 1000, 0],
  };
  const reaped = sessionsToReap(mk(rows), NOW, 3600_000, 2);
  assert.ok(!reaped.includes("busyOld"), "busy session is off limits");
  // Only 3 idle candidates exist and the cap wants size<=2, so the 2 oldest idle go.
  assert.deepEqual(reaped.sort(), ["a", "b"]);
});

test("does not double-count a session that is both expired and over the cap", () => {
  const reaped = sessionsToReap(mk({ x: [NOW - 9 * 3600_000, 0], y: [NOW - 5, 0] }), NOW, 3600_000, 1);
  assert.deepEqual(reaped, ["x"], "one entry, not two");
  assert.equal(new Set(reaped).size, reaped.length);
});

test("empty and all-busy maps yield nothing", () => {
  assert.deepEqual(sessionsToReap(new Map(), NOW), []);
  assert.deepEqual(sessionsToReap(mk({ a: [0, 1], b: [0, 3] }), NOW), []);
});
