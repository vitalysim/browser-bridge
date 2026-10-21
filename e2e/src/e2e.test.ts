// browser-bridge end-to-end scenarios. Each asserts the CORRECT / desired behaviour; several are
// expected to fail against older builds - that is the point of the suite. See ../BASELINE.md.
import { before, after } from "node:test";
import { Harness, trim } from "./harness.js";
import { scenario as defineScenario, printSummary, findEl, byLabel, type Ctx } from "./scenario.js";

let h: Harness;
const scenario = (name: string, fn: (c: Ctx) => Promise<void>, opts?: { timeout?: number }) => defineScenario(() => h, name, fn, opts);

before(async () => {
  h = new Harness();
  try {
    await h.setup();
  } catch (e) {
    await h.teardown();
    throw e;
  }
  console.log(
    `[e2e] bridge :${h.bridgePort}  fixtures :${h.fixturePort}  chromium ${h.headless ? "headless" : "headed"}  tools=${h.toolSchemas.size}`
  );
}, { timeout: 90_000 });

after(async () => {
  printSummary();
  await h?.teardown();
}, { timeout: 60_000 });

const covered = (r: any) => r?.json?.wasCovered === true || r?.json?.reason === "covered";

// 1. Radix-style trigger that opens on pointerdown (and one that opens on mousedown) ------------------
for (const [name, label, key] of [
  ["pointerdown-menu", /Options \(pointerdown\)/, "pdOpen"],
  ["mousedown-menu", /Actions \(mousedown\)/, "mdOpen"],
] as const) {
  scenario(name, async (c) => {
    const tabId = await c.open("pointerdown-menu.html");
    const { elements } = await c.snapshot(tabId);
    const trigger = findEl(elements, byLabel(label));
    if (!trigger) throw new Error(`trigger not in snapshot`);
    const click = await c.call("click", { ref: trigger.ref, tabId });
    c.expect(!click.isError, `click errored: ${trim(click.text, 200)}`);
    const state = await c.evalJs(tabId, "window.__state");
    c.note(`click -> ${trim(click.text, 120)}; page events=${JSON.stringify(state?.events)}`);
    c.expect(state?.[key] === true, `menu did not open (${key}=${state?.[key]}, events seen by page: ${JSON.stringify(state?.events)}; click result ${trim(click.text, 120)})`);
  });
}

// 2. Button inside an open shadow root ------------------------------------------------------------
scenario("shadow-button", async (c) => {
  const tabId = await c.open("shadow-button.html");
  const { elements } = await c.snapshot(tabId);
  const btn = findEl(elements, byLabel(/Save changes/));
  if (!btn) throw new Error("shadow button not in snapshot");
  const click = await c.call("click", { ref: btn.ref, tabId });
  const clicks = await c.evalJs(tabId, "window.__clicks");
  c.note(`click -> ${trim(click.text, 160)}`);
  c.expect(clicks === 1, `handler ran ${clicks} times (want 1)`);
  c.expect(!covered(click), `reported as covered by its own shadow host: ${trim(click.text, 160)}`);
});

