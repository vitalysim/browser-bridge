// Per-call structured log: one line per tool call with timestamp, name, tabId, duration and outcome -
// and NEVER parameter values (they can be passwords, cookies, file contents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCallLine, shortDetail, log } from "../src/log.js";
import { fakeBridge, captureStderr } from "./helpers/fake-server.js";

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

test("formatCallLine is one compact line with timestamp, tool, tab, ms, outcome", () => {
  const line = formatCallLine({ tool: "click", tabId: 7, ms: 12.4, outcome: "notActionable", detail: "notActionable: covered" }, new Date(0));
  assert.equal(line, "1970-01-01T00:00:00.000Z [call] click tab=7 12ms notActionable notActionable: covered");
});

test("a non-numeric tabId is never echoed", () => {
  const line = formatCallLine({ tool: "x", tabId: "secret", ms: 1, outcome: "ok" });
  assert.ok(!line.includes("secret"));
});

test("shortDetail collapses newlines and caps at 200 chars", () => {
  const d = shortDetail("a\nb\n\tc " + "z".repeat(500));
  assert.ok(!d.includes("\n"));
  assert.ok(d.length <= 200);
  assert.ok(d.startsWith("a b c "));
});

test("log() prefixes an ISO timestamp and keeps the message", async () => {
  const { lines } = await captureStderr(async () => log("[hub] extension connected"));
  assert.match(lines[0], ISO);
  assert.ok(lines[0].endsWith(" [hub] extension connected"));
});

test("each tool call logs one line with outcome and no param values", async () => {
  const b = fakeBridge({
    fill: () => ({ filled: true }),
    click: () => ({ notActionable: true, reason: "covered" }),
    navigate: () => {
      throw new Error("Extension call 'navigate' timed out after 30000ms");
    },
  });
  const secret = "hunter2-SECRET-VALUE";
  const { lines } = await captureStderr(async () => {
    await b.invoke("fill", { selector: "#pw", value: secret, tabId: 42 });
    await b.invoke("click", { selector: "#go" });
    await b.invoke("navigate", { url: `https://x.test/?token=${secret}` });
  });
  const calls = lines.filter((l) => l.includes("[call]"));
  assert.equal(calls.length, 3);
  for (const l of calls) {
    assert.match(l, ISO);
    assert.ok(!l.includes(secret), `leaked a param value: ${l}`);
    assert.ok(!l.includes("#pw") && !l.includes("x.test"), `leaked a param value: ${l}`);
  }
  assert.match(calls[0], /\[call\] fill tab=42 \d+ms ok$/);
  assert.match(calls[1], /\[call\] click \d+ms notActionable notActionable: covered$/);
  assert.match(calls[2], /\[call\] navigate \d+ms error \[TIMEOUT\] Extension call 'navigate' timed out/);
});

test("the tabId the extension reports is logged when the caller omitted it", async () => {
  const b = fakeBridge({ navigate: () => ({ tabId: 99, title: "t", url: "u" }) });
  const { lines } = await captureStderr(() => b.invoke("navigate", { url: "https://x.test" }));
  assert.match(lines.find((l) => l.includes("[call]"))!, /navigate tab=99 /);
});
