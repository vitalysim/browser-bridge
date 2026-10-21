// Snapshot planning tests. The planning helpers live in the extension (they run in the service worker)
// but are pure, so they're pinned down here without a browser: cross-frame ref budgeting, dense
// disjoint ref ranges + routing, ax rank->ref assignment, and single-target selector picking.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateFrameBudgets,
  assignAxRefs,
  clampLimit,
  frameOffsets,
  pickSelectorTarget,
  routeRef,
  type LocateMatch,
} from "../../extension/src/snapshot-plan.js";

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

test("clampLimit defaults to 400 and clamps to 1..2000", () => {
  assert.equal(clampLimit(undefined), 400);
  assert.equal(clampLimit(null), 400);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(5000), 2000);
  assert.equal(clampLimit(123.7), 123);
});

test("a single frame gets min(count, limit)", () => {
  assert.deepEqual(allocateFrameBudgets([1000], 400), [400]);
  assert.deepEqual(allocateFrameBudgets([12], 400), [12]);
});

test("everything fits: every frame gets its full count", () => {
  assert.deepEqual(allocateFrameBudgets([100, 20, 5], 400), [100, 20, 5]);
});

test("a huge top frame cannot starve child frames", () => {
  const b = allocateFrameBudgets([5000, 30, 30], 400);
  assert.equal(b[1], 30);
  assert.equal(b[2], 30);
  assert.equal(b[0], 340);
  assert.equal(sum(b), 400);
});

test("many ad iframes cannot starve the top frame (children capped at half the budget)", () => {
  const counts = [1000, ...new Array(30).fill(20)];
  const b = allocateFrameBudgets(counts, 400);
  assert.equal(sum(b), 400);
  assert.ok(sum(b.slice(1)) <= 200, `children took ${sum(b.slice(1))}`);
  assert.ok(b[0] >= 200);
  assert.ok(b.slice(1).every((x) => x > 0), "every child frame still gets some refs");
});

test("budget unused by the top frame is water-filled to children", () => {
  const b = allocateFrameBudgets([10, 500, 500], 400);
  assert.equal(b[0], 10);
  assert.equal(sum(b), 400);
  assert.ok(Math.abs(b[1] - b[2]) <= 1);
});

test("never exceeds the limit or a frame's count, even with more frames than budget", () => {
  for (const [counts, limit] of [
    [[3, 3, 3, 3, 3, 3, 3, 3, 3, 3], 5],
    [[0, 0, 0], 400],
    [[1, 2000, 0, 7], 2000],
  ] as [number[], number][]) {
    const b = allocateFrameBudgets(counts, limit);
    assert.ok(sum(b) <= limit);
    b.forEach((x, i) => assert.ok(x >= 0 && x <= counts[i]));
  }
});

test("frame offsets give dense, disjoint ref ranges and routing finds the owner", () => {
  const budgets = [3, 0, 2];
  const offsets = frameOffsets(budgets);
  assert.deepEqual(offsets, [0, 3, 3]);
  const routes = [
    { frameId: 0, lo: 1, hi: 3 },
    { frameId: 42, lo: 4, hi: 5 },
  ];
  assert.equal(routeRef(routes, 1), 0);
  assert.equal(routeRef(routes, 3), 0);
  assert.equal(routeRef(routes, 4), 42);
  assert.equal(routeRef(routes, 6), null, "a ref past every range is from an older snapshot");
  assert.equal(routeRef([], 1), null);
});

test("assignAxRefs turns ranks below keep into refs and strips every rank", () => {
  const tree: any[] = [
    { role: "navigation", children: [{ role: "link", name: "A", pi: 1 }] },
    { role: "button", name: "Low", pi: 2 },
    { role: "dialog", children: [{ role: "button", name: "Pop", pi: 0 }] },
  ];
  const n = assignAxRefs(tree, 100, 2);
  assert.equal(n, 2);
  assert.equal(tree[2].children[0].ref, 101); // rank 0 (in the dialog) gets the first ref
  assert.equal(tree[0].children[0].ref, 102);
  assert.equal(tree[1].ref, undefined, "past the budget: listed, but no ref");
  assert.ok(!JSON.stringify(tree).includes('"pi"'));
  assert.equal(assignAxRefs(null, 0, 10), 0);
});

const m = (frameId: number, index: number, visible: boolean, inViewport = visible): LocateMatch => ({ frameId, index, visible, inViewport });

test("pickSelectorTarget: no matches", () => {
  assert.deepEqual(pickSelectorTarget([]), { chosen: null, count: 0, frames: 0 });
});

test("pickSelectorTarget: a single match has no note", () => {
  const r = pickSelectorTarget([m(0, 0, true)]);
  assert.equal(r.chosen?.index, 0);
  assert.equal(r.note, undefined);
});

test("pickSelectorTarget: skips a hidden duplicate (mobile nav) for the visible one", () => {
  const r = pickSelectorTarget([m(0, 0, false), m(0, 1, true)]);
  assert.equal(r.chosen?.index, 1);
  assert.equal(r.count, 2);
  assert.match(r.note!, /matched 2 elements/);
});

test("pickSelectorTarget: prefers the top frame over a widget iframe", () => {
  const r = pickSelectorTarget([m(0, 0, true, false), m(7, 0, true, true)]);
  assert.equal(r.chosen?.frameId, 0);
  assert.match(r.note!, /across 2 frames/);
  assert.match(r.note!, /top frame/);
});

test("pickSelectorTarget: a visible iframe match beats a hidden top-frame one", () => {
  const r = pickSelectorTarget([m(0, 0, false), m(7, 0, true)]);
  assert.equal(r.chosen?.frameId, 7);
});

test("pickSelectorTarget: within a frame, in-viewport beats offscreen", () => {
  const r = pickSelectorTarget([m(0, 0, true, false), m(0, 1, true, true)]);
  assert.equal(r.chosen?.index, 1);
});
