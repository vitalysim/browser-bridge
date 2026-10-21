// Data-home hardening: owner-only permissions, token loading, size-rotated logging, opt-in retention.
// Everything runs against a temp dir - never the real ~/.browser-bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, chmodSync, existsSync, readFileSync, utimesSync, readdirSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureDataDirs, tightenPermissions, dataDir } from "../src/datadir.js";
import { loadToken, TokenError } from "../src/token.js";
import { RotatingFile, initFileLog, closeFileLog, setStderrLogging, log, trimLaunchdLog } from "../src/log.js";
import { pruneOld, parseRetentionDays } from "../src/retention.js";
import { CaptureSink } from "../src/capture-sink.js";

const mode = (p: string) => statSync(p).mode & 0o777;
const tmp = () => mkdtempSync(join(tmpdir(), "bb-ops-"));

test("ensureDataDirs creates the home + subdirs 0700", () => {
  const home = tmp();
  const dir = dataDir(home);
  ensureDataDirs(dir);
  for (const d of [dir, join(dir, "playbooks"), join(dir, "recordings"), join(dir, "watch")]) assert.equal(mode(d), 0o700, d);
  rmSync(home, { recursive: true, force: true });
});

test("tightenPermissions fixes loose dirs/files in known subdirs, leaves other trees and symlinks alone", async () => {
  const home = tmp();
  const dir = dataDir(home);
  mkdirSync(join(dir, "recordings", "frames"), { recursive: true });
  mkdirSync(join(dir, "repo"), { recursive: true });
  writeFileSync(join(dir, "token"), "x");
  writeFileSync(join(dir, "server.log"), "x");
  writeFileSync(join(dir, "recordings", "a.html"), "x");
  writeFileSync(join(dir, "recordings", "frames", "f1.png"), "x");
  writeFileSync(join(dir, "repo", "README.md"), "x");
  const outside = join(home, "outside.txt");
  writeFileSync(outside, "x");
  chmodSync(outside, 0o644);
  symlinkSync(outside, join(dir, "recordings", "link"));
  for (const p of [dir, join(dir, "recordings"), join(dir, "recordings", "frames"), join(dir, "repo")]) chmodSync(p, 0o755);
  for (const p of ["token", "server.log", "recordings/a.html", "recordings/frames/f1.png", "repo/README.md"]) chmodSync(join(dir, p), 0o644);

  const r = await tightenPermissions(dir);
  assert.equal(r.errors, 0);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, "recordings")), 0o700);
  assert.equal(mode(join(dir, "recordings", "frames")), 0o700);
  assert.equal(mode(join(dir, "token")), 0o600);
  assert.equal(mode(join(dir, "server.log")), 0o600);
  assert.equal(mode(join(dir, "recordings", "a.html")), 0o600);
  assert.equal(mode(join(dir, "recordings", "frames", "f1.png")), 0o600);
  // Not ours: untouched.
  assert.equal(mode(join(dir, "repo")), 0o755);
  assert.equal(mode(join(dir, "repo", "README.md")), 0o644);
  assert.equal(mode(outside), 0o644, "a symlink target is never chmodded");
  rmSync(home, { recursive: true, force: true });
});

test("tightenPermissions on a missing dir is a no-op, never throws", async () => {
  const r = await tightenPermissions(join(tmp(), "nope"));
  assert.deepEqual(r, { dirs: 0, files: 0, errors: 0 });
});

test("CaptureSink creates its file 0600", async () => {
  const home = tmp();
  const p = join(home, "c.jsonl");
  const s = new CaptureSink(p);
  s.close();
  await s.drain();
  assert.equal(mode(p), 0o600);
  rmSync(home, { recursive: true, force: true });
});

test("loadToken: generates a 0600 token on first run, reads it back after", () => {
  const dir = join(tmp(), ".browser-bridge");
  const t = loadToken({ dir, env: {} });
  assert.match(t, /^[0-9a-f]{32}$/);
  assert.equal(mode(join(dir, "token")), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.equal(loadToken({ dir, env: {} }), t);
});

test("loadToken: refuses an empty / whitespace / short token file and an empty BRIDGE_TOKEN", () => {
  const dir = tmp();
  writeFileSync(join(dir, "token"), "  \n");
  assert.throws(() => loadToken({ dir, env: {} }), TokenError);
  writeFileSync(join(dir, "token"), "short\n");
  assert.throws(() => loadToken({ dir, env: {} }), TokenError);
  assert.throws(() => loadToken({ dir, env: { BRIDGE_TOKEN: "   " } }), /empty/);
  assert.equal(loadToken({ dir, env: { BRIDGE_TOKEN: " abcdefghijklmnopqrstuvwxyz " } }), "abcdefghijklmnopqrstuvwxyz");
  // The error message never echoes the (bad) value.
  writeFileSync(join(dir, "token"), "secretsecret\n");
  try {
    loadToken({ dir, env: {} });
  } catch (e: any) {
    assert.ok(!String(e.message).includes("secretsecret"));
  }
});

test("RotatingFile rotates by size, keeps N files, all 0600", () => {
  const dir = tmp();
  const p = join(dir, "server.log");
  const f = new RotatingFile(p, { maxBytes: 1024, keep: 3 });
  const line = "x".repeat(99); // 100 bytes with the newline
  for (let i = 0; i < 100; i++) f.write(line);
  f.close();
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, ["server.log", "server.log.1", "server.log.2", "server.log.3"]);
  for (const n of names) {
    assert.ok(statSync(join(dir, n)).size <= 1024, `${n} within the cap`);
    assert.equal(mode(join(dir, n)), 0o600);
  }
});

