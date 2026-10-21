// scripts/rotate-token.mjs + scripts/scrub-log.mjs helpers, on fixtures in a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// @ts-ignore - plain .mjs module without types
import * as tt from "../../scripts/lib/token-tools.mjs";

const { rotateTokenFile, rewriteClaudeConfig, updateClaudeConfigFile, scrubFile, logFiles, readTokenFile } = tt as any;
const OLD = "a".repeat(32);
const NEW = "b".repeat(32);
const mode = (p: string) => statSync(p).mode & 0o777;
const tmp = () => mkdtempSync(join(tmpdir(), "bb-tok-"));

function fixtureConfig() {
  return {
    numStartups: 3,
    mcpServers: { "browser-bridge": { type: "http", url: "http://127.0.0.1:8765/mcp", headers: { Authorization: `Bearer ${OLD}` } } },
    projects: {
      "/Users/x/proj": {
        mcpServers: {
          "browser-bridge": { type: "http", url: "http://127.0.0.1:8765/mcp", headers: { Authorization: `Bearer ${OLD}` } },
          other: { type: "http", url: "https://example.com/mcp", headers: { Authorization: `Bearer ${OLD}` } },
        },
      },
      "/Users/x/env": { mcpServers: { "browser-bridge": { type: "http", url: "http://127.0.0.1:8765/mcp", headers: { Authorization: "Bearer ${BROWSER_BRIDGE_TOKEN}" } } } },
      "/Users/x/stale": { mcpServers: { "browser-bridge": { type: "http", headers: { Authorization: "Bearer somethingelse" } } } },
      "/Users/x/none": {},
    },
  };
}

test("rotateTokenFile keeps the old token as token.prev and writes the new one, both 0600", () => {
  const dir = tmp();
  writeFileSync(join(dir, "token"), OLD + "\n", { mode: 0o644 });
  const r = rotateTokenFile(dir, NEW);
  assert.equal(r.oldToken, OLD);
  assert.equal(readTokenFile(join(dir, "token")), NEW);
  assert.equal(readTokenFile(join(dir, "token.prev")), OLD);
  assert.equal(mode(join(dir, "token")), 0o600);
  assert.equal(mode(join(dir, "token.prev")), 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ["token", "token.prev"], "no temp files left behind");
});

test("rotateTokenFile on a fresh dir writes a token and no .prev", () => {
  const dir = tmp();
  const r = rotateTokenFile(dir);
  assert.equal(r.oldToken, null);
  assert.match(readTokenFile(join(dir, "token")), /^[0-9a-f]{32}$/);
  assert.equal(existsSync(join(dir, "token.prev")), false);
});

test("rewriteClaudeConfig rewrites only browser-bridge entries with the literal old bearer", () => {
  const cfg = fixtureConfig();
  const r = rewriteClaudeConfig(cfg, OLD, NEW);
  assert.equal(r.changed.length, 2);
  assert.equal(cfg.mcpServers["browser-bridge"].headers.Authorization, `Bearer ${NEW}`);
  assert.equal(cfg.projects["/Users/x/proj"].mcpServers["browser-bridge"].headers.Authorization, `Bearer ${NEW}`);
  assert.equal(cfg.projects["/Users/x/proj"].mcpServers.other.headers.Authorization, `Bearer ${OLD}`, "other servers untouched");
  assert.equal(cfg.projects["/Users/x/stale"].mcpServers["browser-bridge"].headers.Authorization, "Bearer somethingelse");
  assert.equal(r.envBased.length, 1);
  assert.ok(!JSON.stringify(r).includes(OLD) && !JSON.stringify(r).includes(NEW), "report carries no token values");
});

test("updateClaudeConfigFile: dry-run writes nothing; a real run keeps a .bak and the file mode", () => {
  const dir = tmp();
  const f = join(dir, ".claude.json");
  const original = JSON.stringify(fixtureConfig(), null, 2) + "\n";
  writeFileSync(f, original);
  chmodSync(f, 0o600);

  const dry = updateClaudeConfigFile(f, OLD, NEW, { dryRun: true });
  assert.equal(dry.changed.length, 2);
  assert.equal(readFileSync(f, "utf8"), original);
  assert.equal(existsSync(f + ".bak"), false);

  const real = updateClaudeConfigFile(f, OLD, NEW);
  assert.equal(real.changed.length, 2);
  assert.equal(readFileSync(f + ".bak", "utf8"), original);
  assert.equal(mode(f + ".bak"), 0o600);
  assert.equal(mode(f), 0o600);
  const after = readFileSync(f, "utf8");
  assert.ok(after.endsWith("}\n"));
  const parsed = JSON.parse(after);
  assert.equal(parsed.numStartups, 3, "unrelated keys preserved");
  assert.equal(parsed.mcpServers["browser-bridge"].headers.Authorization, `Bearer ${NEW}`);
  assert.equal(after.split(OLD).length - 1, 1, "only the non-bridge entry still has the old token");
});

test("updateClaudeConfigFile leaves a missing or invalid file alone", () => {
  const dir = tmp();
  assert.equal(updateClaudeConfigFile(join(dir, "nope.json"), OLD, NEW).exists, false);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  const r = updateClaudeConfigFile(bad, OLD, NEW);
  assert.match(r.error, /not valid JSON/);
  assert.equal(readFileSync(bad, "utf8"), "{ not json");
});

test("scrubFile removes lines containing either token; dry-run only counts", async () => {
  const dir = tmp();
  const f = join(dir, "server.log");
  const content = ["ok line 1", `leak ws://127.0.0.1:8765/ws?token=${OLD}`, "ok line 2", `Bearer ${NEW}`, "ok line 3", ""].join("\n");
  writeFileSync(f, content, { mode: 0o644 });

  const dry = await scrubFile(f, [OLD, NEW], { dryRun: true });
  assert.equal(dry.removed, 2);
  assert.equal(readFileSync(f, "utf8"), content);

  const real = await scrubFile(f, [OLD, NEW]);
  assert.equal(real.removed, 2);
  assert.equal(readFileSync(f, "utf8"), "ok line 1\nok line 2\nok line 3\n");
  assert.equal(mode(f), 0o600);
  assert.deepEqual(readdirSync(dir), ["server.log"], "no temp file left");
});

test("scrubFile refuses to run without a plausible secret", async () => {
  const dir = tmp();
  const f = join(dir, "server.log");
  writeFileSync(f, "x\n");
  await assert.rejects(scrubFile(f, ["", "short"]), /no usable secret/);
});

test("logFiles finds server.log, rotations and launchd.log only", () => {
  const dir = tmp();
  for (const n of ["server.log", "server.log.1", "server.log.3", "launchd.log", "token", "server.log.bak"]) writeFileSync(join(dir, n), "x");
  assert.deepEqual(logFiles(dir).map((p: string) => p.slice(dir.length + 1)), ["launchd.log", "server.log", "server.log.1", "server.log.3"]);
});