// 3. confirm() dialog must not wedge the tools ------------------------------------------------------
scenario(
  "confirm-dialog",
  async (c) => {
    const tabId = await c.open("confirm-dialog.html");
    const { elements } = await c.snapshot(tabId);
    const btn = findEl(elements, byLabel(/Delete account/));
    if (!btn) throw new Error("button not in snapshot");
    // (a) The agent opts in: the click answers its own confirm() and reports it; nothing is left open.
    if (c.h.hasParam("click", "onDialog")) {
      const guarded = await c.call("click", { ref: btn.ref, tabId, onDialog: "accept" }, { timeoutMs: 15_000, allowTimeout: true });
      const shown = (guarded.json?.dialogs ?? []) as any[];
      c.note(`guarded click returned in ${guarded.ms}ms; dialogs=${JSON.stringify(shown)}`);
      c.expect(!guarded.timedOut && !guarded.isError, `guarded click failed: ${trim(guarded.text, 160)}`);
      c.expect(shown.some((d) => d.type === "confirm" && /Really delete/i.test(d.message ?? "")), "guarded click did not report the confirm() it answered");
      c.expect((await c.evalJs(tabId, "window.__answer", { timeoutMs: 10_000 })) === true, "page did not continue after onDialog:'accept'");
      c.expect(!c.h.seenDialogs.some((d) => d.type === "confirm"), "a real dialog still opened despite onDialog");
      await c.evalJs(tabId, "window.__answer = undefined");
    } else {
      c.expect(false, "click has no onDialog param");
    }

    // (b) No opt-in: the dialog stays for the user, but nothing hangs - the click returns and the next
    // call fails fast with an actionable message instead of wedging until the hub timeout.
    const click = await c.call("click", { ref: btn.ref, tabId }, { timeoutMs: 15_000, allowTimeout: true });
    const dialogOpen = c.h.seenDialogs.some((d) => d.type === "confirm");
    const text = await c.call("get_page_text", { tabId }, { timeoutMs: 15_000, allowTimeout: true });
    c.note(`dialog opened=${dialogOpen}; click ${click.timedOut ? "HUNG" : "returned"} in ${click.ms}ms; get_page_text ${text.timedOut ? "HUNG" : "returned"} in ${text.ms}ms: ${trim(text.text, 120)}`);
    c.expect(!click.timedOut && click.ms < 3_000, `click hung ${click.ms}ms behind the confirm() dialog`);
    c.expect(!text.timedOut, `get_page_text hung ${text.ms}ms behind the confirm() dialog`);
    c.expect(!!text.isError && /dialog/i.test(text.text), `get_page_text behind a dialog should fail with a dialog hint, got: ${trim(text.text, 160)}`);
    const dialogTool = [...c.h.toolSchemas.keys()].find((n) => /dialog/i.test(n));
    if (dialogTool) {
      const r = await c.call(dialogTool, { tabId, accept: true }, { timeoutMs: 10_000, allowTimeout: true });
      c.note(`${dialogTool} -> ${trim(r.text, 160)}`);
      c.expect(!r.timedOut, `${dialogTool} hung ${r.ms}ms`);
    }
    await c.h.dismissPendingDialogs(true); // stands in for the user clicking OK
    const answer = await c.evalJs(tabId, "window.__answer", { timeoutMs: 10_000 });
    c.expect(answer === true, `page did not continue after the dialog was accepted (__answer=${answer})`);
  },
  { timeout: 120_000 }
);

// 4. 700 buttons, then a portal modal at the end of <body> ------------------------------------------
scenario("many-elements-modal", async (c) => {
  const tabId = await c.open("many-elements-modal.html");
  const { elements, json } = await c.snapshot(tabId);
  const confirm = findEl(elements, (e) => /^Confirm$/.test(String(e.label ?? e.name ?? "").trim()));
  const totalOnPage = 701;
  c.note(`snapshot returned ${elements.length} elements; keys=${Object.keys(json ?? {}).join(",")}`);
  c.expect(!!confirm, `modal's Confirm button has no ref (snapshot returned ${elements.length} of ${totalOnPage} interactive elements)`);
  if (elements.length < totalOnPage) {
    c.expect(
      json?.truncated === true || typeof json?.total === "number",
      `truncation not reported (count=${json?.count}, no truncated/total field)`
    );
  }
  if (confirm) {
    await c.call("click", { ref: confirm.ref, tabId });
    c.expect((await c.evalJs(tabId, "window.__confirmed")) === true, "clicking the modal's Confirm ref did not run its handler");
  }
});

// 5. Custom controls: hidden-input checkbox, role=option listbox, onclick div, <summary> ---------------
scenario("custom-controls", async (c) => {
  const tabId = await c.open("custom-controls.html");
  const { elements } = await c.snapshot(tabId);
  const checkbox = findEl(elements, (e) => (e.tag === "input" && e.type === "checkbox") || /Accept terms/.test(e.label ?? e.name ?? ""));
  const banana = findEl(elements, byLabel(/^Banana$/));
  const div = findEl(elements, byLabel(/Clickable div card/));
  const summary = findEl(elements, (e) => e.tag === "summary" || /^More info$/.test(e.label ?? e.name ?? ""));
  c.note(`refs: checkbox=${checkbox?.ref} option=${banana?.ref} div=${div?.ref} summary=${summary?.ref}`);
  c.expect(checkbox, "no ref for the styled checkbox (input or label)");
  c.expect(banana, "no ref for role=option 'Banana'");
  c.expect(div, "no ref for the onclick/cursor:pointer div");
  c.expect(summary, "no ref for <summary>");
  if (checkbox) {
    const r = await c.call("click", { ref: checkbox.ref, tabId });
    c.expect((await c.evalJs(tabId, "document.getElementById('terms').checked")) === true, `clicking the checkbox ref did not check it: ${trim(r.text, 140)}`);
  }
  if (banana) {
    await c.call("click", { ref: banana.ref, tabId });
    c.expect((await c.evalJs(tabId, "window.__fruit")) === "Banana", "clicking the option ref did not select it");
  }
  if (div) {
    await c.call("click", { ref: div.ref, tabId });
    c.expect((await c.evalJs(tabId, "window.__divClicked")) === true, "clicking the div ref did not run its onclick");
  }
  if (summary) {
    await c.call("click", { ref: summary.ref, tabId });
    c.expect((await c.evalJs(tabId, "document.getElementById('more').open")) === true, "clicking <summary> did not open <details>");
  }
});

