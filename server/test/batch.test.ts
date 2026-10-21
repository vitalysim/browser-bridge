// browser_batch must halt on a step that FAILED without throwing: click/fill/hover/type report
// {notActionable} / {filled:false} as ordinary results, and a batch that kept going would type into
// whatever the failed click left focused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeBridge, captureStderr } from "./helpers/fake-server.js";

const parse = (out: any) => JSON.parse(out.content[0].text);

function bridge(clickResult: any = { clicked: true }) {
  return fakeBridge({
    click: () => clickResult,
    fill: (p) => (p.selector === "#bad" ? { filled: false } : { filled: true }),
    type: () => ({ typed: true }),
    eval_js: () => ({ error: "ReferenceError: x is not defined" }),
    navigate: () => {
      throw new Error("Extension call 'navigate' timed out after 30000ms");
    },
  });
}

const run = async (b: ReturnType<typeof fakeBridge>, args: any) =>
  parse((await captureStderr(() => b.invoke("browser_batch", args))).value);

test("a clean batch runs every step", async () => {
  const r = await run(bridge(), {
    actions: [
      { name: "click", input: { selector: "#a" } },
      { name: "type", input: { text: "hi", selector: "#t" } },
    ],
  });
  assert.equal(r.executed, 2);
  assert.equal(r.stoppedAt, undefined);
});

test("halts on a notActionable click and reports index, tool and reason", async () => {
  const b = bridge({ notActionable: true, reason: "covered" });
  const r = await run(b, {
    actions: [
      { name: "fill", input: { selector: "#ok", value: "x" } },
      { name: "click", input: { selector: "#submit" } },
      { name: "type", input: { text: "never", selector: "#t" } },
    ],
  });
  assert.equal(r.stoppedAt, 1);
  assert.equal(r.failedTool, "click");
  assert.equal(r.outcome, "notActionable");
  assert.match(r.error, /covered/);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[1].reason, "notActionable: covered");
  // The step after the failure never reached the browser.
  assert.equal(b.calls.filter((c) => c.method === "type").length, 0);
});

test("halts on fill {filled:false}", async () => {
  const r = await run(bridge(), {
    actions: [
      { name: "fill", input: { selector: "#bad", value: "x" } },
      { name: "click", input: { selector: "#a" } },
    ],
  });
  assert.equal(r.stoppedAt, 0);
  assert.equal(r.failedTool, "fill");
  assert.match(r.error, /filled:false/);
});

test("halts on a result carrying an `error` field", async () => {
  const r = await run(bridge(), { actions: [{ name: "eval_js", input: { code: "x" } }, { name: "click", input: { selector: "#a" } }] });
  assert.equal(r.stoppedAt, 0);
  assert.equal(r.outcome, "error");
  assert.match(r.error, /ReferenceError/);
});

test("continueOnError on a step lets the batch carry on and records the failure", async () => {
  const b = bridge({ notActionable: true, reason: "hidden" });
  const r = await run(b, {
    actions: [
      { name: "click", input: { selector: "#maybe" }, continueOnError: true },
      { name: "navigate", input: { url: "https://x.test" }, continueOnError: true },
      { name: "type", input: { text: "ok", selector: "#t" } },
    ],
  });
  assert.equal(r.stoppedAt, undefined);
  assert.equal(r.executed, 3);
  assert.equal(r.results[0].outcome, "notActionable");
  assert.equal(r.results[1].outcome, "error");
  assert.match(r.results[1].error, /timed out/);
});

test("stopOnNotActionable:false tolerates notActionable but still halts on errors", async () => {
  const b = bridge({ notActionable: true, reason: "disabled" });
  const r = await run(b, {
    stopOnNotActionable: false,
    actions: [
      { name: "click", input: { selector: "#a" } },
      { name: "eval_js", input: { code: "x" } },
      { name: "type", input: { text: "never", selector: "#t" } },
    ],
  });
  assert.equal(r.stoppedAt, 1);
  assert.equal(r.failedTool, "eval_js");
});

test("a thrown step error still halts with its message", async () => {
  const r = await run(bridge(), { actions: [{ name: "navigate", input: { url: "https://x.test" } }] });
  assert.equal(r.stoppedAt, 0);
  assert.equal(r.failedTool, "navigate");
  assert.match(r.error, /timed out/);
});
