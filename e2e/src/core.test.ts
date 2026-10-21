// Core tool coverage: every navigation / reading / interaction / capture tool, each asserted against
// real page state (page JS counters, DOM values, files on disk, image dimensions), plus key options and
// error paths. Own harness (own server, browser, fixture server); fixtures are e2e/fixtures/core-*.
import { before, after } from "node:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { Harness, E2E_DIR, trim } from "./harness.js";
import { scenario as defineScenario, printSummary, findEl, type Ctx } from "./scenario.js";

let h: Harness;
const scenario = (name: string, fn: (c: Ctx) => Promise<void>, opts?: { timeout?: number }) => defineScenario(() => h, `core:${name}`, fn, opts);

let outDir = "";
before(async () => {
  h = new Harness({ logName: "server-core.log" });
  try {
    await h.setup();
  } catch (e) {
    await h.teardown();
    throw e;
  }
  outDir = join(h.tmpRoot, "out");
  mkdirSync(outDir, { recursive: true });
  console.log(`[e2e:core] bridge :${h.bridgePort}  fixtures :${h.fixturePort}  tools=${h.toolSchemas.size}`);
}, { timeout: 90_000 });

after(async () => {
  printSummary();
  await h?.teardown();
}, { timeout: 60_000 });

// ---------------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nm = (e: any) => String(e?.name ?? e?.label ?? "");
const byName = (re: RegExp) => (e: any) => re.test(nm(e));