// 6. fill semantics for <select> text vs value, checkboxes, and impossible values ---------------------
scenario("select-by-visible-text", async (c) => {
  const tabId = await c.open("select-text-vs-value.html");
  const r = await c.call("fill", { selector: "#state", value: "California", tabId });
  const v = await c.evalJs(tabId, "document.getElementById('state').value");
  c.note(`fill -> ${trim(r.text, 120)}; select.value=${JSON.stringify(v)}`);
  c.expect(v === "CA", `select.value=${JSON.stringify(v)} (want "CA"); fill said ${trim(r.text, 120)}`);
});

scenario("checkbox-fill-true", async (c) => {
  const tabId = await c.open("select-text-vs-value.html");
  const r = await c.call("fill", { selector: "#agree", value: "true", tabId });
  const checked = await c.evalJs(tabId, "document.getElementById('agree').checked");
  c.note(`fill -> ${trim(r.text, 120)}; checked=${checked}`);
  c.expect(checked === true, `checkbox not checked; fill said ${trim(r.text, 120)}`);
});

scenario("fill-reports-unsettable-value", async (c) => {
  const tabId = await c.open("select-text-vs-value.html");
  const r = await c.call("fill", { selector: "#state", value: "Texas", tabId });
  const v = await c.evalJs(tabId, "document.getElementById('state').value");
  const reportedFailure = r.isError || r.json?.filled === false || !!r.json?.notActionable || !!r.json?.error;
  c.note(`fill('Texas') -> ${trim(r.text, 120)}; select.value=${JSON.stringify(v)}`);
  c.expect(reportedFailure, `fill claimed success for a value no option has: ${trim(r.text, 120)} (select.value now ${JSON.stringify(v)})`);
});

// 7. Same selector: hidden mobile input, visible desktop input, and one inside an iframe ---------------
scenario("duplicate-selector", async (c) => {
  const tabId = await c.open("duplicate-selector.html");
  const value = "dup@example.com";
  const r = await c.call("fill", { selector: "input[name=email]", value, tabId });
  const v = await c.evalJs(
    tabId,
    "({mobile: document.getElementById('mobile-email').value, desktop: document.getElementById('desktop-email').value, frame: document.getElementById('frame').contentDocument.getElementById('frame-email').value})"
  );
  c.note(`fill -> ${trim(r.text, 140)} in ${r.ms}ms; values=${JSON.stringify(v)}`);
  c.expect(v?.desktop === value, `visible desktop input not filled (${JSON.stringify(v?.desktop)})`);
  c.expect(v?.mobile === "", `hidden mobile input was changed (${JSON.stringify(v?.mobile)})`);
  c.expect(v?.frame === "", `iframe input was changed too (${JSON.stringify(v?.frame)})`);
  c.expect(typeof r.json?.matchCount === "number", `result has no matchCount: ${trim(r.text, 140)}`);
});

// 8. An iframe whose response never finishes must not stall top-frame work ---------------------------
scenario(
  "slow-iframe",
  async (c) => {
    const tabId = await c.open("slow-iframe.html");
    // eval_js targets only the top frame; poll until the hanging iframe has been inserted.
    let inserted = false;
    for (let i = 0; i < 20 && !inserted; i++) {
      inserted = (await c.evalJs(tabId, "window.__iframeInserted", { timeoutMs: 12_000 })) === true;
      if (!inserted) await new Promise((r) => setTimeout(r, 100));
    }
    if (!inserted) throw new Error("fixture never inserted the hanging iframe");
    const snap = await c.call("snapshot", { tabId }, { timeoutMs: 12_000, allowTimeout: true });
    const click = await c.call("click", { selector: "#go", tabId }, { timeoutMs: 12_000, allowTimeout: true });
    const went = await c.evalJs(tabId, "window.__go", { timeoutMs: 12_000 });
    c.note(`snapshot ${snap.timedOut ? "HUNG" : "ok"} ${snap.ms}ms; click ${click.timedOut ? "HUNG" : "ok"} ${click.ms}ms; __go=${went}`);
    c.expect(!snap.timedOut && !snap.isError, `snapshot did not complete within 12s (${snap.ms}ms: ${trim(snap.text, 100)})`);
    c.expect(!click.timedOut && !click.isError, `click did not complete within 12s (${click.ms}ms: ${trim(click.text, 100)})`);
    c.expect(went === 1, `top-frame click handler ran ${went} times (want 1)`);
  },
  { timeout: 120_000 }
);

