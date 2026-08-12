// WatchSession tests: the cursor contract, ring eviction, causality chaining, and gap reporting.
// These are the properties a polling agent depends on and cannot verify for itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ActionRing,
  WatchSession,
  defaultWatchOpts,
  renderActions,
  type Action,
  type ElementRef,
} from "../src/watch.js";

const el = (over: Partial<ElementRef> = {}): ElementRef => ({ tag: "button", selector: "#go", label: "Go", ...over });
const opts = () => defaultWatchOpts({ network: true, reorderMs: 0 });

function session(now = 1000): WatchSession {
  return new WatchSession("w1", 5, opts(), now);
}

/** Feed events and drain everything, so tests never depend on the reorder timer. */
function feed(s: WatchSession, events: any[], tabId = 5): void {
  s.ingest({ tabId, frameId: 0 }, events, Number.MAX_SAFE_INTEGER);
  s.pump(Infinity, true);
}

test("seq is monotone and read(since) returns exactly what follows the cursor", () => {
  const s = session();
  feed(s, [
    { t: 1000, k: "click", el: el() },
    { t: 1100, k: "click", el: el({ selector: "#b" }) },
    { t: 1200, k: "click", el: el({ selector: "#c" }) },
  ]);

  const first = s.read(0, {}, 100, 40_000);
  assert.equal(first.actions.length, 3);
  assert.deepEqual(
    first.actions.map((a) => a.seq),
    [1, 2, 3],
    "seq starts at 1 and increments by one"
  );

  const next = s.read(first.scannedTo, {}, 100, 40_000);
  assert.equal(next.actions.length, 0, "a cursor at the head returns nothing");

  feed(s, [{ t: 1300, k: "click", el: el({ selector: "#d" }) }]);
  const after = s.read(first.scannedTo, {}, 100, 40_000);
  assert.equal(after.actions.length, 1);
  assert.equal(after.actions[0].seq, 4);
});

test("a cursor from a previous incarnation of the same watch is detectably stale", () => {
  // Regression: the extension keeps its watch group across a SERVER restart, so the watchId is
  // stable while the seq counter restarts at 0. Verified live before the epoch existed: a
  // pre-restart cursor was accepted as current and returned 0 actions with dropped:0 while the
  // human was actively browsing - silently blind, which is the exact failure the id was meant to
  // prevent. The epoch is what makes the two incarnations distinguishable.
  const before = new WatchSession("w1", 5, opts(), 1000);
  const after = new WatchSession("w1", 5, opts(), 2000); // same watchId, new server process

  assert.equal(before.watchId, after.watchId);
  assert.notEqual(before.epoch, after.epoch, "same watch, different incarnation");
  assert.notEqual(before.cursorAt, after.cursorAt);

  feed(before, [
    { t: 1000, k: "click", el: el() },
    { t: 1100, k: "click", el: el({ selector: "#b" }) },
  ]);
  const staleCursor = before.cursorAt; // "w1.<epoch1>:2"
  feed(after, [{ t: 3000, k: "click", el: el({ selector: "#c" }) }]);

  // The seq in the stale cursor (2) is past the new session's head (1). Honoring it returns nothing.
  assert.equal(after.read(2, {}, 100, 40_000).actions.length, 0, "this is the silent-blindness shape");
  // So the caller must be able to tell it is stale from the cursor alone, without guessing.
  assert.ok(staleCursor.startsWith("w1."));
  assert.notEqual(staleCursor.split(":")[0], `${after.watchId}.${after.epoch}`);
  // Treated as stale, the reader starts over and sees the real activity.
  assert.equal(after.read(0, {}, 100, 40_000).actions.length, 1);
});

test("two reads with the same cursor are identical", () => {
  const s = session();
  feed(s, [
    { t: 1000, k: "click", el: el() },
    { t: 1100, k: "nav", url: "https://x.test/a" },
  ]);
  const a = s.read(0, {}, 100, 40_000);
  const b = s.read(0, {}, 100, 40_000);
  assert.equal(JSON.stringify(a.actions), JSON.stringify(b.actions), "reads are non-destructive and stable");
});

