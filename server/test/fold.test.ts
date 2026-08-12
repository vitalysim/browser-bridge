// Fold-engine tests. The fold is the only surface where a bug is silent - a mislabeled or
// double-counted action just looks like something the human did. Everything here is pure: no
// browser, no sockets, no disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFoldState,
  defaultFoldOpts,
  foldEvent,
  foldFlush,
  foldNetRow,
  formatKey,
  type ElementRef,
  type RawEvent,
  type Staged,
} from "../src/watch.js";

const el = (over: Partial<ElementRef> = {}): ElementRef => ({
  tag: "input",
  selector: "#q",
  id: "q",
  label: "Search",
  ...over,
});

const env = { tabId: 5, frameId: 0 };

/** Type a string one character at a time, exactly as the listener reports it. */
function typeInto(state: ReturnType<typeof createFoldState>, target: ElementRef, text: string, t0 = 1000): Staged[] {
  const out: Staged[] = [];
  for (let i = 0; i < text.length; i++) {
    const ev: RawEvent = { t: t0 + i * 60, k: "input", el: target, value: text.slice(0, i + 1) };
    out.push(...foldEvent(state, env, ev));
  }
  return out;
}

test("a typing burst folds to exactly one action with the final value", () => {
  const state = createFoldState();
  const target = el();
  const mid = typeInto(state, target, "hello world");
  assert.equal(mid.length, 0, "nothing emits while the burst is still open");

  const done = foldFlush(state, 1000 + 11 * 60 + 5000);
  assert.equal(done.length, 1);
  const a = done[0] as any;
  assert.equal(a.kind, "input");
  assert.equal(a.value, "hello world");
  assert.equal(a.chars, 11, "one raw event per character was counted");
  assert.equal(a.target.selector, "#q");
});

test("typing into a second field finalizes the first", () => {
  const state = createFoldState();
  typeInto(state, el(), "abc");
  const out = typeInto(state, el({ selector: "#pw", id: "pw" }), "x", 5000);
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).value, "abc");
});

test("Enter commits the field before the key action", () => {
  const state = createFoldState();
  typeInto(state, el(), "abc");
  const out = foldEvent(state, env, { t: 2000, k: "key", key: "Enter" });
  const flushed = foldFlush(state, 9000);
  const kinds = [...out, ...flushed].map((a) => a.kind);
  assert.deepEqual(kinds, ["input", "key"], "input lands before the Enter that submitted it");
});

test("password fields are redacted under the auto default and raw under none", () => {
  const pw = el({ selector: "#pass", id: "pass", type: "password" });

  const auto = createFoldState();
  typeInto(auto, pw, "hunter2");
  const a = foldFlush(auto, 99999)[0] as any;
  assert.equal(a.redacted, true);
  assert.match(a.value, /^••••/);
  assert.ok(!a.value.includes("hunter2"));

  const raw = createFoldState(defaultFoldOpts({ redact: "none" }));
  typeInto(raw, pw, "hunter2");
  const b = foldFlush(raw, 99999)[0] as any;
  assert.equal(b.value, "hunter2", "redact:none is a real escape hatch, not a soft filter");
  assert.equal(b.redacted, undefined);
});

test("printable keys are dropped, special and modified keys are kept and collapsed", () => {
  assert.equal(formatKey({ t: 0, k: "key", key: "a" }), null);
  assert.equal(formatKey({ t: 0, k: "key", key: "Enter" }), "↵");
  assert.equal(formatKey({ t: 0, k: "key", key: "k", meta: true }), "⌘K");

  const state = createFoldState();
  for (let i = 0; i < 4; i++) foldEvent(state, env, { t: 1000 + i * 50, k: "key", key: "ArrowDown" });
  const out = foldFlush(state, 99999);
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).text, "↓");
  assert.equal((out[0] as any).repeat, 4, "a held arrow key is one action, not four");
});

