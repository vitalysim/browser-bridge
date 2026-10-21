#!/usr/bin/env node
// Cross-platform autostart installer for the Browser Bridge MCP server.
//   Linux  -> systemd user service (~/.config/systemd/user/browser-bridge.service)
//   macOS  -> launchd LaunchAgent   (~/Library/LaunchAgents/browser-bridge.plist)
//   other  -> prints manual instructions
//
// Flags: --dry-run (print the unit, don't install)   --platform=linux|darwin (force, for inspection)
//
// Logging: the server writes and rotates its own ~/.browser-bridge/server.log (10 MB x 3). The
// LaunchAgent's stdout/stderr go to ~/.browser-bridge/launchd.log, which only receives output from
// before the server's logger starts (crashes at import time, fatal Node errors) - see lib/service.mjs.
import { writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from "fs";
import { homedir, userInfo } from "os";
import { join, resolve, dirname } from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { LABEL, LEGACY_LABELS, buildPlist, buildSystemdUnit, pickNodePath, serviceEnv, bootstrapAndVerify } from "./lib/service.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const forced = (args.find((a) => a.startsWith("--platform=")) || "").split("=")[1];
const platform = forced || process.platform;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "server");
const entry = join(serverDir, "dist", "index.js");
const dataDir = join(homedir(), ".browser-bridge");
const port = Number(process.env.BRIDGE_PORT || 8765);

function whichNode() {
  try {
    return execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const picked = pickNodePath({ execPath: process.execPath, whichNode: whichNode() });
const node = picked.path;

function run(cmd, cmdArgs) {
  try {
    execFileSync(cmd, cmdArgs, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

function launchctl(cmdArgs) {
  const r = spawnSync("launchctl", cmdArgs, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
}

async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
    const j = await r.json();
    return j?.ok === true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDataDir() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

if (!existsSync(entry) && !dryRun) {
  console.error(`✗ Server build not found at ${entry}\n  Run:  cd server && npm install && npm run build`);
  process.exit(1);
}

function installLinux() {
  const unit = buildSystemdUnit({ node, entry, serverDir, env: port !== 8765 ? { BRIDGE_PORT: String(port) } : {} });
  const dir = join(homedir(), ".config", "systemd", "user");
  const path = join(dir, `${LABEL}.service`);
  if (dryRun) {
    console.log(`# would write ${path}\n\n${unit}`);
    return;
  }
  ensureDataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, unit);
  console.log(`✓ wrote ${path}`);
  run("systemctl", ["--user", "daemon-reload"]);
  const ok = run("systemctl", ["--user", "enable", "--now", `${LABEL}.service`]);
  console.log(ok ? `✓ enabled & started (systemctl --user)` : `! could not start via systemctl - is a user systemd session available?`);
  console.log(`\nNext:`);
  console.log(`  • start at boot without login:  loginctl enable-linger ${userInfo().username}`);
  console.log(`  • logs:                          ${join(dataDir, "server.log")}  (or journalctl --user -u ${LABEL} -f)`);
  console.log(`  • status/health:                systemctl --user status ${LABEL}  |  curl -s http://127.0.0.1:${port}/health`);
}

async function installDarwin() {
  const plist = buildPlist({ node, entry, serverDir, dataDir, env: serviceEnv({ port }) });
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  const path = join(agentsDir, `${LABEL}.plist`);
  if (dryRun) {
    console.log(`# would write ${path}\n\n${plist}`);
    return;
  }
  const uid = process.getuid ? process.getuid() : 0;
  const gui = `gui/${uid}`;
  ensureDataDir();
  mkdirSync(agentsDir, { recursive: true });
  // Clean migration: stop any previous instance (and the legacy hand-made service) so it doesn't hold
  // the port, then remove the legacy plist so it can't come back at the next login.
  for (const old of [...LEGACY_LABELS, LABEL]) {
    launchctl(["bootout", `${gui}/${old}`]);
    const oldPlist = join(agentsDir, `${old}.plist`);
    if (old !== LABEL && existsSync(oldPlist)) {
      rmSync(oldPlist);
      console.log(`• migrated from old service ${old} (removed ${oldPlist})`);
    }
  }
  writeFileSync(path, plist);
  console.log(`✓ wrote ${path}`);
  const result = await bootstrapAndVerify({ uid, plistPath: path, launchctl, health, sleep });
  for (const s of result.steps) console.log(`  · ${s}`);
  if (!result.ok) {
    console.error(`✗ the service did not come up: ${result.error}`);
    if (result.print) console.error(`\n--- launchctl print ${gui}/${LABEL} ---\n${result.print.split("\n").slice(0, 40).join("\n")}`);
    console.error(`\n  Crash output (before the server's logger starts): ${join(dataDir, "launchd.log")}`);
    console.error(`  Server log:                                       ${join(dataDir, "server.log")}`);
    console.error(`  Run it by hand to see the error:                  ${node} ${entry}`);
    process.exit(1);
  }
  console.log(`✓ loaded, running, and answering http://127.0.0.1:${port}/health`);
  console.log(`\nNext:  logs -> ${join(dataDir, "server.log")} (rotated)   |   curl -s http://127.0.0.1:${port}/health`);
}

console.log(`Browser Bridge service installer  (platform: ${platform})`);
console.log(`  node:  ${node}${picked.source !== "execPath" ? `  (stable path; resolves to ${process.execPath})` : ""}`);
console.log(`  entry: ${entry}\n`);
if (picked.warning) console.warn(`! ${picked.warning}\n`);

if (platform === "linux") installLinux();
else if (platform === "darwin") await installDarwin();
else {
  console.log(`No autostart integration for '${platform}'. Run the server manually:`);
  console.log(`  cd ${serverDir} && npm start`);
  console.log(`(or register '${node} ${entry}' with your OS service manager.)`);
}
