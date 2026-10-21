// Element-interaction logic tests. The injected bbAct helper (extension/src/dom-act.ts) is
// self-contained page code, so its DOM-free decision logic lives in an `L` object it returns for the
// "__logic" op; the service-worker-side helpers live in extension/src/act-logic.ts. No browser here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bbAct } from "../../extension/src/dom-act.ts";
import { parseKeyCombo, pickFocusedFrame, matchCdpFrame, keyInfo } from "../../extension/src/act-logic.ts";

const L = await bbAct("__logic", {});

test("mouseSequence: full realistic click order", () => {
  assert.deepEqual(
    L.mouseSequence(false).map((s: any) => s.type),
    ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "focus", "pointerup", "mouseup", "click"]
  );
  const seq = L.mouseSequence(false);
  const by = (t: string) => seq.find((s: any) => s.type === t);
  assert.equal(by("pointerdown").buttons, 1);
  assert.equal(by("mousedown").buttons, 1);
  assert.equal(by("pointerup").buttons, 0);
  assert.equal(by("pointerenter").bubbles, false);
  assert.equal(by("mouseenter").bubbles, false);
  assert.equal(by("click").bubbles, true);
});

test("mouseSequence: hover includes pointer events but no press", () => {
  const types = L.mouseSequence(true).map((s: any) => s.type);
  assert.ok(types.includes("pointerenter") && types.includes("pointermove"));
  assert.ok(!types.includes("pointerdown") && !types.includes("click"));
});

test("matchOption: value, then exact text, then case-insensitive trimmed text", () => {
  const opts = [
    { value: "", text: "Choose…" },
    { value: "CA", text: "California" },
    { value: "NY", text: " New  York " },
    { value: "ca-old", text: "CA" },
  ];
  assert.equal(L.matchOption(opts, "CA"), 1); // value wins over text "CA"
  assert.equal(L.matchOption(opts, "California"), 1);
  assert.equal(L.matchOption(opts, "new york"), 2);
  assert.equal(L.matchOption(opts, "ny"), 2); // case-insensitive value last
  assert.equal(L.matchOption(opts, "Texas"), -1);
});

test("splitMulti: JSON array or comma list", () => {
  assert.deepEqual(L.splitMulti('["a","b, c"]'), ["a", "b, c"]);
  assert.deepEqual(L.splitMulti("a, b ,c"), ["a", "b", "c"]);
});

test("parseBool", () => {
  for (const t of ["true", "on", "checked", "YES", "1"]) assert.equal(L.parseBool(t), true, t);
  for (const f of ["false", "off", "unchecked", "no", "0", ""]) assert.equal(L.parseBool(f), false, f);
  assert.equal(L.parseBool("maybe"), null);
});

test("normDate: ISO passes through, other forms are converted", () => {
  assert.equal(L.normDate("date", "2024-03-05"), "2024-03-05");
  assert.equal(L.normDate("date", "March 5, 2024"), "2024-03-05");
  assert.equal(L.normDate("date", "03/05/2024"), "2024-03-05");
  assert.equal(L.normDate("date", "2024-03-05T23:30:00Z"), "2024-03-05"); // prefix, no TZ shift
  assert.equal(L.normDate("date", "not a date"), null);
  assert.equal(L.normDate("date", ""), "");
  assert.equal(L.normDate("time", "3:30 PM"), "15:30");
  assert.equal(L.normDate("time", "12:05am"), "00:05");
  assert.equal(L.normDate("time", "9:07"), "09:07");
  assert.equal(L.normDate("time", "14:30"), "14:30");
  assert.equal(L.normDate("month", "March 2024"), "2024-03");
  assert.equal(L.normDate("datetime-local", "2024-03-05 14:30"), "2024-03-05T14:30");
  assert.equal(L.normDate("week", "2024-w10"), "2024-W10");
  assert.equal(L.normDate("week", "2024-03-05"), "2024-W10");
  assert.equal(L.normDate("week", "2021-01-01"), "2020-W53"); // ISO week-year
});