/** A real (decodable) RGBA PNG of w×h, so the page can load it as an <img> and report naturalWidth. */
function makePng(w: number, hgt: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows: Buffer[] = [];
  for (let y = 0; y < hgt; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) row.set([200, 30 * y, 40 * x, 255], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDims(buf: Buffer): { width: number; height: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < buf.length) {
    if (buf[o] !== 0xff) return null;
    const marker = buf[o + 1];
    const len = buf.readUInt16BE(o + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
    o += 2 + len;
  }
  return null;
}

const imageOf = (r: any) => r.content?.find((c: any) => c.type === "image");
const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** Track a tab opened outside c.open so cleanup closes it. */
function track(c: Ctx, r: any): number {
  const id = r.json?.tabId;
  if (typeof id === "number") c.tabs.push(id);
  return id;
}

/**
 * Chrome's "is being debugged" infobar resizes every tab's viewport when any debugger session comes or
 * goes (earlier scenarios attach; their tabs close at cleanup). Detach every session and wait until the
 * tab's innerHeight stops changing, so viewport-size assertions measure a settled layout.
 */
async function settleViewport(c: Ctx, tabId: number, detachAll = true): Promise<{ iw: number; ih: number }> {
  if (detachAll) {
    const st = await c.call("debugger_status", {});
    for (const s of st.json?.sessions ?? []) await c.call("debugger_detach", { tabId: s.tabId });
  }
  let last: any = null;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const v = await c.evalJs(tabId, "({iw: innerWidth, ih: innerHeight})");
    if (last && v?.ih === last.ih && v?.iw === last.iw) return v;
    last = v;
  }
  return last;
}

async function tabsList(c: Ctx, short = false): Promise<any[]> {
  const r = await c.call("tabs_list", short ? { short: true } : {});
  return Array.isArray(r.json) ? r.json : [];
}

// ===================================================================================================
// Tabs
// ===================================================================================================

scenario("tab_new-waitUntil-and-regularWindow", async (c) => {
  const urlA = h.fixtureUrl("core-nav-a.html");
  const load = await c.call("tab_new", { url: urlA, waitUntil: "load" });
  track(c, load);
  c.expect(load.json?.title === "Core Nav A" && load.json?.url === urlA, `waitUntil:load -> ${trim(load.text, 200)}`);
  c.expect(!load.json?.loadTimedOut, "waitUntil:load reported loadTimedOut on a trivial page");
  const ready = await c.evalJs(load.json.tabId, "document.readyState");
  c.expect(ready === "complete", `after waitUntil:load readyState=${ready}`);

  const dcl = await c.call("tab_new", { url: h.fixtureUrl("core-nav-b.html"), waitUntil: "domcontentloaded" });
  track(c, dcl);
  c.expect(typeof dcl.json?.tabId === "number" && !dcl.isError, `waitUntil:domcontentloaded -> ${trim(dcl.text, 200)}`);
  c.expect((await c.evalJs(dcl.json.tabId, "document.getElementById('marker').textContent")) === "marker-B", "domcontentloaded tab has no parsed DOM");

  // waitUntil:none must return before a never-finishing document loads.
  const none = await c.call("tab_new", { url: h.fixtureUrl("hang"), waitUntil: "none" }, { timeoutMs: 15_000 });
  track(c, none);
  c.note(`tab_new(/hang, none) ${none.ms}ms`);
  c.expect(typeof none.json?.tabId === "number", `waitUntil:none -> ${trim(none.text, 200)}`);
  c.expect(none.ms < 5_000, `waitUntil:none took ${none.ms}ms on a never-loading page`);

  const reg = await c.call("tab_new", { url: urlA, regularWindow: true });
  track(c, reg);
  c.expect(reg.json?.incognito === false && reg.json?.title === "Core Nav A", `regularWindow -> ${trim(reg.text, 200)}`);
  const row = (await tabsList(c)).find((t) => t.id === reg.json?.tabId);
  c.expect(row && typeof row.windowId === "number" && row.incognito === false, `regularWindow tab not listed as a normal-window tab: ${JSON.stringify(row)}`);
});

scenario("tabs_list-full-and-short", async (c) => {
  const tabId = await c.open("core-nav-a.html");
  const full = await tabsList(c);
  const row = full.find((t) => t.id === tabId);
  c.expect(row?.url === h.fixtureUrl("core-nav-a.html") && row?.title === "Core Nav A" && typeof row?.active === "boolean", `full row: ${JSON.stringify(row)}`);
  const short = await tabsList(c, true);
  const srow = short.find((t) => t.id === tabId);
  c.expect(srow?.origin === `http://127.0.0.1:${h.fixturePort}`, `short row origin: ${JSON.stringify(srow)}`);
  c.expect(srow && !("url" in srow) && !("windowId" in srow), `short row leaks url/windowId: ${JSON.stringify(srow)}`);
  c.expect(srow?.title === "Core Nav A", `short row title: ${JSON.stringify(srow)}`);
});

scenario("tab_activate", async (c) => {
  const a = await c.open("core-nav-a.html");
  const b = await c.open("core-nav-b.html");
  c.expect((await tabsList(c)).find((t) => t.id === b)?.active === true, "newest tab is not active after tab_new");
  const r = await c.call("tab_activate", { tabId: a });
  c.expect(r.json?.ok === true && r.json?.title === "Core Nav A", `tab_activate -> ${trim(r.text, 160)}`);
  const list = await tabsList(c);
  c.expect(list.find((t) => t.id === a)?.active === true, "tab A not active after tab_activate");
  c.expect(list.find((t) => t.id === b)?.active === false, "tab B still active after activating A");
  // Default target (no tabId) is now A.
  const pt = await c.call("get_page_text", {});
  c.expect(/marker-A/.test(pt.json?.text ?? ""), `default tab after activate is not A: ${trim(pt.text, 120)}`);
  const bad = await c.call("tab_activate", { tabId: 987654321 });
  c.expect(bad.isError, `tab_activate on a missing tab did not error: ${trim(bad.text, 160)}`);
});

scenario("tab_close-tabId-and-tabIds", async (c) => {
  const a = await c.open("core-nav-a.html");
  const b = await c.open("core-nav-b.html");
  const d = await c.open("core-nav-a.html");
  const one = await c.call("tab_close", { tabId: a });
  c.expect(JSON.stringify(one.json?.closed) === JSON.stringify([a]), `tab_close(tabId) -> ${trim(one.text, 160)}`);
  let ids = (await tabsList(c)).map((t) => t.id);
  c.expect(!ids.includes(a) && ids.includes(b), `after closing A: ${JSON.stringify(ids)}`);
  const many = await c.call("tab_close", { tabIds: [b, d] });
  c.expect(many.json?.closed?.length === 2 && many.json?.closed.includes(b) && many.json?.closed.includes(d), `tab_close(tabIds) -> ${trim(many.text, 160)}`);
  ids = (await tabsList(c)).map((t) => t.id);
  c.expect(!ids.includes(b) && !ids.includes(d), `tabs still listed after tab_close(tabIds): ${JSON.stringify(ids)}`);
  c.tabs = c.tabs.filter((t) => ![a, b, d].includes(t));
  const missing = await c.call("tab_close", { tabIds: [987654321] });
  c.expect(missing.json?.failed?.[0]?.tabId === 987654321 && missing.json?.closed?.length === 0, `closing a missing tab: ${trim(missing.text, 160)}`);
  const none = await c.call("tab_close", {});
  c.expect(none.isError && /tabId or tabIds/i.test(none.text), `tab_close({}) -> ${trim(none.text, 160)}`);
});

// ===================================================================================================
// Navigation
// ===================================================================================================

scenario(
  "navigate-waitUntil-back-forward",
  async (c) => {
    const tabId = await c.open("core-nav-a.html");
    const urlB = h.fixtureUrl("core-nav-b.html");
    const n1 = await c.call("navigate", { url: urlB, tabId, waitUntil: "load" });
    c.expect(n1.json?.url === urlB && n1.json?.title === "Core Nav B" && n1.json?.navigated !== false, `navigate load -> ${trim(n1.text, 200)}`);
    c.expect((await c.evalJs(tabId, "document.readyState")) === "complete", "not complete after waitUntil:load");

    const urlA = h.fixtureUrl("core-nav-a.html");
    const n2 = await c.call("navigate", { url: urlA, tabId, waitUntil: "domcontentloaded" });
    c.expect(n2.json?.url === urlA && !n2.isError, `navigate domcontentloaded -> ${trim(n2.text, 200)}`);
    c.expect((await c.evalJs(tabId, "document.getElementById('marker').textContent")) === "marker-A", "DOM not parsed after domcontentloaded");

    const n3 = await c.call("navigate", { url: urlB, tabId, waitUntil: "none" });
    c.expect(!n3.isError && n3.json?.tabId === tabId, `navigate none -> ${trim(n3.text, 200)}`);
    const w = await c.call("wait_for", { text: "marker-B", tabId, timeoutMs: 5_000 });
    c.expect(w.json?.found === true, `page B never appeared after waitUntil:none: ${trim(w.text, 160)}`);
    // history is now A(open) -> B -> A -> B
    const back = await c.call("go_back", { tabId });
    c.expect(!back.isError, `go_back -> ${trim(back.text, 160)}`);
    c.expect((await c.evalJs(tabId, "location.pathname")) === "/core-nav-a.html", "go_back did not return to A");
    const back2 = await c.call("go_back", { tabId });
    c.expect(!back2.isError && (await c.evalJs(tabId, "location.pathname")) === "/core-nav-b.html", `second go_back -> ${trim(back2.text, 160)}`);
    const fwd = await c.call("go_forward", { tabId });
    c.expect(!fwd.isError, `go_forward -> ${trim(fwd.text, 160)}`);
    c.expect((await c.evalJs(tabId, "document.getElementById('marker').textContent")) === "marker-A", "go_forward did not move to A");

    // A never-finishing document: the load wait is capped (~20s) and reported, not hung.
    const hang = await c.call("navigate", { url: h.fixtureUrl("hang"), tabId, waitUntil: "load" }, { timeoutMs: 40_000 });
    c.note(`navigate(/hang, load) ${hang.ms}ms -> ${trim(hang.text, 120)}`);
    c.expect(hang.json?.loadTimedOut === true, `navigate to a never-loading page did not report loadTimedOut: ${trim(hang.text, 200)}`);
    const hangNone = await c.call("navigate", { url: h.fixtureUrl("hang") + "?2", tabId, waitUntil: "none" }, { timeoutMs: 15_000 });
    c.expect(!hangNone.isError && hangNone.ms < 5_000, `navigate(/hang, none) took ${hangNone.ms}ms: ${trim(hangNone.text, 160)}`);
  },
  { timeout: 120_000 }
);

// ===================================================================================================
// Reading
// ===================================================================================================

scenario("get_page_text-hidden-and-paging", async (c) => {
  const tabId = await c.open("core-text.html");
  const vis = await c.call("get_page_text", { tabId });
  c.expect(vis.json?.title === "Core Text" && /CORE_VISIBLE_TEXT/.test(vis.json?.text) && /CORE_END_MARKER/.test(vis.json?.text), `default text: ${trim(vis.text, 160)}`);
  c.expect(!/CORE_HIDDEN_TEXT/.test(vis.json?.text ?? ""), "display:none text leaked into the default (innerText) read");
  c.expect(vis.json?.nextOffset === null && vis.json?.offset === 0, `short page should be one page: offset=${vis.json?.offset} nextOffset=${vis.json?.nextOffset}`);
  const hid = await c.call("get_page_text", { tabId, includeHidden: true });
  c.expect(/CORE_HIDDEN_TEXT/.test(hid.json?.text ?? ""), `includeHidden missed display:none text: ${trim(hid.text, 160)}`);

  const full: string = vis.json?.text ?? "";
  const total = vis.json?.totalChars;
  c.expect(total === full.length && total > 4000, `totalChars=${total} text.length=${full.length}`);
  let offset = 0;
  let pages = 0;
  let joined = "";
  while (pages < 20) {
    const p = await c.call("get_page_text", { tabId, offset, maxChars: 1000 });
    pages++;
    c.expect(p.json?.offset === offset && p.json?.totalChars === total, `page ${pages}: offset ${p.json?.offset} (want ${offset}) total ${p.json?.totalChars}`);
    c.expect((p.json?.text ?? "").length <= 1000, `page ${pages} longer than maxChars: ${(p.json?.text ?? "").length}`);
    joined += p.json?.text ?? "";
    if (p.json?.nextOffset == null) break;
    c.expect(p.json.nextOffset === offset + p.json.text.length, `nextOffset ${p.json.nextOffset} != offset+len ${offset + p.json.text.length}`);
    offset = p.json.nextOffset;
  }
  c.note(`paged ${total} chars in ${pages} pages`);
  c.expect(pages === Math.ceil(total / 1000), `took ${pages} pages for ${total} chars at maxChars 1000`);
  c.expect(joined === full, "pages concatenated != the single-call text");
  const past = await c.call("get_page_text", { tabId, offset: total + 500 });
  c.expect(past.json?.text === "" && past.json?.nextOffset === null, `offset past the end: ${trim(past.text, 160)}`);
  const bad = await c.call("get_page_text", { tabId, maxChars: 0 });
  c.expect(bad.isError, `maxChars:0 accepted: ${trim(bad.text, 120)}`);
});

scenario("snapshot-limit-filter-viewport-modal-deep", async (c) => {
  const tabId = await c.open("core-snap.html");
  const all = await c.call("snapshot", { tabId });
  const els: any[] = all.json?.elements ?? [];
  const alpha = findEl(els, byName(/Alpha action/));
  const below = findEl(els, byName(/Below the fold/));
  c.expect(alpha && typeof alpha.ref === "number" && alpha.inViewport !== false, `Alpha: ${JSON.stringify(alpha)}`);
  c.expect(below && below.inViewport === false, `below-fold button missing or marked in viewport: ${JSON.stringify(below)}`);
  c.expect(findEl(els, byName(/Search box/)), "aria-labelled input missing");
  c.expect(!findEl(els, byName(/Closed shadow button/)), "a shallow snapshot should not reach a CLOSED shadow root");
  c.expect(typeof all.json?.count === "number" && all.json.count === els.length, `count=${all.json?.count} elements=${els.length}`);

  const lim = await c.call("snapshot", { tabId, limit: 2 });
  c.expect(lim.json?.elements?.length === 2 && lim.json?.truncated === true && lim.json?.total > 2, `limit:2 -> count=${lim.json?.elements?.length} truncated=${lim.json?.truncated} total=${lim.json?.total}`);

  const fil = await c.call("snapshot", { tabId, filter: "alpha" });
  const fe: any[] = fil.json?.elements ?? [];
  c.expect(fe.length >= 1 && fe.every((e) => /alpha/i.test(JSON.stringify(e))), `filter:'alpha' -> ${trim(JSON.stringify(fe.map(nm)), 200)}`);
  c.expect(!findEl(fe, byName(/Beta action/)), "filter kept a non-matching element");

  const vp = await c.call("snapshot", { tabId, viewportOnly: true });
  const ve: any[] = vp.json?.elements ?? [];
  c.expect(findEl(ve, byName(/Alpha action/)) && !findEl(ve, byName(/Below the fold/)), `viewportOnly -> ${trim(JSON.stringify(ve.map(nm)), 200)}`);

  // deep: closed shadow root, clicked through its deep ref with trusted:true
  const deep = await c.call("snapshot", { tabId, deep: true });
  const closedBtn = findEl(deep.json?.elements ?? [], byName(/Closed shadow button/));
  c.expect(closedBtn && typeof closedBtn.ref === "number", `deep snapshot missed the closed-shadow button: ${trim(deep.text, 200)}`);
  if (closedBtn) {
    const ck = await c.call("click", { ref: closedBtn.ref, trusted: true, tabId });
    c.expect((await c.evalJs(tabId, "window.__closedClicks")) === 1, `trusted click on a deep ref did not land: ${trim(ck.text, 160)}`);
  }

  // modal: elements behind it are marked, modalOnly drops them
  await c.evalJs(tabId, "openModal(), true");
  const m = await c.call("snapshot", { tabId });
  const me: any[] = m.json?.elements ?? [];
  const okBtn = findEl(me, byName(/Modal OK/));
  c.expect(okBtn && !okBtn.behindModal, `modal OK: ${JSON.stringify(okBtn)}`);
  c.expect(me[0] && /Modal/.test(nm(me[0])), `open dialog not listed first: first=${JSON.stringify(me[0])}`);
  c.expect(findEl(me, byName(/Alpha action/))?.behindModal === true, `Alpha behind the modal not marked behindModal: ${JSON.stringify(findEl(me, byName(/Alpha action/)))}`);
  const mo = await c.call("snapshot", { tabId, modalOnly: true });
  const moe: any[] = mo.json?.elements ?? [];
  c.expect(moe.length >= 2 && moe.every((e) => /Modal/.test(nm(e))), `modalOnly -> ${trim(JSON.stringify(moe.map(nm)), 200)}`);
});

scenario("ax_snapshot", async (c) => {
  const tabId = await c.open("core-form.html");
  const r = await c.call("ax_snapshot", { tabId });
  c.expect(!r.isError && /button "Plain button"[^\n]*\[ref=\d+\]/.test(r.text), `ax_snapshot has no ref'd Plain button: ${trim(r.text, 300)}`);
  c.expect(/textbox "Name"/.test(r.text), `labelled textbox missing: ${trim(r.text, 300)}`);
  c.expect(/Core Form|form/i.test(r.text), "no document/form structure");
  const io = await c.call("ax_snapshot", { tabId, interactiveOnly: true });
  c.expect(/button "Plain button"/.test(io.text), `interactiveOnly dropped an interactive node: ${trim(io.text, 200)}`);
  // interactiveOnly trims non-interactive structure (headings, paragraphs) but keeps the link.
  const navTab = await c.open("core-nav-a.html");
  const navFull = await c.call("ax_snapshot", { tabId: navTab });
  const navIo = await c.call("ax_snapshot", { tabId: navTab, interactiveOnly: true });
  c.expect(/heading "Page A"/.test(navFull.text) && /link "to B"[^\n]*\[ref=\d+\]/.test(navFull.text), `full ax tree: ${trim(navFull.text, 200)}`);
  c.expect(!/heading "Page A"/.test(navIo.text) && /link "to B"/.test(navIo.text), `interactiveOnly kept the heading or lost the link: ${trim(navIo.text, 200)}`);
  const ref = Number(/button "Plain button"[^\n]*\[ref=(\d+)\]/.exec(io.text)?.[1]);
  if (c.expect(Number.isFinite(ref), "no ref for Plain button")) {
    await c.call("click", { ref, tabId });
    c.expect((await c.evalJs(tabId, "window.__plainClicks")) === 1, "clicking an ax_snapshot ref did not run the handler");
  }
  const lim = await c.call("ax_snapshot", { tabId, limit: 1 });
  const refs = lim.text.match(/\[ref=\d+\]/g) ?? [];
  c.expect(refs.length === 1, `limit:1 produced ${refs.length} refs`);
});

// ===================================================================================================
// Interaction
// ===================================================================================================

scenario("click-ref-selector-trusted-withSnapshot-errors", async (c) => {
  const tabId = await c.open("core-form.html");
  const { elements } = await c.snapshot(tabId);
  const btn = findEl(elements, byName(/Plain button/));
  if (!btn) throw new Error("Plain button not in snapshot");
  const byRef = await c.call("click", { ref: btn.ref, tabId });
  c.expect(byRef.json?.via !== "trusted" && (await c.evalJs(tabId, "window.__plainClicks")) === 1, `click(ref) -> ${trim(byRef.text, 160)}`);
  const bySel = await c.call("click", { selector: "#btn-plain", tabId });
  c.expect(!bySel.isError && (await c.evalJs(tabId, "window.__plainClicks")) === 2, `click(selector) -> ${trim(bySel.text, 160)}`);
  const tr = await c.call("click", { selector: "#btn-plain", trusted: true, tabId });
  c.expect(tr.json?.via === "trusted" && (await c.evalJs(tabId, "window.__plainClicks")) === 3, `click(trusted) -> ${trim(tr.text, 160)}`);
  const ws = await c.call("click", { selector: "#btn-plain", withSnapshot: true, tabId });
  const snapEls: any[] = ws.json?.snapshot?.elements ?? [];
  c.expect(findEl(snapEls, byName(/Plain button/)), `withSnapshot has no elements: ${trim(JSON.stringify(ws.json?.snapshot), 160)}`);
  c.expect((await c.evalJs(tabId, "document.getElementById('plain-out').textContent")) === "clicked 4", "4th click not reflected in DOM");

  const missing = await c.call("click", { selector: "#does-not-exist", timeoutMs: 500, tabId });
  c.expect(missing.json?.notActionable === true || missing.isError, `click on a missing element: ${trim(missing.text, 160)}`);
  c.expect(missing.ms < 5_000, `missing-element click ignored timeoutMs:500 (${missing.ms}ms)`);
  const neither = await c.call("click", { tabId });
  c.expect(neither.isError && /ref or selector/i.test(neither.text), `click({}) -> ${trim(neither.text, 160)}`);
});

scenario("click-onDialog-accept-dismiss-prompt", async (c) => {
  const tabId = await c.open("core-form.html");
  const seen0 = h.seenDialogs.length;
  const acc = await c.call("click", { selector: "#btn-confirm", onDialog: "accept", tabId });
  c.expect((await c.evalJs(tabId, "window.__confirm")) === true, `confirm accept -> page saw ${await c.evalJs(tabId, "window.__confirm")}`);
  c.expect((acc.json?.dialogs ?? []).some((d: any) => d.type === "confirm" && d.message === "core confirm?"), `dialogs[] after accept: ${trim(acc.text, 200)}`);
  const dis = await c.call("click", { selector: "#btn-confirm", onDialog: "dismiss", tabId });
  c.expect((await c.evalJs(tabId, "window.__confirm")) === false, `confirm dismiss -> ${trim(dis.text, 160)}`);
  const pr = await c.call("click", { selector: "#btn-prompt", onDialog: "accept", promptText: "typed answer", tabId });
  c.expect((await c.evalJs(tabId, "window.__prompt")) === "typed answer", `prompt promptText -> ${trim(pr.text, 200)}`);
  c.expect((pr.json?.dialogs ?? []).some((d: any) => d.type === "prompt"), `prompt not reported in dialogs[]: ${trim(pr.text, 200)}`);
  await c.call("click", { selector: "#btn-prompt", onDialog: "dismiss", tabId });
  c.expect((await c.evalJs(tabId, "window.__prompt")) === null, "dismissed prompt did not return null");
  const al = await c.call("click", { selector: "#btn-alert", onDialog: "accept", tabId });
  c.expect((await c.evalJs(tabId, "window.__alertDone")) === true && (al.json?.dialogs ?? []).some((d: any) => d.type === "alert"), `alert -> ${trim(al.text, 200)}`);
  c.expect(h.seenDialogs.length === seen0, `a native dialog opened despite onDialog: ${JSON.stringify(h.seenDialogs.slice(seen0))}`);
});

scenario("fill", async (c) => {
  const tabId = await c.open("core-form.html");
  const r = await c.call("fill", { selector: "#name", value: "Ada Lovelace", tabId });
  c.expect(r.json?.filled !== false && !r.isError, `fill -> ${trim(r.text, 160)}`);
  c.expect((await c.evalJs(tabId, "document.getElementById('name').value")) === "Ada Lovelace", "input value not set");
  const { elements } = await c.snapshot(tabId);
  const second = findEl(elements, byName(/^Second$/));
  if (c.expect(second, "Second input not in snapshot")) {
    await c.call("fill", { ref: second.ref, value: "by ref", tabId });
    c.expect((await c.evalJs(tabId, "document.getElementById('second').value")) === "by ref", "fill(ref) did not set the value");
  }
  // replaces, not appends
  await c.call("fill", { selector: "#name", value: "Grace", tabId });
  c.expect((await c.evalJs(tabId, "document.getElementById('name').value")) === "Grace", "fill appended instead of replacing");
  const ce = await c.call("fill", { selector: "#editor", value: "rich text", tabId });
  c.expect((await c.evalJs(tabId, "document.getElementById('editor').textContent")) === "rich text", `contenteditable fill -> ${trim(ce.text, 160)}`);
  const miss = await c.call("fill", { selector: "#nope", value: "x", timeoutMs: 500, tabId });
  c.expect(miss.json?.notActionable === true || miss.isError, `fill on a missing element: ${trim(miss.text, 160)}`);
});

scenario("type-synthetic-and-trusted-autocomplete", async (c) => {
  const tabId = await c.open("core-form.html");
  const r = await c.call("type", { selector: "#ac", text: "Par", tabId });
  const ac = await c.evalJs(tabId, "({v: document.getElementById('ac').value, keys: window.__ac.keydowns, inputs: window.__ac.inputs, sugg: [...document.querySelectorAll('#sugg li')].map(l => l.textContent)})");
  c.note(`synthetic type -> ${trim(r.text, 100)}; page ${JSON.stringify(ac)}`);
  c.expect(ac?.v === "Par", `value after type: ${JSON.stringify(ac?.v)}`);
  c.expect(JSON.stringify(ac?.keys) === JSON.stringify(["P", "a", "r"]), `per-char keydowns: ${JSON.stringify(ac?.keys)}`);
  c.expect(ac?.inputs === 3, `input events: ${ac?.inputs} (want 3)`);
  c.expect(JSON.stringify(ac?.sugg) === JSON.stringify(["Paris", "Parma"]), `suggestions: ${JSON.stringify(ac?.sugg)}`);

  await c.call("navigate", { url: h.fixtureUrl("core-form.html"), tabId });
  const t = await c.call("type", { selector: "#ac", text: "Pr", trusted: true, tabId });
  const ac2 = await c.evalJs(tabId, "({v: document.getElementById('ac').value, keys: window.__ac.keydowns, trusted: window.__ac.trusted, sugg: [...document.querySelectorAll('#sugg li')].map(l => l.textContent)})");
  c.note(`trusted type -> ${trim(t.text, 100)}; page ${JSON.stringify(ac2)}`);
  c.expect(ac2?.v === "Pr" && JSON.stringify(ac2?.sugg) === JSON.stringify(["Prague"]), `trusted type: ${JSON.stringify(ac2)}`);
  c.expect(ac2?.trusted?.length === 2 && ac2.trusted.every((x: boolean) => x === true), `trusted keydowns not isTrusted: ${JSON.stringify(ac2?.trusted)}`);
  const miss = await c.call("type", { selector: "#nope", text: "x", timeoutMs: 500, tabId });
  c.expect(miss.json?.notActionable === true || miss.isError, `type on a missing element: ${trim(miss.text, 160)}`);
});

scenario("press_key-enter-escape-tab-combos", async (c) => {
  const tabId = await c.open("core-form.html");
  await c.call("click", { selector: "#name", tabId });
  await c.call("fill", { selector: "#name", value: "Zed", tabId });
  const enter = await c.call("press_key", { key: "Enter", tabId });
  c.expect(enter.json?.pressed !== undefined || !enter.isError, `press_key Enter -> ${trim(enter.text, 160)}`);
  const sub = await c.evalJs(tabId, "({n: window.__submitted, v: window.__submittedValue})");
  c.expect(sub?.n === 1 && sub?.v === "Zed", `Enter did not submit the form: ${JSON.stringify(sub)}`);

  await c.call("press_key", { key: "Escape", tabId });
  c.expect((await c.evalJs(tabId, "window.__escape")) === 1, "Escape keydown not seen by the page");

  await c.evalJs(tabId, "document.getElementById('name').focus(), true");
  await c.call("press_key", { key: "Tab", tabId });
  c.expect((await c.evalJs(tabId, "document.activeElement.id")) === "second", "Tab did not move focus to the next input");
  await c.call("press_key", { key: "Tab", tabId });
  c.expect((await c.evalJs(tabId, "document.activeElement.id")) === "third", "second Tab did not move focus again");
  await c.call("press_key", { key: "Shift+Tab", tabId });
  c.expect((await c.evalJs(tabId, "document.activeElement.id")) === "second", "Shift+Tab did not move focus back");

  await c.evalJs(tabId, "window.__keys = [], true");
  await c.call("press_key", { key: "Control+a", tabId });
  const keys = await c.evalJs(tabId, "window.__keys");
  c.expect((keys ?? []).some((k: any) => k.key.toLowerCase() === "a" && k.ctrl === true), `Control+a keydown: ${JSON.stringify(keys)}`);

  await c.evalJs(tabId, "document.getElementById('name').focus(), window.__keys = [], true");
  const te = await c.call("press_key", { key: "Enter", trusted: true, tabId });
  const sub2 = await c.evalJs(tabId, "({n: window.__submitted, trusted: window.__keys.filter(k => k.key === 'Enter').map(k => k.trusted)})");
  c.expect(sub2?.n === 2 && sub2?.trusted?.[0] === true, `trusted Enter: ${JSON.stringify(sub2)}; ${trim(te.text, 120)}`);
});

scenario("hover-synthetic-and-trusted-css-hover", async (c) => {
  const tabId = await c.open("core-hover.html");
  const subDisplay = () => c.evalJs(tabId, "getComputedStyle(document.getElementById('sub')).display");
  c.expect((await subDisplay()) === "none", "submenu visible before any hover");
  const syn = await c.call("hover", { selector: "#js-hover", tabId });
  const hv = await c.evalJs(tabId, "window.__hover");
  c.expect(!syn.isError && hv?.enter >= 1 && hv?.over >= 1, `synthetic hover events: ${JSON.stringify(hv)}; ${trim(syn.text, 120)}`);

  const tr = await c.call("hover", { selector: "#menu", trusted: true, tabId });
  c.expect(!tr.isError, `trusted hover -> ${trim(tr.text, 160)}`);
  c.expect((await subDisplay()) === "block", "trusted hover did not trigger the CSS :hover submenu");
  c.expect((await c.evalJs(tabId, "document.getElementById('menu').matches(':hover')")) === true, "#menu does not match :hover after trusted hover");

  await c.evalJs(tabId, "window.__hover.trusted = [], true");
  await c.call("hover", { selector: "#js-hover", trusted: true, tabId });
  const hv2 = await c.evalJs(tabId, "window.__hover.trusted");
  c.expect(hv2?.includes(true), `trusted hover produced no isTrusted mouseenter: ${JSON.stringify(hv2)}`);
  c.expect((await subDisplay()) === "none", "submenu still open after the real cursor moved away");
  const miss = await c.call("hover", { selector: "#nope", timeoutMs: 500, tabId });
  c.expect(miss.json?.notActionable === true || miss.isError, `hover on a missing element: ${trim(miss.text, 160)}`);
});

scenario("scroll-window-container-direction", async (c) => {
  const tabId = await c.open("core-scroll.html");
  await settleViewport(c, tabId);
  const y = () => c.evalJs(tabId, "window.scrollY");
  const s1 = await c.call("scroll", { tabId, dy: 500 });
  c.expect(s1.json?.container === "window" && (await y()) === 500 && s1.json?.scrollTop === 500, `scroll dy:500 -> ${trim(s1.text, 160)}`);
  c.expect(s1.json?.atStart === false && s1.json?.atEnd === false, `mid-page flags: ${trim(s1.text, 160)}`);
  const bottom = await c.call("scroll", { tabId, direction: "bottom" });
  const at = await c.evalJs(tabId, "({y: scrollY, max: document.documentElement.scrollHeight - innerHeight})");
  c.expect(bottom.json?.atEnd === true && near(at?.y, at?.max, 1), `direction:bottom -> ${trim(bottom.text, 160)} (page ${JSON.stringify(at)})`);
  const top = await c.call("scroll", { tabId, direction: "top" });
  c.expect(top.json?.atStart === true && (await y()) === 0, `direction:top -> ${trim(top.text, 160)}`);
  const down = await c.call("scroll", { tabId, direction: "down", amount: 300 });
  c.expect((await y()) === 300 && !down.isError, `direction:down amount:300 -> scrollY ${await y()}`);
  await c.call("scroll", { tabId, direction: "up", amount: 100 });
  c.expect((await y()) === 200, `direction:up amount:100 -> scrollY ${await y()}`);

  // container by ref: an element inside #pane + a direction scrolls #pane, not the window
  await c.call("scroll", { tabId, direction: "top" });
  const { elements } = await c.snapshot(tabId);
  const rowBtn = findEl(elements, byName(/Row 0 button/));
  if (c.expect(rowBtn, "pane button not in snapshot")) {
    const pc = await c.call("scroll", { ref: rowBtn.ref, dy: 120, tabId });
    const pane = await c.evalJs(tabId, "document.getElementById('pane').scrollTop");
    c.expect(pane === 120 && (await y()) === 0, `container scroll -> ${trim(pc.text, 160)}; pane.scrollTop=${pane}, window=${await y()}`);
    c.expect(/pane/.test(String(pc.json?.container)), `container not named: ${trim(pc.text, 160)}`);
    const pend = await c.call("scroll", { ref: rowBtn.ref, direction: "bottom", tabId });
    const paneMax = await c.evalJs(tabId, "(p => p.scrollHeight - p.clientHeight)(document.getElementById('pane'))");
    c.expect(pend.json?.atEnd === true && near(await c.evalJs(tabId, "document.getElementById('pane').scrollTop"), paneMax, 1), `pane bottom -> ${trim(pend.text, 160)}`);
  }
  // selector only: scroll into view
  const intoView = await c.call("scroll", { selector: "#far", tabId });
  const farVisible = await c.evalJs(tabId, "(r => r.top >= 0 && r.bottom <= innerHeight)(document.getElementById('far').getBoundingClientRect())");
  c.expect(farVisible === true, `#far not in view after scroll(selector): ${trim(intoView.text, 160)}`);
  const miss = await c.call("scroll", { selector: "#nope", tabId });
  c.expect(miss.isError && /not found/i.test(miss.text), `scroll(missing selector): ${trim(miss.text, 160)}`);
});

scenario("wait_for-selector-text-role-hidden-detached", async (c) => {
  const tabId = await c.open("core-wait.html");
  await c.evalJs(tabId, "showLater(500), true");
  const sel = await c.call("wait_for", { selector: "#late-btn", tabId, timeoutMs: 8_000 });
  c.expect(sel.json?.found === true && sel.json?.elapsedMs >= 200 && sel.json?.state === "visible", `selector -> ${trim(sel.text, 160)}`);
  c.expect((await c.evalJs(tabId, "!!document.getElementById('late-btn')")) === true, "element absent after wait_for resolved");
  const txt = await c.call("wait_for", { text: "order #4242", tabId, timeoutMs: 3_000 });
  c.expect(txt.json?.found === true, `text (case-insensitive) -> ${trim(txt.text, 160)}`);
  const role = await c.call("wait_for", { role: "button", name: "checkout", tabId, timeoutMs: 3_000 });
  c.expect(role.json?.found === true && role.json?.tag?.toLowerCase?.() === "button", `role+name -> ${trim(role.text, 160)}`);

  await c.evalJs(tabId, "hideLater(400), true");
  const hid = await c.call("wait_for", { selector: "#spinner", state: "hidden", tabId, timeoutMs: 8_000 });
  c.expect(hid.json?.found === true && hid.json?.elapsedMs >= 200, `hidden -> ${trim(hid.text, 160)}`);
  c.expect((await c.evalJs(tabId, "getComputedStyle(document.getElementById('spinner')).display")) === "none", "spinner still displayed");

  await c.evalJs(tabId, "removeLater(400), true");
  const det = await c.call("wait_for", { selector: "#doomed", state: "detached", tabId, timeoutMs: 8_000 });
  c.expect(det.json?.found === true && det.json?.elapsedMs >= 200, `detached -> ${trim(det.text, 160)}`);
  c.expect((await c.evalJs(tabId, "document.getElementById('doomed')")) == null, "node still attached");
  const att = await c.call("wait_for", { selector: "#spinner", state: "attached", tabId, timeoutMs: 2_000 });
  c.expect(att.json?.found === true, `hidden-but-attached spinner not 'attached': ${trim(att.text, 160)}`);

  const to = await c.call("wait_for", { selector: "#never", tabId, timeoutMs: 800 });
  c.expect(to.isError && /Timed out after 800ms/.test(to.text) && to.ms < 5_000, `timeout path -> ${trim(to.text, 160)} (${to.ms}ms)`);
  const slp = await c.call("wait_for", { tabId, timeoutMs: 300 });
  c.expect(slp.json?.slept === 300 && slp.ms >= 290, `no-target sleep -> ${trim(slp.text, 100)} in ${slp.ms}ms`);
});

scenario("input-coordinate-actions", async (c) => {
  const tabId = await c.open("core-input.html");
  const ev = async () => (await c.evalJs(tabId, "(() => { const e = window.__ev; window.__ev = []; return e; })()")) as any[];
  await ev();
  const lc = await c.call("input", { action: "left_click", x: 100, y: 120, tabId });
  let e = await ev();
  c.expect(!lc.isError && ["mousedown", "mouseup", "click"].every((t) => e.some((x) => x.t === t && x.x === 100 && x.y === 120 && x.trusted)), `left_click -> ${trim(lc.text, 120)}; events ${JSON.stringify(e)}`);
  await c.call("input", { action: "double_click", x: 150, y: 150, tabId });
  e = await ev();
  c.expect(e.some((x) => x.t === "dblclick" && x.x === 150), `double_click events ${JSON.stringify(e)}`);
  await c.call("input", { action: "right_click", x: 160, y: 160, tabId });
  e = await ev();
  c.expect(e.some((x) => x.t === "contextmenu" && x.b === 2), `right_click events ${JSON.stringify(e)}`);
  await c.call("input", { action: "mouse_move", x: 200, y: 210, tabId });
  e = await ev();
  c.expect(e.some((x) => x.t === "mousemove" && x.x === 200 && x.y === 210), `mouse_move events ${JSON.stringify(e)}`);
  await c.call("input", { action: "left_click_drag", x: 100, y: 100, x2: 300, y2: 250, tabId });
  e = await ev();
  const down = e.find((x) => x.t === "mousedown");
  const up = e.find((x) => x.t === "mouseup");
  c.expect(down?.x === 100 && down?.y === 100 && up?.x === 300 && up?.y === 250, `drag events ${JSON.stringify(e)}`);
  await c.call("input", { action: "scroll", x: 200, y: 200, dy: 120, tabId });
  e = await ev();
  c.expect(e.some((x) => x.t === "wheel" && x.dy === 120), `scroll (wheel) events ${JSON.stringify(e)}`);
  await c.call("input", { action: "left_click", x: 100, y: 410, tabId }); // focus #txt
  const ty = await c.call("input", { action: "type", text: "abc", tabId });
  c.expect((await c.evalJs(tabId, "document.getElementById('txt').value")) === "abc", `input type -> ${trim(ty.text, 120)}`);
  await c.call("input", { action: "key", key: "Enter", tabId });
  const keys = await c.evalJs(tabId, "window.__keys");
  c.expect((keys ?? []).some((k: any) => k.key === "Enter" && k.trusted), `key Enter: ${JSON.stringify(keys)}`);
  const bad = await c.call("input", { action: "left_click", tabId });
  c.expect(bad.isError && /requires x and y/.test(bad.text), `left_click without x/y -> ${trim(bad.text, 160)}`);
  const badType = await c.call("input", { action: "type", tabId });
  c.expect(badType.isError && /requires text/.test(badType.text), `type without text -> ${trim(badType.text, 160)}`);
});

// ===================================================================================================
// Capture
// ===================================================================================================

scenario("screenshot-variants", async (c) => {
  const tabId = await c.open("core-scroll.html");
  // Banner-free captures first, on a settled viewport with no debugger session anywhere.
  await settleViewport(c, tabId);
  const vp = await c.evalJs(tabId, "({iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, sh: document.documentElement.scrollHeight})");
  const def = await c.call("screenshot", { tabId });
  const img = imageOf(def);
  const d0 = img ? pngDims(Buffer.from(img.data, "base64")) : null;
  c.note(`viewport ${JSON.stringify(vp)}; default ${JSON.stringify(d0)}`);
  c.expect(img?.mimeType === "image/png" && d0, `default screenshot has no PNG: ${trim(def.text, 160)}`);
  c.expect(d0 && near(d0.width, vp.iw * vp.dpr) && near(d0.height, vp.ih * vp.dpr), `default dims ${JSON.stringify(d0)} vs viewport ${vp.iw}x${vp.ih}@${vp.dpr}`);
  c.expect(/dpr \d/.test(def.text) && def.text.includes(`css ${vp.iw}×${vp.ih}`), `default metadata: ${trim(def.text, 160)}`);

  const jHi = await c.call("screenshot", { tabId, format: "jpeg", quality: 95 });
  const jLo = await c.call("screenshot", { tabId, format: "jpeg", quality: 10 });
  const bHi = imageOf(jHi) ? Buffer.from(imageOf(jHi).data, "base64") : Buffer.alloc(0);
  const bLo = imageOf(jLo) ? Buffer.from(imageOf(jLo).data, "base64") : Buffer.alloc(0);
  const dj = jpegDims(bLo);
  c.expect(imageOf(jLo)?.mimeType === "image/jpeg" && dj && near(dj.width, vp.iw * vp.dpr) && near(dj.height, vp.ih * vp.dpr), `jpeg: mime ${imageOf(jLo)?.mimeType} dims ${JSON.stringify(dj)}`);
  c.expect(bLo.length > 0 && bLo.length < bHi.length, `jpeg quality 10 (${bLo.length}B) not smaller than quality 95 (${bHi.length}B)`);
  const dbg = await c.call("debugger_status", { tabId });
  c.expect(dbg.json?.attached === false, `a plain png/jpeg screenshot attached the debugger: ${trim(dbg.text, 120)}`);

  // CDP captures (debugger attached from here on).
  const full = await c.call("screenshot", { tabId, fullPage: true }, { timeoutMs: 30_000 });
  const d1 = imageOf(full) ? pngDims(Buffer.from(imageOf(full).data, "base64")) : null;
  c.expect(d1 && near(d1.height, vp.sh) && near(d1.width, vp.iw), `fullPage dims ${JSON.stringify(d1)} vs page ${vp.iw}x${vp.sh}`);

  // The "is being debugged" infobar shrinks the viewport once attached, so re-measure once it settles.
  const vp2 = await settleViewport(c, tabId, false);
  const sc = await c.call("screenshot", { tabId, scale: 2 }, { timeoutMs: 30_000 });
  const d2 = imageOf(sc) ? pngDims(Buffer.from(imageOf(sc).data, "base64")) : null;
  c.expect(d2 && near(d2.width, vp2.iw * 2) && near(d2.height, vp2.ih * 2), `scale:2 dims ${JSON.stringify(d2)} vs viewport ${JSON.stringify(vp2)}`);

  const clip = await c.call("screenshot", { tabId, selector: "#pane" }, { timeoutMs: 30_000 });
  const d3 = imageOf(clip) ? pngDims(Buffer.from(imageOf(clip).data, "base64")) : null;
  const box = await c.evalJs(tabId, "(r => ({w: r.width, h: r.height}))(document.getElementById('pane').getBoundingClientRect())");
  c.expect(d3 && near(d3.width, box.w) && near(d3.height, box.h), `selector clip dims ${JSON.stringify(d3)} vs box ${JSON.stringify(box)}`);
  const clip2 = await c.call("screenshot", { tabId, selector: "#pane", scale: 2 }, { timeoutMs: 30_000 });
  const d4 = imageOf(clip2) ? pngDims(Buffer.from(imageOf(clip2).data, "base64")) : null;
  c.expect(d4 && near(d4.width, box.w * 2) && near(d4.height, box.h * 2), `selector+scale:2 dims ${JSON.stringify(d4)}`);

  const savePath = join(outDir, "shot.png");
  const sv = await c.call("screenshot", { tabId, selector: "#pane", savePath }, { timeoutMs: 30_000 });
  c.expect(!imageOf(sv) && sv.json?.path === savePath, `savePath returned ${trim(sv.text, 160)}`);
  if (c.expect(existsSync(savePath), "savePath file not written")) {
    const buf = readFileSync(savePath);
    const dd = pngDims(buf);
    c.expect(buf.length === sv.json?.bytes && dd?.width === sv.json?.width && dd?.height === sv.json?.height, `file ${buf.length}B ${JSON.stringify(dd)} vs metadata ${trim(sv.text, 160)}`);
  }
  const bad = await c.call("screenshot", { tabId, selector: "#nope" }, { timeoutMs: 30_000 });
  c.expect(bad.isError && /not found|no rendered box/i.test(bad.text), `selector miss -> ${trim(bad.text, 160)}`);
});

scenario("save_page", async (c) => {
  const tabId = await c.open("core-nav-a.html");
  const savePath = join(outDir, "page.mhtml");
  const r = await c.call("save_page", { tabId, savePath }, { timeoutMs: 60_000 });
  c.expect(r.json?.saved === savePath && r.json?.bytes > 0 && r.json?.title === "Core Nav A", `save_page -> ${trim(r.text, 200)}`);
  if (c.expect(existsSync(savePath), "mhtml not written")) {
    const body = readFileSync(savePath, "utf8");
    c.expect(statSync(savePath).size === r.json?.bytes, `file size ${statSync(savePath).size} != reported ${r.json?.bytes}`);
    c.expect(/MIME-Version/i.test(body) && /marker-A/.test(body), "mhtml lacks the MIME header or page content");
  }
  const noPath = await c.call("save_page", { tabId });
  c.expect(noPath.isError, `save_page without savePath -> ${trim(noPath.text, 120)}`);
});

scenario("download_resource", async (c) => {
  await c.open("core-nav-a.html");
  const expected = readFileSync(join(E2E_DIR, "fixtures", "core-download.txt"));
  const url = h.fixtureUrl("core-download.txt");
  const savePath = join(outDir, "dl.txt");
  const r = await c.call("download_resource", { url, savePath, timeoutMs: 20_000 }, { timeoutMs: 30_000 });
  c.expect(r.json?.path === savePath && r.json?.bytes === expected.length, `download -> ${trim(r.text, 200)}`);
  c.expect(existsSync(savePath) && readFileSync(savePath).equals(expected), "downloaded bytes differ from the fixture");
  const capPath = join(outDir, "dl-capped.txt");
  const cap = await c.call("download_resource", { url: url + "?cap", savePath: capPath, maxBytes: 100, timeoutMs: 20_000 }, { timeoutMs: 30_000 });
  c.note(`maxBytes:100 -> ${trim(cap.text, 160)}`);
  c.expect(cap.isError && /maxBytes/i.test(cap.text), `a 5000-byte download with maxBytes:100 was not refused: ${trim(cap.text, 200)}`);
  c.expect(!existsSync(capPath), "capped download still delivered to savePath");
  const notFound = await c.call("download_resource", { url: h.fixtureUrl("core-missing.bin"), savePath: join(outDir, "nf.bin"), timeoutMs: 15_000 }, { timeoutMs: 30_000 });
  c.expect(notFound.isError, `a 404 download reported success: ${trim(notFound.text, 200)}`);
});

// ===================================================================================================
// Eval / CDP / dialogs / debugger
// ===================================================================================================

scenario("eval_js-sync-promise-errors-csp", async (c) => {
  const tabId = await c.open("core-nav-a.html");
  const s = await c.call("eval_js", { code: "1 + 2", tabId });
  c.expect(s.json?.value === "3", `sync -> ${trim(s.text, 100)}`);
  const o = await c.call("eval_js", { code: "({a: document.title, n: [1,2]})", tabId });
  c.expect(o.json?.value === JSON.stringify({ a: "Core Nav A", n: [1, 2] }), `object -> ${trim(o.text, 100)}`);
  const p = await c.call("eval_js", { code: "new Promise(r => setTimeout(() => r('late'), 300))", tabId });
  c.expect(p.json?.value === "late" && p.ms >= 250, `promise -> ${trim(p.text, 100)} in ${p.ms}ms`);
  const np = await c.call("eval_js", { code: "new Promise(r => setTimeout(() => r('x'), 300))", awaitPromise: false, tabId });
  c.expect(np.json?.value !== "x", `awaitPromise:false still awaited: ${trim(np.text, 100)}`);
  const rej = await c.call("eval_js", { code: "Promise.reject(new Error('nope-rejected'))", tabId });
  c.expect((rej.isError || rej.json?.error) && /nope-rejected/.test(rej.text), `rejected promise -> ${trim(rej.text, 160)}`);
  const thr = await c.call("eval_js", { code: "throw new Error('boom-core')", tabId });
  c.expect((thr.isError || thr.json?.error) && /boom-core/.test(thr.text), `throw -> ${trim(thr.text, 160)}`);
  const stmt = await c.call("eval_js", { code: "window.__x = 5; window.__x * 2", tabId });
  c.expect(stmt.json?.value === "10", `statements -> ${trim(stmt.text, 100)}`);

  const csp = await c.open("core-csp.html");
  const fb = await c.call("eval_js", { code: "window.__secret + 1", tabId: csp });
  c.note(`CSP page eval_js -> ${trim(fb.text, 160)}`);
  c.expect(fb.json?.value === "42" && fb.json?.via === "cdp-fallback", `CSP fallback -> ${trim(fb.text, 200)}`);
  const nf = await c.call("eval_js", { code: "1", noFallback: true, tabId: csp });
  c.expect(nf.isError && /unsafe-eval|content security policy|evalerror/i.test(nf.text), `noFallback on CSP page -> ${trim(nf.text, 200)}`);
  const forced = await c.call("eval_js", { code: "document.getElementById('marker').textContent", cdp: true, tabId });
  c.expect(forced.json?.via === "cdp" && forced.json?.value === "marker-A", `cdp:true -> ${trim(forced.text, 160)}`);
  await c.call("debugger_detach", { tabId });
  await c.call("debugger_detach", { tabId: csp });
});

scenario("cdp_eval", async (c) => {
  const tabId = await c.open("core-csp.html");
  const r = await c.call("cdp_eval", { code: "window.__secret * 2", tabId });
  c.expect(r.json?.value === "82" && r.json?.via === "cdp", `cdp_eval on a CSP page -> ${trim(r.text, 160)}`);
  const p = await c.call("cdp_eval", { code: "new Promise(r => setTimeout(() => r({ok: true}), 200))", tabId });
  c.expect(/"ok":\s*true/.test(String(p.json?.value)), `promise -> ${trim(p.text, 160)}`);
  const w = await c.call("cdp_eval", { code: "document.body.dataset.cdp = 'set'; 1", tabId });
  c.expect(!w.isError && (await c.call("cdp_eval", { code: "document.body.dataset.cdp", tabId })).json?.value === "set", "cdp_eval write not visible to a later read");
  const e = await c.call("cdp_eval", { code: "throw new Error('cdp-boom')", tabId });
  c.expect(e.isError && /cdp-boom/.test(e.text), `exception -> ${trim(e.text, 160)}`);
  const st = await c.call("debugger_status", { tabId });
  c.expect(st.json?.attached === true, `cdp_eval left no debugger session: ${trim(st.text, 160)}`);
  await c.call("debugger_detach", { tabId });
});

scenario(
  "handle_dialog-with-attached-debugger-and-debugger-tools",
  async (c) => {
    const tabId = await c.open("core-form.html");
    // No dialog: clear handled:false message, no hang.
    const none = await c.call("handle_dialog", { tabId }, { timeoutMs: 15_000 });
    c.expect(none.json?.handled === false && /no dialog/i.test(none.json?.message ?? ""), `handle_dialog with nothing open -> ${trim(none.text, 200)}`);
    c.expect(none.ms < 10_000, `handle_dialog with nothing open took ${none.ms}ms`);

    // Attach the debugger first (cdp_eval), THEN open an alert: it must be answerable.
    const att = await c.call("cdp_eval", { code: "1 + 1", tabId });
    c.expect(att.json?.value === "2", `cdp_eval attach -> ${trim(att.text, 120)}`);
    const st = await c.call("debugger_status", { tabId });
    c.expect(st.json?.attached === true && st.json?.tabId === tabId && typeof st.json?.idleMs === "number", `debugger_status(tabId) -> ${trim(st.text, 160)}`);
    const all = await c.call("debugger_status", {});
    c.expect((all.json?.sessions ?? []).some((s: any) => s.tabId === tabId), `debugger_status() sessions lack our tab: ${trim(all.text, 200)}`);

    await c.call("eval_js", { code: "setTimeout(() => { alert('core alert'); window.__alertDone = true; }, 50); 'scheduled'", tabId });
    await sleep(500);
    const listed = (await tabsList(c)).find((t) => t.id === tabId);
    c.note(`tabs_list row while alert open (no dialog field = dialog not tracked): ${JSON.stringify(listed)}`);
    const ans = await c.call("handle_dialog", { tabId, accept: true }, { timeoutMs: 15_000, allowTimeout: true });
    c.note(`handle_dialog(alert) -> ${trim(ans.text, 200)}`);
    c.expect(ans.json?.handled === true, `alert opened under an attached debugger was not answered: ${trim(ans.text, 200)}`);
    c.expect(ans.json?.type === "alert" && ans.json?.message === "core alert", `handled dialog not described: ${trim(ans.text, 200)}`);
    const done = await c.call("eval_js", { code: "window.__alertDone === true", tabId }, { timeoutMs: 10_000, allowTimeout: true });
    c.expect(done.json?.value === "true", `page did not resume after handle_dialog: ${trim(done.text, 160)}`);

    // prompt answered with promptText
    await c.call("eval_js", { code: "setTimeout(() => { window.__p = prompt('name?'); }, 50); 1", tabId });
    await sleep(500);
    const pa = await c.call("handle_dialog", { tabId, accept: true, promptText: "via handle_dialog" }, { timeoutMs: 15_000, allowTimeout: true });
    c.expect(pa.json?.handled === true && pa.json?.type === "prompt", `prompt -> ${trim(pa.text, 200)}`);
    const pv = await c.call("eval_js", { code: "window.__p", tabId }, { timeoutMs: 10_000, allowTimeout: true });
    c.expect(pv.json?.value === "via handle_dialog", `prompt answer seen by page: ${trim(pv.text, 120)}`);
    // confirm dismissed
    await c.call("eval_js", { code: "setTimeout(() => { window.__c = confirm('sure?'); }, 50); 1", tabId });
    await sleep(500);
    const cd = await c.call("handle_dialog", { tabId, accept: false }, { timeoutMs: 15_000, allowTimeout: true });
    c.expect(cd.json?.handled === true && cd.json?.accepted === false, `confirm dismiss -> ${trim(cd.text, 200)}`);
    const cv = await c.call("eval_js", { code: "String(window.__c)", tabId }, { timeoutMs: 10_000, allowTimeout: true });
    c.expect(cv.json?.value === "false", `confirm answer seen by page: ${trim(cv.text, 120)}`);

    const again = await c.call("handle_dialog", { tabId }, { timeoutMs: 15_000 });
    c.expect(again.json?.handled === false, `second handle_dialog with nothing open -> ${trim(again.text, 160)}`);

    // debugger_detach
    const det = await c.call("debugger_detach", { tabId });
    c.expect(det.json?.detached === true && det.json?.tabId === tabId, `debugger_detach -> ${trim(det.text, 160)}`);
    const st2 = await c.call("debugger_status", { tabId });
    c.expect(st2.json?.attached === false, `still attached after detach: ${trim(st2.text, 160)}`);
    const all2 = await c.call("debugger_status", {});
    c.expect(!(all2.json?.sessions ?? []).some((s: any) => s.tabId === tabId), `session still listed after detach: ${trim(all2.text, 200)}`);
  },
  { timeout: 120_000 }
);

// ===================================================================================================
// Files / clipboard
// ===================================================================================================

scenario("file_upload-base64-and-path", async (c) => {
  const tabId = await c.open("core-form.html");
  const content = "hello core upload";
  const r = await c.call("file_upload", { selector: "#file", base64: Buffer.from(content).toString("base64"), filename: "core.txt", mimeType: "text/plain", tabId });
  c.expect(!r.isError, `base64 upload -> ${trim(r.text, 160)}`);
  await c.call("wait_for", { tabId, timeoutMs: 200 });
  const f = await c.evalJs(tabId, "({file: window.__file, text: window.__fileText})");
  c.expect(f?.file?.name === "core.txt" && f?.file?.size === content.length && f?.file?.type === "text/plain", `page saw ${JSON.stringify(f)}`);
  c.expect(f?.text === content, `page read contents ${JSON.stringify(f?.text)}`);

  const p = join(outDir, "core-path-upload.bin");
  const bytes = Buffer.from(Array.from({ length: 1234 }, (_, i) => i % 251));
  writeFileSync(p, bytes);
  await c.evalJs(tabId, "window.__file = null, true");
  const r2 = await c.call("file_upload", { selector: "#file", path: p, tabId });
  c.expect(!r2.isError && r2.json?.uploaded === p, `path upload -> ${trim(r2.text, 160)}`);
  await c.call("wait_for", { tabId, timeoutMs: 200 });
  const f2 = await c.evalJs(tabId, "window.__file");
  c.expect(f2?.name === "core-path-upload.bin" && f2?.size === 1234, `page saw ${JSON.stringify(f2)}`);

  const notFile = await c.call("file_upload", { selector: "#name", base64: "AAAA", filename: "x", tabId });
  c.expect(notFile.isError || /not an <input type=file>/i.test(notFile.text), `upload into a text input -> ${trim(notFile.text, 160)}`);
  const noData = await c.call("file_upload", { selector: "#file", tabId });
  c.expect(noData.isError && /base64|path/i.test(noData.text), `no base64/path -> ${trim(noData.text, 160)}`);
});

scenario("paste_image-base64-and-path", async (c) => {
  const tabId = await c.open("core-form.html");
  const png = makePng(3, 2);
  const r = await c.call("paste_image", { selector: "#editor", base64: png.toString("base64"), mimeType: "image/png", tabId });
  c.expect(!r.isError, `paste_image -> ${trim(r.text, 160)}`);
  await c.call("wait_for", { selector: "#pasted-img", state: "attached", tabId, timeoutMs: 3_000 });
  await sleep(200);
  const st = await c.evalJs(tabId, "({paste: window.__paste, img: window.__imgSize})");
  c.expect(st?.paste?.files?.[0]?.type === "image/png" && st?.paste?.files?.[0]?.size === png.length, `paste event files: ${JSON.stringify(st?.paste)}`);
  c.expect(st?.img?.w === 3 && st?.img?.h === 2, `pasted image did not decode to 3x2: ${JSON.stringify(st?.img)}`);

  const p = join(outDir, "core-paste.png");
  const png2 = makePng(5, 4);
  writeFileSync(p, png2);
  await c.evalJs(tabId, "document.querySelectorAll('#pasted-img').forEach(i => i.remove()); window.__imgSize = null; window.__paste = null; true");
  const r2 = await c.call("paste_image", { selector: "#editor", path: p, tabId });
  c.expect(!r2.isError, `paste_image(path) -> ${trim(r2.text, 160)}`);
  await c.call("wait_for", { selector: "#pasted-img", state: "attached", tabId, timeoutMs: 3_000 });
  await sleep(200);
  const st2 = await c.evalJs(tabId, "({paste: window.__paste, img: window.__imgSize})");
  c.expect(st2?.paste?.files?.[0]?.type === "image/png" && st2?.img?.w === 5 && st2?.img?.h === 4, `path paste: ${JSON.stringify(st2)}`);
  const none = await c.call("paste_image", { selector: "#editor", tabId });
  c.expect(none.isError && /base64|path/i.test(none.text), `no image -> ${trim(none.text, 160)}`);
});

scenario("paste_html-rich-text", async (c) => {
  const tabId = await c.open("core-form.html");
  await c.evalJs(tabId, "(e => { e.innerHTML = ''; e.focus(); })(document.getElementById('editor')), true");
  const r = await c.call("paste_html", { html: "<b id=\"pb\">Bold core</b> and <i>italic</i>", text: "Bold core and italic", tabId }, { timeoutMs: 50_000 });
  c.expect(r.json?.pasted === true, `paste_html -> ${trim(r.text, 160)}`);
  await sleep(300);
  const st = await c.evalJs(tabId, "({paste: window.__paste, html: document.getElementById('editor').innerHTML, text: document.getElementById('editor').textContent})");
  c.note(`paste_html page state: ${trim(JSON.stringify(st), 300)}`);
  c.expect(st?.paste?.trusted === true && st?.paste?.types?.includes("text/html"), `paste event: ${JSON.stringify(st?.paste)}`);
  c.expect(/Bold core/.test(st?.paste?.html ?? "") && st?.paste?.text === "Bold core and italic", `clipboard payload: ${JSON.stringify(st?.paste)}`);
  c.expect(/<b[^>]*>Bold core<\/b>/.test(st?.html ?? "") && /<i>italic<\/i>/.test(st?.html ?? ""), `editor did not receive rich content: ${trim(st?.html, 200)}`);
});

// ===================================================================================================
// Batch / status
// ===================================================================================================

scenario("browser_batch-success-stop-continue", async (c) => {
  const tabId = await c.open("core-form.html");
  const ok = await c.call("browser_batch", {
    actions: [
      { name: "fill", input: { selector: "#name", value: "batched", tabId } },
      { name: "click", input: { selector: "#btn-plain", tabId } },
      { name: "get_page_text", input: { tabId } },
    ],
  });
  c.expect(ok.json?.executed === 3 && ok.json?.total === 3 && ok.json?.stoppedAt === undefined, `success batch -> ${trim(ok.text, 200)}`);
  c.expect(/clicked 1/.test(String(ok.json?.results?.[2]?.result)), `batched get_page_text did not see the batched click: ${trim(ok.json?.results?.[2]?.result, 120)}`);
  c.expect((await c.evalJs(tabId, "document.getElementById('name').value")) === "batched", "batched fill not applied");

  const stop = await c.call("browser_batch", {
    actions: [
      { name: "click", input: { selector: "#btn-plain", tabId } },
      { name: "wait_for", input: { selector: "#never", timeoutMs: 300, tabId } },
      { name: "fill", input: { selector: "#second", value: "SHOULD-NOT-RUN", tabId } },
    ],
  });
  c.expect(stop.json?.stoppedAt === 1 && stop.json?.failedTool === "wait_for" && stop.json?.executed === 1, `stop-on-error batch -> ${trim(stop.text, 240)}`);
  c.expect((await c.evalJs(tabId, "document.getElementById('second').value")) === "", "step after the failing one still ran");
  c.expect((await c.evalJs(tabId, "window.__plainClicks")) === 2, "step before the failing one did not run");

  const na = await c.call("browser_batch", {
    actions: [
      { name: "click", input: { selector: "#nope", timeoutMs: 300, tabId } },
      { name: "fill", input: { selector: "#second", value: "SHOULD-NOT-RUN", tabId } },
    ],
  });
  c.expect(na.json?.stoppedAt === 0 && na.json?.outcome === "notActionable", `notActionable halt -> ${trim(na.text, 200)}`);

  const cont = await c.call("browser_batch", {
    actions: [
      { name: "wait_for", input: { selector: "#never", timeoutMs: 300, tabId }, continueOnError: true },
      { name: "click", input: { selector: "#nope", timeoutMs: 300, tabId }, continueOnError: true },
      { name: "fill", input: { selector: "#second", value: "after errors", tabId } },
    ],
  });
  c.expect(cont.json?.executed === 3 && cont.json?.stoppedAt === undefined, `continueOnError batch -> ${trim(cont.text, 240)}`);
  c.expect(cont.json?.results?.[0]?.outcome === "error" && cont.json?.results?.[1]?.outcome === "notActionable", `failures not recorded: ${trim(JSON.stringify(cont.json?.results), 240)}`);
  c.expect((await c.evalJs(tabId, "document.getElementById('second').value")) === "after errors", "step after tolerated failures did not run");

  const nab = await c.call("browser_batch", { actions: [{ name: "cdp_eval", input: { code: "1", tabId } }] });
  c.expect(nab.json?.stoppedAt === 0 && /not batchable/.test(nab.json?.error ?? ""), `non-batchable tool -> ${trim(nab.text, 200)}`);
  const bad = await c.call("browser_batch", { actions: [{ name: "fill", input: { selector: "#name", tabId } }] });
  c.expect(bad.json?.stoppedAt === 0 && /Invalid input/.test(bad.json?.error ?? ""), `invalid input -> ${trim(bad.text, 200)}`);
});

scenario("bridge_status", async (c) => {
  const r = await c.call("bridge_status", {});
  c.expect(r.json?.extensionConnected === true, `bridge_status -> ${trim(r.text, 200)}`);
  c.expect(typeof r.json?.serverVersion === "string" && /\d+\.\d+\.\d+/.test(r.json.serverVersion), `serverVersion: ${r.json?.serverVersion}`);
  c.expect(r.json?.extension && typeof r.json.extension.version === "string", `extension hello: ${JSON.stringify(r.json?.extension)}`);
  c.expect(!r.json?.warning, `version skew warning in a same-checkout build: ${r.json?.warning}`);
  const health = await h.health();
  c.expect(health.extensionConnected === true, "/health disagrees with bridge_status");
});