// 9. A ref whose node was reused for a different row after a re-sort ----------------------------------
scenario("stale-ref", async (c) => {
  const tabId = await c.open("stale-ref.html");
  const { elements } = await c.snapshot(tabId);
  const alice = findEl(elements, byLabel(/Delete Alice/));
  if (!alice) throw new Error("'Delete Alice' not in snapshot");
  await c.call("click", { selector: "#sort", tabId });
  const order = await c.evalJs(tabId, "[...document.querySelectorAll('#list button')].map(b => b.textContent)");
  const r = await c.call("click", { ref: alice.ref, tabId });
  const deleted: string[] = (await c.evalJs(tabId, "window.__deleted")) ?? [];
  const flaggedStale = r.isError ? /stale/i.test(r.text) : /stale/i.test(String(r.json?.reason ?? "")) || /stale/i.test(String(r.json?.error ?? ""));
  const reResolved = r.json?.reResolved === true || !!r.json?.reResolved;
  c.note(`order after sort=${JSON.stringify(order)}; click(old Alice ref) -> ${trim(r.text, 140)}; __deleted=${JSON.stringify(deleted)}`);
  c.expect(!deleted.some((n) => n !== "Alice"), `old 'Delete Alice' ref silently clicked the wrong row: deleted ${JSON.stringify(deleted)}`);
  c.expect(flaggedStale || reResolved, `result neither flags the ref as stale nor reports reResolved: ${trim(r.text, 140)}`);
  if (reResolved) c.expect(deleted.length === 1 && deleted[0] === "Alice", `reResolved but deleted ${JSON.stringify(deleted)}`);
});

// 10. React-like controlled input --------------------------------------------------------------------
scenario("react-like-input", async (c) => {
  const tabId = await c.open("react-like-input.html");
  const r = await c.call("fill", { selector: "#name", value: "Ada Lovelace", tabId });
  await new Promise((res) => setTimeout(res, 500)); // past one forced re-render (200ms interval)
  const v = await c.evalJs(tabId, "({state: window.__state.name, dom: document.getElementById('name').value})");
  c.note(`fill -> ${trim(r.text, 100)}; ${JSON.stringify(v)}`);
  c.expect(v?.state === "Ada Lovelace", `component state not updated (state=${JSON.stringify(v?.state)})`);
  c.expect(v?.dom === "Ada Lovelace", `DOM value reverted by re-render (dom=${JSON.stringify(v?.dom)})`);
});

// 11. scroll-behavior:smooth + far-below-the-fold target ------------------------------------------------
scenario("smooth-scroll-target", async (c) => {
  const tabId = await c.open("smooth-scroll-target.html");
  const { elements } = await c.snapshot(tabId);
  const far = findEl(elements, byLabel(/Far away button/));
  if (!far) throw new Error("target not in snapshot");
  const r = await c.call("click", { ref: far.ref, tabId });
  const n = await c.evalJs(tabId, "window.__farClicked");
  c.note(`click -> ${trim(r.text, 140)}; __farClicked=${n}`);
  c.expect(n === 1, `handler ran ${n} times (want 1)`);
  c.expect(!covered(r), `reported covered mid-smooth-scroll: ${trim(r.text, 140)}`);
});