test("a repeated navigation signal reports once", () => {
  const state = createFoldState();
  // The page's popstate and the service worker's webNavigation hint both describe the same nav.
  const a = foldEvent(state, env, { t: 1000, k: "nav", url: "https://x.test/a", via: "spa" });
  const b = foldEvent(state, env, { t: 1010, k: "nav", url: "https://x.test/a", via: "hint" });
  assert.equal(a.length, 1);
  assert.equal(b.length, 0, "same URL twice is one navigation");

  const c = foldEvent(state, env, { t: 2000, k: "nav", url: "https://x.test/b", via: "spa" });
  assert.equal(c.length, 1);
  assert.equal((c[0] as any).from, "https://x.test/a");
});

test("iframes and about:blank do not masquerade as navigations", () => {
  // The listener runs in every frame, so without this each iframe announces its own initial load as
  // a page navigation. Observed live as a stray `nav blank` line after every real navigation.
  const state = createFoldState();
  assert.equal(foldEvent(state, env, { t: 1000, k: "nav", url: "about:blank", via: "load" }).length, 0);
  assert.equal(
    foldEvent(state, { tabId: 5, frameId: 3 }, { t: 1100, k: "nav", url: "https://ads.test/frame", via: "load" }).length,
    0,
    "a subframe's own load is not a tab navigation"
  );
  // But a real route change inside a frame still counts, and the top frame always does.
  assert.equal(
    foldEvent(state, { tabId: 5, frameId: 3 }, { t: 1200, k: "nav", url: "https://app.test/route", via: "spa" }).length,
    1
  );
  assert.equal(foldEvent(state, env, { t: 1300, k: "nav", url: "https://app.test/top", via: "load" }).length, 1);
});

test("clicks carry the label the page captured, not a node id", () => {
  const state = createFoldState();
  const out = foldEvent(state, env, {
    t: 1000,
    k: "click",
    el: el({ tag: "button", selector: "#publish", id: "publish", label: "Publish" }),
    x: 10,
    y: 20,
  });
  assert.equal(out.length, 1);
  const a = out[0] as any;
  assert.equal(a.kind, "click");
  assert.equal(a.target.label, "Publish");
  assert.equal(a.target.selector, "#publish", "the selector is directly usable by the click/fill tools");
});

test("network rows keep meaningful requests and drop page-load noise", () => {
  const state = createFoldState();
  const keep = [
    { kind: "net" as const, method: "post", url: "https://x.test/api/x", type: "XHR", status: 200, ts: 1000 },
    { kind: "net" as const, method: "GET", url: "https://x.test/img.png", type: "Image", status: 500, ts: 1000 },
    { kind: "net" as const, method: "GET", url: "https://x.test/f.woff", type: "Font", failed: "net::ERR", ts: 1000 },
  ];
  const drop = [{ kind: "net" as const, method: "GET", url: "https://x.test/a.css", type: "Stylesheet", status: 200, ts: 1000 }];
  for (const r of keep) assert.equal(foldNetRow(state, env, r, 1100).length, 1, `kept ${r.url}`);
  for (const r of drop) assert.equal(foldNetRow(state, env, r, 1100).length, 0, `dropped ${r.url}`);
  assert.equal((foldNetRow(state, env, keep[0], 1100)[0] as any).method, "POST", "method is normalized");
});

test("other extensions' traffic is not the human's browsing", () => {
  // Observed live: an unrelated installed extension fired a stream of chrome-extension://invalid/
  // requests into every page, which buried the real ones.
  const state = createFoldState();
  const foreign = [
    { kind: "net" as const, method: "GET", url: "chrome-extension://invalid/", type: "Fetch", failed: "net::ERR_FAILED", ts: 1000 },
    { kind: "net" as const, method: "GET", url: "chrome-extension://abc/js/js.js", type: "Script", status: 200, ts: 1000 },
    { kind: "net" as const, method: "GET", url: "data:text/html,x", type: "Document", status: 200, ts: 1000 },
  ];
  for (const r of foreign) assert.equal(foldNetRow(state, env, r, 1100).length, 0, `dropped ${r.url}`);
});