test("valueSticks: tolerates normalisation, rejects real mismatches", () => {
  assert.equal(L.valueSticks("text", "abc", "abc").ok, true);
  assert.equal(L.valueSticks("text", "abc", "").ok, false);
  assert.equal(L.valueSticks("number", "1.50", "1.5").ok, true);
  assert.equal(L.valueSticks("color", "#FF0000", "#ff0000").ok, true);
  assert.equal(L.valueSticks("time", "10:30:00", "10:30").ok, true);
  const masked = L.valueSticks("tel", "5551234567", "(555) 123-4567");
  assert.equal(masked.ok, true);
  assert.ok(masked.note);
  assert.equal(L.valueSticks("text", "Save", "Delete").ok, false);
});

test("fingerprints: equality and description", () => {
  const a = { tag: "button", role: "", name: "Save" };
  assert.equal(L.fpEqual(a, { ...a }), true);
  assert.equal(L.fpEqual(a, { ...a, name: "Delete" }), false);
  assert.equal(L.describeFp(a), '<button "Save">');
  assert.equal(L.describeFp({ tag: "div", role: "option", name: "x" }), '<div role=option "x">');
  assert.equal(L.describeFp(null), "<detached>");
});

test("tab order: positive tabindex first, then DOM order; wraps both ways", () => {
  assert.deepEqual(L.tabOrder([0, 2, 0, 1, 2]), [3, 1, 4, 0, 2]);
  assert.equal(L.nextTab(3, 2, false), 0);
  assert.equal(L.nextTab(3, 0, true), 2);
  assert.equal(L.nextTab(3, -1, false), 0);
  assert.equal(L.nextTab(3, -1, true), 2);
  assert.equal(L.nextTab(0, -1, false), -1);
});

test("implicit submission only for single-line inputs", () => {
  assert.equal(L.implicitSubmitType("text"), true);
  assert.equal(L.implicitSubmitType("email"), true);
  assert.equal(L.implicitSubmitType("checkbox"), false);
  assert.equal(L.implicitSubmitType("button"), false);
});

test("parseKeyCombo", () => {
  assert.deepEqual(parseKeyCombo("Enter"), { key: "Enter", code: "Enter", vk: 13, shift: false, ctrl: false, alt: false, meta: false, modifiers: 0 });
  const st = parseKeyCombo("Shift+Tab");
  assert.equal(st.key, "Tab");
  assert.equal(st.shift, true);
  assert.equal(st.modifiers, 8);
  const ca = parseKeyCombo("ctrl+a");
  assert.equal(ca.key, "a");
  assert.equal(ca.code, "KeyA");
  assert.equal(ca.ctrl, true);
  assert.equal(parseKeyCombo("+").key, "+");
  assert.equal(parseKeyCombo("ctrl++").key, "+");
  assert.equal(parseKeyCombo("Shift").key, "Shift");
  assert.equal(keyInfo("space").code, "Space");
});

test("pickFocusedFrame prefers the focused leaf frame", () => {
  assert.equal(
    pickFocusedFrame([
      { frameId: 0, hasFocus: true, activeIsFrame: true, activeIsBody: false },
      { frameId: 7, hasFocus: true, activeIsFrame: false, activeIsBody: false },
    ]),
    7
  );
  assert.equal(pickFocusedFrame([{ frameId: 0, hasFocus: true, activeIsFrame: false, activeIsBody: false }]), 0);
  // background window: nobody hasFocus - fall back to a frame with a real active element
  assert.equal(
    pickFocusedFrame([
      { frameId: 0, hasFocus: false, activeIsFrame: true, activeIsBody: false },
      { frameId: 3, hasFocus: false, activeIsFrame: false, activeIsBody: false },
      { frameId: 4, hasFocus: false, activeIsFrame: false, activeIsBody: true },
    ]),
    3
  );
  assert.equal(pickFocusedFrame([]), 0);
});

test("matchCdpFrame: unique URL match among child frames, fragment-insensitive", () => {
  const tree = {
    frame: { id: "MAIN", url: "https://a.test/" },
    childFrames: [
      { frame: { id: "F1", url: "https://b.test/widget" } },
      { frame: { id: "F2", url: "https://c.test/x" }, childFrames: [{ frame: { id: "F3", url: "https://c.test/x" } }] },
    ],
  };
  assert.equal(matchCdpFrame(tree, "https://b.test/widget#top"), "F1");
  assert.equal(matchCdpFrame(tree, "https://c.test/x"), null); // ambiguous
  assert.equal(matchCdpFrame(tree, "https://a.test/"), null); // never the main frame
});