// 12. wait_for ------------------------------------------------------------------------------------------
scenario("wait-for-text", async (c) => {
  const tabId = await c.open("wait-for-text.html");
  const useText = c.h.hasParam("wait_for", "text");
  c.note(useText ? "wait_for has a text param" : "wait_for has no text param; used selector #late");
  const args = useText ? { text: "Payment complete", timeoutMs: 8_000, tabId } : { selector: "#late", timeoutMs: 8_000, tabId };
  const r = await c.call("wait_for", args);
  c.expect(!r.isError, `wait_for failed: ${trim(r.text, 140)}`);
  c.expect(r.ms >= 500, `wait_for resolved suspiciously early (${r.ms}ms) - content appears at 1.5s`);
  const text = await c.call("get_page_text", { tabId });
  c.expect(/Payment complete/.test(text.json?.text ?? text.text), "text not on page after wait_for resolved");
});

scenario("wait-for-invalid-selector", async (c) => {
  const tabId = await c.open("wait-for-text.html");
  const r = await c.call("wait_for", { selector: "div[", timeoutMs: 10_000, tabId });
  c.note(`wait_for('div[') -> isError=${r.isError} in ${r.ms}ms: ${trim(r.text, 140)}`);
  c.expect(r.isError, `invalid selector did not produce an error: ${trim(r.text, 140)}`);
  c.expect(r.ms < 2_000, `took ${r.ms}ms to report an invalid selector (want < 2000ms)`);
  c.expect(/invalid|syntax|not a valid/i.test(r.text), `error does not say the selector is invalid: ${trim(r.text, 140)}`);
});

// 13. sanity + batch halting ------------------------------------------------------------------------------
scenario("screenshot-basic", async (c) => {
  const tabId = await c.open("basic.html");
  const r = await c.call("screenshot", { tabId });
  const img = r.content.find((x: any) => x.type === "image");
  c.note(`screenshot -> ${img ? `${img.mimeType} ${img.data?.length ?? 0} b64 chars` : trim(r.text, 140)}`);
  c.expect(!r.isError, `screenshot errored: ${trim(r.text, 140)}`);
  c.expect(img && (img.data?.length ?? 0) > 1_000, "no image content returned");
});

scenario("navigate-basic", async (c) => {
  const tabId = await c.open("basic.html");
  const t1 = await c.call("get_page_text", { tabId });
  c.expect(/basic-marker-7731/.test(t1.text), "first page text missing");
  const nav = await c.call("navigate", { url: c.h.fixtureUrl("basic2.html"), tabId });
  c.expect(!nav.isError && /basic2\.html$/.test(nav.json?.url ?? ""), `navigate result: ${trim(nav.text, 140)}`);
  const t2 = await c.call("get_page_text", { tabId });
  c.expect(/second-marker-4410/.test(t2.text), `second page text missing: ${trim(t2.text, 140)}`);
});

// Harness self-check: the chrome.debugger (CDP) path works inside this Playwright-launched Chromium,
// so a failure elsewhere that involves trusted escalation is a product failure, not the environment.
scenario("trusted-click-sanity", async (c) => {
  const tabId = await c.open("shadow-button.html");
  const r = await c.call("click", { selector: "x-save-button", trusted: true, tabId });
  const clicks = await c.evalJs(tabId, "window.__clicks");
  c.note(`trusted click -> ${trim(r.text, 120)}`);
  c.expect(r.json?.via === "trusted", `trusted click did not go via CDP: ${trim(r.text, 140)}`);
  c.expect(clicks === 1, `a real CDP click on the shadow button's coordinates ran its handler ${clicks} times (want 1)`);
});

scenario("batch-halts-on-notActionable", async (c) => {
  const schema = c.h.toolSchemas.get("browser_batch");
  if (!schema?.properties?.actions) c.skip("browser_batch with {actions:[{name,input}]} not available");
  const tabId = await c.open("batch-covered.html");
  const r = await c.call("browser_batch", {
    actions: [
      { name: "click", input: { selector: "#covered", noEscalate: true, timeoutMs: 1_000, tabId } },
      { name: "fill", input: { selector: "#after", value: "SHOULD-NOT-RUN", tabId } },
    ],
  });
  if (r.isError && /Invalid input|invalid_type|unrecognized/i.test(r.text)) c.skip(`browser_batch param shape differs: ${trim(r.text, 120)}`);
  const after = await c.evalJs(tabId, "document.getElementById('after').value");
  const bought = await c.evalJs(tabId, "window.__bought");
  c.note(`batch -> ${trim(r.text, 200)}; #after=${JSON.stringify(after)}`);
  c.expect(bought === false, "covered button was clicked despite noEscalate");
  c.expect(after === "", `fill after a notActionable click still ran (#after=${JSON.stringify(after)})`);
  c.expect(typeof r.json?.stoppedAt === "number" && (r.json?.executed ?? 2) < 2, `batch did not report stopping at the click: ${trim(r.text, 160)}`);
});

