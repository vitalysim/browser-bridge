// Coverage guard: every MCP tool the server registers must be exercised by at least one e2e scenario.
// Static on purpose (no browser): it reads the tool() registrations from the server sources and looks
// for each name used as a quoted tool name in the other e2e test files, so a new tool cannot ship
// without an end-to-end scenario. Helpers that call a tool indirectly can list it in INDIRECT below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(SRC, "..", "..", "server", "src");

/** Tools called only through shared helpers in scenario.ts / harness.ts (e.g. c.open -> tab_new). */
const INDIRECT_FILES = ["scenario.ts", "harness.ts"];

function registeredTools(): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(SERVER_SRC).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(SERVER_SRC, f), "utf8");
    for (const m of src.matchAll(/\btool\(\s*"([a-z][a-z0-9_]*)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

function scenarioSources(): string {
  const files = readdirSync(SRC).filter((f) => (f.endsWith(".test.ts") && f !== "coverage.test.ts") || INDIRECT_FILES.includes(f));
  return files.map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
}

test("every registered MCP tool is exercised by an e2e scenario", () => {
  const tools = registeredTools();
  assert.ok(tools.length >= 70, `expected the full tool set, found only ${tools.length} registrations`);
  const src = scenarioSources();
  const missing = tools.filter((name) => !new RegExp(`["'\`]${name}["'\`]`).test(src));
  assert.deepEqual(missing, [], `tools with no e2e scenario (${missing.length}/${tools.length}): ${missing.join(", ")}`);
});
