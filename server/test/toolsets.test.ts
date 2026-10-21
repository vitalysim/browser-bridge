// BRIDGE_TOOLSETS: every tool is classified, the default registers everything, and a selection
// registers only the chosen groups (core always included).
import { test } from "node:test";
import assert from "node:assert/strict";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { TOOL_GROUPS, TOOLSETS, parseToolsets, groupOf } from "../src/toolsets.js";
import { fakeBridge } from "./helpers/fake-server.js";

test("every registered tool has an explicit group", () => {
  const { tools } = fakeBridge();
  const missing = [...tools.keys()].filter((n) => !(n in TOOL_GROUPS));
  assert.deepEqual(missing, []);
  // and the table lists nothing that does not exist
  const stale = Object.keys(TOOL_GROUPS).filter((n) => !tools.has(n));
  assert.deepEqual(stale, []);
});

test("default (unset / empty / all) registers every tool", () => {
  const all = fakeBridge().tools.size;
  assert.equal(fakeBridge({}, { toolsets: parseToolsets(undefined) }).tools.size, all);
  assert.equal(fakeBridge({}, { toolsets: parseToolsets("") }).tools.size, all);
  assert.equal(fakeBridge({}, { toolsets: parseToolsets("core,all") }).tools.size, all);
});

test("a selection registers only those groups, always with core", () => {
  const sel = parseToolsets(" Watch , bogus");
  assert.deepEqual([...sel.enabled!].sort(), ["core", "watch"]);
  assert.deepEqual(sel.unknown, ["bogus"]);
  const { tools } = fakeBridge({}, { toolsets: sel });
  for (const name of tools.keys()) assert.ok(["core", "watch"].includes(groupOf(name)), name);
  assert.ok(tools.has("watch_read") && tools.has("click") && !tools.has("fuzz") && !tools.has("emulate_device"));
});

test("an unclassified (future) tool defaults to core", () => {
  assert.equal(groupOf("handle_dialog_from_the_future"), "core");
});

test("a tool outside the selection cannot be reached through browser_batch either", async () => {
  const b = fakeBridge({}, { toolsets: parseToolsets("core") });
  const out = await b.invoke("browser_batch", { actions: [{ name: "watch_status" }] });
  assert.match(JSON.parse(out.content[0].text).error, /Unknown tool 'watch_status'/);
});

// Not an assertion: prints the per-group size of descriptions + input schemas (chars, ~tokens at
// chars/4), the cost each group adds to every session's tool list.
test("per-group tool-surface size (report)", () => {
  const { tools } = fakeBridge();
  const rows = new Map<string, { n: number; chars: number }>(TOOLSETS.map((g) => [g, { n: 0, chars: 0 }]));
  for (const [name, t] of tools) {
    const schema = JSON.stringify(zodToJsonSchema(z.object(t.inputSchema)));
    const row = rows.get(groupOf(name))!;
    row.n++;
    row.chars += name.length + t.description.length + schema.length;
  }
  let total = 0;
  const lines = [...rows].map(([g, r]) => {
    total += r.chars;
    return `${g.padEnd(9)} ${String(r.n).padStart(3)} tools ${String(r.chars).padStart(7)} chars ~${Math.round(r.chars / 4)} tokens`;
  });
  lines.push(`${"TOTAL".padEnd(9)} ${String(tools.size).padStart(3)} tools ${String(total).padStart(7)} chars ~${Math.round(total / 4)} tokens`);
  if (process.env.BRIDGE_TOOLSET_REPORT) console.log(lines.join("\n"));
  assert.ok(total > 0);
});