// ---- regressions found in review of the merged fixes ----------------------------------------------

// wait_for + scroll must stay bounded when a child frame never reaches document_idle.
scenario("wait-for-text-with-hung-iframe", async (c) => {
  const tabId = await c.open("slow-iframe-late.html");
  const r = await c.call("wait_for", { text: "Report ready", timeoutMs: 9_000, tabId }, { timeoutMs: 14_000, allowTimeout: true });
  c.note(`wait_for -> ${r.timedOut ? "HUNG" : trim(r.text, 160)} in ${r.ms}ms`);
  c.expect(!r.timedOut && !r.isError, `wait_for did not resolve: ${trim(r.text, 160)}`);
  c.expect(r.ms >= 1_000 && r.ms < 7_000, `wait_for took ${r.ms}ms (text appears at ~2s)`);
});

scenario("scroll-with-hung-iframe", async (c) => {
  const tabId = await c.open("slow-iframe-late.html");
  const r = await c.call("scroll", { selector: "#pane", direction: "down", tabId }, { timeoutMs: 12_000, allowTimeout: true });
  c.note(`scroll -> ${r.timedOut ? "HUNG" : trim(r.text, 160)} in ${r.ms}ms`);
  c.expect(!r.timedOut && !r.isError, `scroll failed: ${trim(r.text, 160)}`);
  c.expect(r.ms < 5_000, `scroll took ${r.ms}ms`);
  c.expect(Number(await c.evalJs(tabId, "document.getElementById('pane').scrollTop")) > 0, "the pane did not scroll");
});

// A portal modal appended after >6000 interactive elements must still get a ref.
scenario("huge-page-portal-modal", async (c) => {
  const tabId = await c.open("huge-modal.html");
  const { elements, json } = await c.snapshot(tabId, { timeoutMs: 20_000 });
  const confirm = findEl(elements, (e) => /^Confirm$/.test(String(e.name ?? e.label ?? "").trim()));
  c.note(`snapshot: count=${json?.count} total=${json?.total} truncated=${json?.truncated} modal=${json?.modal}`);
  c.expect(!!confirm, "the modal's Confirm button has no ref on a 7000-element page");
  const mo = await c.call("snapshot", { tabId, modalOnly: true });
  const moEls = (mo.json?.elements ?? []) as any[];
  c.expect(moEls.some((e) => /^Confirm$/.test(String(e.name ?? "").trim())), `modalOnly snapshot lacks Confirm (${moEls.length} elements)`);
  if (confirm) {
    await c.call("click", { ref: confirm.ref, tabId });
    c.expect((await c.evalJs(tabId, "window.__confirmed")) === true, "clicking Confirm did not run its handler");
  }
});

// The dialog guard must outlive the action's auto-wait: the button only becomes clickable at ~4s.
scenario("on-dialog-after-auto-wait", async (c) => {
  const tabId = await c.open("late-confirm.html");
  const { elements } = await c.snapshot(tabId);
  const btn = findEl(elements, byLabel(/Delete project/));
  if (!btn) throw new Error("button not in snapshot");
  const before = c.h.seenDialogs.length;
  const r = await c.call("click", { ref: btn.ref, tabId, onDialog: "accept", timeoutMs: 8_000 }, { timeoutMs: 20_000, allowTimeout: true });
  const shown = (r.json?.dialogs ?? []) as any[];
  c.note(`click -> ${trim(r.text, 200)} in ${r.ms}ms`);
  c.expect(!r.timedOut && !r.isError && r.json?.clicked === true, `click failed: ${trim(r.text, 160)}`);
  c.expect(r.ms >= 3_000, `click returned in ${r.ms}ms - before the button was enabled?`);
  c.expect(shown.some((d) => d.type === "confirm" && /for good/.test(d.message ?? "")), "dialogs[] does not report the confirm()");
  c.expect(c.h.seenDialogs.length === before, "a native dialog opened despite onDialog");
  c.expect((await c.evalJs(tabId, "window.__answer")) === true, "page did not get the accepted answer");
  // The guard is gone afterwards: a page call to confirm() reaches the real (native) implementation again.
  const restored = await c.evalJs(tabId, "String(window.confirm).includes('[native code]') && !('__bbDlgGuard' in window)");
  c.expect(restored === true, "dialog guard still installed after the action");
});

