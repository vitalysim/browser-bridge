// The service installer's pure parts (scripts/lib/service.mjs): plist/unit generation, node-path
// pinning, and the bootstrap-then-verify flow against a fake launchctl. Nothing here runs launchctl.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore - plain .mjs module without types
import * as svc from "../../scripts/lib/service.mjs";

const { xmlEscape, systemdQuote, buildPlist, buildSystemdUnit, pickNodePath, isVersionedNodePath, parseLaunchctlPrint, bootstrapAndVerify, serviceEnv } = svc as any;

test("xmlEscape escapes the five XML specials", () => {
  assert.equal(xmlEscape(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

test("buildPlist escapes values, logs to launchd.log, disables stderr mirroring", () => {
  const plist = buildPlist({ node: "/opt/homebrew/bin/node", entry: "/Users/x/R&D <bb>/server/dist/index.js", serverDir: "/Users/x/R&D <bb>/server", dataDir: "/Users/x/.browser-bridge" });
  assert.ok(plist.includes("<string>/Users/x/R&amp;D &lt;bb&gt;/server/dist/index.js</string>"));
  assert.ok(!plist.includes("R&D <bb>"));
  assert.ok(plist.includes("<string>/Users/x/.browser-bridge/launchd.log</string>"));
  assert.ok(!plist.includes("server.log</string>"), "launchd no longer appends to server.log");
  assert.match(plist, /<key>BRIDGE_LOG_STDERR<\/key>\s*<string>0<\/string>/);
});

test("serviceEnv only sets BRIDGE_PORT for a non-default port", () => {
  assert.equal(serviceEnv({ port: 8765 }).BRIDGE_PORT, undefined);
  assert.equal(serviceEnv({ port: 9000 }).BRIDGE_PORT, "9000");
});

test("systemd: paths with spaces/quotes/$/% are quoted and escaped; plain paths untouched", () => {
  assert.equal(systemdQuote("/usr/bin/node"), "/usr/bin/node");
  assert.equal(systemdQuote("/home/a b/x.js"), '"/home/a b/x.js"');
  assert.equal(systemdQuote('/x/"q"'), '"/x/\\"q\\""');
  assert.equal(systemdQuote("/x/$HOME/100%"), '"/x/$$HOME/100%%"');
  const unit = buildSystemdUnit({ node: "/usr/bin/node", entry: "/home/a b/server/dist/index.js", serverDir: "/home/a b/server" });
  assert.ok(unit.includes('ExecStart=/usr/bin/node "/home/a b/server/dist/index.js"'));
  assert.ok(unit.includes('WorkingDirectory="/home/a b/server"'));
  assert.ok(unit.includes("UMask=0077"));
});

test("isVersionedNodePath recognizes Cellar/nvm/fnm/volta paths", () => {
  assert.equal(isVersionedNodePath("/opt/homebrew/Cellar/node/24.3.0/bin/node"), true);
  assert.equal(isVersionedNodePath("/opt/homebrew/Cellar/node@20/20.19.0/bin/node"), true);
  assert.equal(isVersionedNodePath("/Users/a/.nvm/versions/node/v22.1.0/bin/node"), true);
  assert.equal(isVersionedNodePath("/opt/homebrew/bin/node"), false);
  assert.equal(isVersionedNodePath("/usr/bin/node"), false);
});

const CELLAR = "/opt/homebrew/Cellar/node/24.3.0/bin/node";
const fs = (links: Record<string, string>) => ({
  exists: (p: string) => p in links || p === CELLAR,
  realpath: (p: string) => {
    if (p === CELLAR) return CELLAR;
    if (!(p in links)) throw new Error("ENOENT");
    return links[p];
  },
});

test("pickNodePath prefers the Homebrew symlink that resolves to the same binary", () => {
  const r = pickNodePath({ execPath: CELLAR, whichNode: null, ...fs({ "/opt/homebrew/bin/node": CELLAR }) });
  assert.equal(r.path, "/opt/homebrew/bin/node");
  assert.equal(r.warning, null);
});

test("pickNodePath uses `which node` when it is a stable link to the same binary", () => {
  const r = pickNodePath({ execPath: CELLAR, whichNode: "/usr/local/bin/node", candidates: [], ...fs({ "/usr/local/bin/node": CELLAR }) });
  assert.equal(r.path, "/usr/local/bin/node");
  assert.equal(r.source, "which");
});

test("pickNodePath never swaps in a DIFFERENT node; falls back to execPath with a warning", () => {
  const r = pickNodePath({ execPath: CELLAR, whichNode: null, ...fs({ "/opt/homebrew/bin/node": "/opt/homebrew/Cellar/node/25.0.0/bin/node" }) });
  assert.equal(r.path, CELLAR);
  assert.match(r.warning, /version-specific/);
});

test("pickNodePath keeps a non-versioned execPath as is", () => {
  const r = pickNodePath({ execPath: "/usr/bin/node", whichNode: null, ...fs({}) });
  assert.deepEqual(r, { path: "/usr/bin/node", warning: null, source: "execPath" });
});

test("pickNodePath ignores an nvm `which node`", () => {
  const nvm = "/Users/a/.nvm/versions/node/v22.1.0/bin/node";
  const r = pickNodePath({ execPath: nvm, whichNode: nvm, candidates: [], exists: () => true, realpath: (p: string) => p });
  assert.equal(r.path, nvm);
  assert.ok(r.warning);
});

const PRINT_RUNNING = `gui/501/browser-bridge = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n}`;
const PRINT_WAITING = `gui/501/browser-bridge = {\n\tstate = not running\n\tlast exit code = 1\n}`;

test("parseLaunchctlPrint", () => {
  assert.deepEqual(parseLaunchctlPrint(PRINT_RUNNING), { loaded: true, state: "running", running: true, pid: 4242, lastExit: "(never exited)" });
  assert.equal(parseLaunchctlPrint(PRINT_WAITING).running, false);
  assert.equal(parseLaunchctlPrint("").loaded, false);
});

function fakeLaunchctl(script: { bootstrap: number[]; print: Array<{ status: number; stdout: string }> }) {
  const calls: string[][] = [];
  const fn = (args: string[]) => {
    calls.push(args);
    if (args[0] === "bootstrap") return { status: script.bootstrap.shift() ?? 0, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
    if (args[0] === "print") return { ...(script.print.length > 1 ? script.print.shift()! : script.print[0]), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { fn, calls };
}
const noSleep = async () => undefined;

test("bootstrapAndVerify: success once running and /health answers", async () => {
  const l = fakeLaunchctl({ bootstrap: [0], print: [{ status: 0, stdout: PRINT_WAITING }, { status: 0, stdout: PRINT_RUNNING }] });
  let n = 0;
  const r = await bootstrapAndVerify({ uid: 501, plistPath: "/p.plist", launchctl: l.fn, health: async () => ++n > 1, sleep: noSleep, timeoutMs: 60_000 });
  assert.equal(r.ok, true);
  assert.deepEqual(l.calls[0], ["bootstrap", "gui/501", "/p.plist"]);
});

test("bootstrapAndVerify: an already-loaded label is booted out and bootstrap retried", async () => {
  const l = fakeLaunchctl({ bootstrap: [5, 0], print: [{ status: 0, stdout: PRINT_RUNNING }] });
  const r = await bootstrapAndVerify({ uid: 501, plistPath: "/p.plist", launchctl: l.fn, health: async () => true, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.deepEqual(l.calls.map((c) => c[0]), ["bootstrap", "bootout", "bootstrap", "print"]);
  assert.deepEqual(l.calls[1], ["bootout", "gui/501/browser-bridge"]);
});

test("bootstrapAndVerify: a persistent bootstrap failure is a clear error", async () => {
  const l = fakeLaunchctl({ bootstrap: [5, 5], print: [{ status: 0, stdout: "" }] });
  const r = await bootstrapAndVerify({ uid: 501, plistPath: "/p.plist", launchctl: l.fn, health: async () => true, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /bootstrap gui\/501 \/p.plist failed \(5\)/);
});

test("bootstrapAndVerify: plist written but job never loads -> explicit 'not loaded' error after the timeout", async () => {
  const l = fakeLaunchctl({ bootstrap: [0], print: [{ status: 113, stdout: "" }] });
  const r = await bootstrapAndVerify({ uid: 501, plistPath: "/p.plist", launchctl: l.fn, health: async () => false, sleep: async () => new Promise((res) => setTimeout(res, 5)), timeoutMs: 30, pollMs: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /not loaded/);
});

test("bootstrapAndVerify: loaded but crash-looping reports state and last exit code", async () => {
  const l = fakeLaunchctl({ bootstrap: [0], print: [{ status: 0, stdout: PRINT_WAITING }] });
  const r = await bootstrapAndVerify({ uid: 501, plistPath: "/p.plist", launchctl: l.fn, health: async () => false, sleep: async () => new Promise((res) => setTimeout(res, 5)), timeoutMs: 30, pollMs: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /loaded but not running \(state = not running, last exit code = 1\)/);
});