test("a filtered read still advances the cursor past what it skipped", () => {
  const s = session();
  feed(s, [
    { t: 1000, k: "click", el: el() },
    { t: 1100, k: "nav", url: "https://x.test/a" },
    { t: 1200, k: "click", el: el({ selector: "#b" }) },
  ]);
  const navOnly = s.read(0, { include: new Set(["nav" as const]) }, 100, 40_000);
  assert.equal(navOnly.actions.length, 1);
  assert.equal(navOnly.scannedTo, 3, "the cursor is past the trailing click, so it is never rescanned");
});

test("a reader that fell behind the ring is told how much it missed", () => {
  const s = new WatchSession("w1", 5, defaultWatchOpts({ ringCount: 3, reorderMs: 0 }), 1000);
  for (let i = 0; i < 8; i++) feed(s, [{ t: 1000 + i, k: "click", el: el({ selector: `#b${i}` }) }]);

  const late = s.read(1, {}, 100, 40_000);
  assert.ok(late.dropped > 0, "the gap is reported, not silently skipped");
  assert.equal(late.dropped, 4, "seqs 2..5 were evicted before this reader came back");
  assert.equal(late.actions.length, 3, "only what the ring still holds");
});

test("the ring is bounded by bytes as well as count", () => {
  const ring = new ActionRing(10_000, 2_000);
  for (let i = 1; i <= 200; i++) {
    ring.push({ seq: i, ts: i, tabId: 5, kind: "console", level: "error", text: "x".repeat(200) } as Action);
  }
  assert.ok(ring.size < 200, "the byte cap evicted before the count cap was near");
  assert.ok(ring.byteSize <= 2_000 + 400, "stays within the byte budget");
});

test("causality chains through the navigation instead of fanning out from the click", () => {
  const s = session();
  feed(s, [
    { t: 1000, k: "click", el: el({ selector: "#publish", label: "Publish" }) },
    { t: 1100, k: "nav", url: "https://x.test/saved" },
  ]);
  s.ingestNet({ tabId: 5 }, [{ kind: "net", method: "POST", url: "https://x.test/save", type: "XHR", status: 302, ts: 1200 }], 1250);
  s.ingestNet({ tabId: 5 }, [{ kind: "net", method: "GET", url: "https://x.test/after", type: "XHR", status: 200, ts: 1400 }], 1450);
  s.pump(Infinity, true);

  const all = s.read(0, {}, 100, 40_000).actions;
  const click = all.find((a) => a.kind === "click")!;
  const nav = all.find((a) => a.kind === "nav")!;
  const nets = all.filter((a) => a.kind === "net");

  assert.equal(nav.causedBy, click.seq, "the navigation is attributed to the click");
  assert.equal(nets.length, 2);
  for (const n of nets) {
    assert.equal(n.causedBy, nav.seq, "requests after the nav attach to the nav, not back to the click");
  }
});

test("a request with no preceding user action is left unattributed", () => {
  const s = session();
  s.ingestNet({ tabId: 5 }, [{ kind: "net", method: "GET", url: "https://x.test/poll", type: "XHR", status: 200, ts: 9000 }], 9050);
  s.pump(Infinity, true);
  const a = s.read(0, {}, 100, 40_000).actions[0];
  assert.equal(a.causedBy, undefined, "background polling is not blamed on an unrelated click");
});

test("losing the extension writes a gap into the timeline", () => {
  const s = session();
  feed(s, [{ t: 1000, k: "click", el: el() }]);
  s.noteGap("extension-disconnected", 14_200, 20_000);
  s.pump(Infinity, true);

  const actions = s.read(0, {}, 100, 40_000).actions;
  const gap = actions.find((a) => a.kind === "gap") as any;
  assert.ok(gap, "blindness is a first-class entry - silence and breakage must not look alike");
  assert.equal(gap.reason, "extension-disconnected");
  assert.equal(gap.ms, 14_200);
});