// Filling a contenteditable must not make its own ref stale (fingerprint ignores the editor's text).
scenario("contenteditable-refill", async (c) => {
  const tabId = await c.open("contenteditable.html");
  const { elements } = await c.snapshot(tabId);
  const ed = findEl(elements, (e) => String(e.tag) === "div" || /textbox/.test(String(e.role ?? "")));
  if (!ed) throw new Error(`editor not in snapshot: ${trim(JSON.stringify(elements), 200)}`);
  const a = await c.call("fill", { ref: ed.ref, value: "first draft", tabId });
  const b = await c.call("fill", { ref: ed.ref, value: "second draft", tabId });
  c.note(`fill1 -> ${trim(a.text, 120)}; fill2 -> ${trim(b.text, 160)}`);
  c.expect(!a.isError && a.json?.filled !== false, `first fill failed: ${trim(a.text, 160)}`);
  c.expect(!b.isError && b.json?.filled !== false && b.json?.notActionable !== true, `second fill on the same ref failed: ${trim(b.text, 160)}`);
  const text = String(await c.evalJs(tabId, "document.getElementById('ed').innerText")).trim();
  c.expect(text === "second draft", `editor text is ${JSON.stringify(text)}`);
});

// ---- discovery: nameless icon-only controls and hover-revealed toolbars ----------------------------