test("RotatingFile appends to an existing file, tightening its mode, and rotates it when already full", () => {
  const dir = tmp();
  const p = join(dir, "server.log");
  writeFileSync(p, "y".repeat(2000));
  chmodSync(p, 0o644);
  const f = new RotatingFile(p, { maxBytes: 1024, keep: 2 });
  f.write("hello");
  f.close();
  assert.equal(readFileSync(p, "utf8"), "hello\n");
  assert.equal(readFileSync(p + ".1", "utf8").length, 2000);
  assert.equal(mode(p + ".1"), 0o600, "the pre-existing file was tightened on open, before it rotated");
  assert.equal(mode(p), 0o600);
});

test("log() mirrors into the file sink; stderr can be switched off", () => {
  const dir = tmp();
  const p = join(dir, "server.log");
  initFileLog(p, { maxBytes: 1 << 20 });
  setStderrLogging(false);
  try {
    log("[test] one line");
  } finally {
    setStderrLogging(true);
    closeFileLog();
  }
  assert.match(readFileSync(p, "utf8"), /^\d{4}-\d\d-\d\dT.*Z \[test\] one line\n$/);
});

test("trimLaunchdLog keeps only the tail of an oversized launchd.log", () => {
  const dir = tmp();
  const p = join(dir, "launchd.log");
  writeFileSync(p, "a".repeat(5000) + "LAST-CRASH");
  assert.equal(trimLaunchdLog(p, 1000, 100), true);
  const s = readFileSync(p, "utf8");
  assert.ok(s.length < 200);
  assert.ok(s.endsWith("LAST-CRASH"));
  assert.equal(trimLaunchdLog(p, 1000, 100), false, "small file left alone");
  assert.equal(trimLaunchdLog(join(dir, "missing.log")), false);
});

test("parseRetentionDays: off unless a positive number", () => {
  assert.equal(parseRetentionDays(undefined), null);
  assert.equal(parseRetentionDays(""), null);
  assert.equal(parseRetentionDays("0"), null);
  assert.equal(parseRetentionDays("-3"), null);
  assert.equal(parseRetentionDays("abc"), null);
  assert.equal(parseRetentionDays("30"), 30);
  assert.equal(parseRetentionDays("0.5"), 0.5);
});

test("pruneOld removes only old items in recordings/ and watch/", async () => {
  const dir = tmp();
  const now = Date.now();
  const old = (now - 40 * 86400_000) / 1000;
  for (const sub of ["recordings", "watch", "playbooks"]) mkdirSync(join(dir, sub), { recursive: true });
  const files = {
    oldRec: join(dir, "recordings", "old.html"),
    newRec: join(dir, "recordings", "new.html"),
    oldWatch: join(dir, "watch", "w.jsonl"),
    oldPlaybook: join(dir, "playbooks", "p.md"),
    oldLog: join(dir, "server.log"),
  };
  for (const p of Object.values(files)) writeFileSync(p, "data");
  const oldFrames = join(dir, "recordings", "frames-1");
  mkdirSync(oldFrames);
  writeFileSync(join(oldFrames, "f.png"), "x");
  for (const p of [files.oldRec, files.oldWatch, files.oldPlaybook, files.oldLog, join(oldFrames, "f.png"), oldFrames]) utimesSync(p, old, old);

  const r = await pruneOld(dir, 30, now);
  assert.equal(r.errors, 0);
  assert.equal(existsSync(files.oldRec), false);
  assert.equal(existsSync(files.oldWatch), false);
  assert.equal(existsSync(oldFrames), false);
  assert.equal(existsSync(files.newRec), true);
  assert.equal(existsSync(files.oldPlaybook), true, "playbooks are never pruned");
  assert.equal(existsSync(files.oldLog), true, "top-level files are never pruned");
  assert.equal(r.removed.length, 3);
});

test("pruneOld with retention off (days<=0) or missing dirs deletes nothing", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "recordings"));
  const p = join(dir, "recordings", "x");
  writeFileSync(p, "x");
  utimesSync(p, 0, 0);
  assert.equal((await pruneOld(dir, 0)).removed.length, 0);
  assert.equal(existsSync(p), true);
  assert.equal((await pruneOld(join(dir, "nope"), 1)).removed.length, 0);
});