test("a reconnected socket does not mean capture is alive", () => {
  // Regression: toggling the extension off and on cleared its watch group, so every page disarmed
  // itself on the hello handshake and nothing was captured - while health said state:"live" with no
  // warnings, because the WebSocket had reconnected. Verified live against a real browser. Socket
  // health is not capture health, and the honest answer has to win.
  const s = session();
  feed(s, [{ t: 1000, k: "click", el: el() }]);
  assert.equal(s.health(true, 2000).state, "live");

  s.markBrowserLost(3000); // the extension reconnected but never announced this watch

  const h = s.health(true, 4000);
  assert.equal(h.state, "blind", "connected socket, dead capture -> blind");
  assert.ok(
    h.warnings.some((w) => /no longer has this watch/.test(w)),
    "and it says why, with the action to take"
  );
  const gap = s.read(0, {}, 100, 40_000).actions.find((a) => a.kind === "gap") as any;
  assert.equal(gap?.reason, "watch-lost", "the blind window is in the timeline, not only in health");

  s.markBrowserLost(5000);
  const gaps = s.read(0, {}, 100, 40_000).actions.filter((a) => a.kind === "gap");
  assert.equal(gaps.length, 1, "reported once, not once per reconnect");

  s.markBrowserFound();
  assert.equal(s.health(true, 6000).state, "live", "recovers when the extension announces it again");
});

test("health reports blind when the extension is gone", () => {
  const s = session();
  feed(s, [{ t: 1000, k: "click", el: el() }]);
  assert.equal(s.health(true, 2000).state, "live");
  const blind = s.health(false, 2000);
  assert.equal(blind.state, "blind");
  assert.ok(blind.warnings.some((w) => /disconnected/.test(w)));
});

test("the char budget stops at an action boundary and reports the remainder", () => {
  const s = session();
  const events = [];
  for (let i = 0; i < 50; i++) events.push({ t: 1000 + i, k: "console", level: "error", text: "y".repeat(300) });
  feed(s, events);

  const page = s.read(0, {}, 100, 2_000);
  assert.ok(page.actions.length > 0 && page.actions.length < 50, "truncated, but not to nothing");
  assert.equal(page.more, true);
  assert.ok(page.remaining > 0);
  // The cursor must resume exactly where the page ended - no gap, no overlap.
  const rest = s.read(page.scannedTo, {}, 100, 40_000);
  assert.equal(page.actions.length + rest.actions.length, 50);
  assert.equal(rest.actions[0].seq, page.actions[page.actions.length - 1].seq + 1);
});

test("multi-tab timelines interleave and stay filterable", () => {
  const s = session();
  s.addTab(9, 1050);
  feed(s, [{ t: 1000, k: "click", el: el() }], 5);
  feed(s, [{ t: 1100, k: "click", el: el({ selector: "#other" }) }], 9);
  s.pump(Infinity, true);

  const merged = s.read(0, {}, 100, 40_000).actions;
  assert.deepEqual(
    merged.filter((a) => a.kind === "click").map((a) => a.tabId),
    [5, 9]
  );
  const justNine = s.read(0, { tabId: 9 }, 100, 40_000);
  assert.ok(justNine.actions.every((a) => a.tabId === 9));

  const text = renderActions(merged, { multiTab: true });
  assert.match(text, /\[t9\]/, "multi-tab output labels which tab each line came from");
});

test("rendering is one compact line per action", () => {
  const s = session();
  feed(s, [
    { t: 1000, k: "click", el: el({ selector: "#publish", label: "Publish" }) },
    { t: 1100, k: "nav", url: "https://x.test/wp-admin/post.php?post=4" },
  ]);
  const text = renderActions(s.read(0, {}, 100, 40_000).actions, { multiTab: false });
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /click\s+<button#go>|click\s+<button>/);
  assert.match(lines[0], /"Publish"/);
  assert.match(lines[1], /nav\s+\/wp-admin\/post\.php/);
});