// Icon-only buttons / sidebar options have no accessible name; the snapshot must give them a `hint`
// (test id, data-key, tooltip, icon name, stable id) and `filter` must match it.
scenario("icon-only-hints", async (c) => {
  const tabId = await c.open("icon-buttons.html");
  const { elements } = await c.snapshot(tabId);
  const hints = elements.map((e) => e.hint ?? null);
  c.note(`hints=${JSON.stringify(hints)}`);
  const has = (h: string) => elements.some((e) => !e.name && e.hint === h);
  for (const h of [
    "data-testid=run-button",
    "icon:trash-2",
    "data-testid=create-cell-button",
    "Close helper pane",
    "data-key=files",
    "data-key=variables",
    "icon:gear",
    "id=settings-toggle",
  ]) c.expect(has(h), `no nameless element with hint ${JSON.stringify(h)} (hints: ${JSON.stringify(hints)})`);
  const named = findEl(elements, (e) => e.name === "Named already");
  c.expect(named && named.hint === undefined, `a named element got a hint: ${JSON.stringify(named)}`);
  c.expect(elements.every((e) => !/[\n\r]/.test(String(e.hint ?? ""))), "a hint contains a newline");
  const lb = findEl(elements, (e) => e.role === "listbox");
  c.expect(!lb || lb.hint === undefined, `the listbox borrowed its first option's hint: ${JSON.stringify(lb)}`);
  c.expect(!elements.some((e) => /radix-/.test(String(e.hint ?? ""))), "an auto-generated id leaked into a hint");
  // filter matches hint text
  const f = await c.call("snapshot", { tabId, filter: "key=files" });
  const fe = (f.json?.elements ?? []) as any[];
  c.expect(fe.length === 1 && fe[0].hint === "data-key=files", `filter key=files returned ${trim(f.text, 160)}`);
  const f2 = await c.call("snapshot", { tabId, filter: "run-button" });
  const fe2 = (f2.json?.elements ?? []) as any[];
  c.expect(fe2.length === 1 && fe2[0].hint === "data-testid=run-button", `filter run-button returned ${trim(f2.text, 160)}`);
  // the hinted ref is usable
  const run = findEl(fe2, (e) => e.hint === "data-testid=run-button");
  if (run) {
    await c.call("click", { ref: run.ref, tabId });
    c.expect(JSON.stringify(await c.evalJs(tabId, "window.__clicks")) === "[0]", "clicking the hinted ref did not hit the run button");
  }
  // ax_snapshot renders the hint, escaped onto one line
  const ax = await c.call("ax_snapshot", { tabId });
  c.note(`ax: ${trim(ax.text, 300)}`);
  c.expect(/button[^\n"]*\[hint="data-testid=run-button"\] \[ref=\d+\]/.test(ax.text), `ax_snapshot lacks the run-button hint: ${trim(ax.text, 300)}`);
  c.expect(/option \[hint="data-key=files"\]/.test(ax.text), "ax_snapshot lacks the data-key hint");
  c.expect(!/^\s*- button "Fake"/m.test(ax.text), "a hostile data-testid forged an ax line");
});

// A per-card toolbar button that is 0x0 until its card is :hover'ed: a synthetic click must fail fast
// with an actionable explanation, and a trusted hover on the named container then makes it clickable.
scenario("hover-revealed-button", async (c) => {
  const tabId = await c.open("hover-reveal.html");
  const r = await c.call("click", { selector: "#run-cell", tabId, noEscalate: true }, { timeoutMs: 15_000, allowTimeout: true });
  c.note(`click -> ${trim(r.text, 260)} in ${r.ms}ms`);
  c.expect(r.json?.notActionable === true && r.json?.reason === "hidden", `want reason hidden: ${trim(r.text, 160)}`);
  c.expect(/zero-size/.test(r.json?.detail ?? ""), `detail does not say zero-size: ${r.json?.detail}`);
  c.expect(/hover/.test(r.json?.hint ?? "") && /#cell-1/.test(r.json?.hint ?? ""), `hint does not name the container: ${r.json?.hint}`);
  c.expect(r.ms < 3_500, `took ${r.ms}ms (should stop waiting after ~1s for a hover-revealed target)`);
  const hv = await c.call("hover", { selector: r.json?.container ?? "#cell-1", trusted: true, tabId });
  c.expect(!hv.isError, `trusted hover failed: ${trim(hv.text, 160)}`);
  const ok = await c.call("click", { selector: "#run-cell", tabId, timeoutMs: 3_000 });
  c.note(`after hover click -> ${trim(ok.text, 160)}`);
  c.expect((await c.evalJs(tabId, "window.__ran")) === 1, `button did not run after trusted hover: ${trim(ok.text, 160)}`);
});

// Watch mode: a page can neither pre-disable error capture nor forge timeline lines via the relay event.
scenario("watch-relay-not-forgeable", async (c) => {
  if (!c.h.toolSchemas.has("watch_start")) c.skip("watch tools not exposed");
  const tabId = await c.open("watch-hostile.html");
  const ws = await c.call("watch_start", { tabId, console: true, retain: "none" });
  c.expect(!ws.isError, `watch_start failed: ${trim(ws.text, 160)}`);
  try {
    await c.evalJs(tabId, "window.__forge(); setTimeout(() => { throw new Error('REAL-BOOM-4242') }, 0); 1");
    let text = "";
    for (let i = 0; i < 12 && !/REAL-BOOM-4242/.test(text); i++) {
      const r = await c.call("watch_read", { waitMs: 1_000 });
      text = r.text;
    }
    c.note(`watch_read -> ${trim(text, 300)}`);
    c.expect(/REAL-BOOM-4242/.test(text), "a real uncaught error was not captured (page pre-set __bbWatchMain?)");
    c.expect(!/FORGED-777|Transfer/.test(text), `a forged relay event reached the timeline: ${trim(text, 300)}`);
  } finally {
    await c.call("watch_stop", {}).catch(() => undefined);
  }
});

// Restarting interception must release (not forget) the requests the first one is holding.
scenario("intercept-restart-releases-paused", async (c) => {
  if (!c.h.toolSchemas.has("intercept_start")) c.skip("intercept tools not exposed");
  const tabId = await c.open("basic.html");
  try {
    await c.call("intercept_start", { tabId, patterns: [{ urlPattern: "*held=1*" }] });
    await c.evalJs(tabId, "window.__held = 'pending'; fetch(location.href + '?held=1').then(r => { window.__held = 'done:' + r.status; }, e => { window.__held = 'err:' + e; }); 1");
    let pending: any = null;
    for (let i = 0; i < 20; i++) {
      pending = await c.call("intercept_pending", { tabId });
      if ((pending.json?.count ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    c.expect((pending?.json?.count ?? 0) === 1, `request was not held: ${trim(pending?.text ?? "", 160)}`);
    const again = await c.call("intercept_start", { tabId, patterns: [{ urlPattern: "*never-matches*" }] });
    c.note(`restart -> ${trim(again.text, 160)}`);
    let held = "";
    for (let i = 0; i < 20; i++) {
      held = String(await c.evalJs(tabId, "window.__held"));
      if (held !== "pending") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    c.expect(/^done:200$/.test(held), `held request was not released by the restart (page sees ${held})`);
    c.expect(again.json?.releasedPaused === 1, `restart did not report releasedPaused: ${trim(again.text, 160)}`);
  } finally {
    await c.call("intercept_stop", { tabId }).catch(() => undefined);
  }
});
