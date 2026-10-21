#!/usr/bin/env node
// Remove every line that contains the Browser Bridge token from the server logs, in place.
//
//   node scripts/scrub-log.mjs [--dry-run] [--data-dir=<dir>]
//
// Older versions could leave the token in ~/.browser-bridge/server.log (launchd appended stderr there
// forever). This scrubs server.log, server.log.1…, and launchd.log for BOTH the current token and
// token.prev (if you already rotated). --dry-run prints only per-file line counts. Each file is
// rewritten to a new inode, so restart the server afterwards: a running server keeps appending to the
// replaced (now unlinked) server.log until it reopens it.
import { homedir } from "os";
import { join } from "path";
import { logFiles, readTokenFile, scrubFile } from "./lib/token-tools.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dataDir = (args.find((a) => a.startsWith("--data-dir=")) || "").split("=")[1] || join(homedir(), ".browser-bridge");

const secrets = [readTokenFile(join(dataDir, "token")), readTokenFile(join(dataDir, "token.prev"))].filter(Boolean);
if (process.env.BRIDGE_TOKEN && process.env.BRIDGE_TOKEN.trim().length >= 8) secrets.push(process.env.BRIDGE_TOKEN.trim());
if (!secrets.length) {
  console.error(`✗ no token found in ${dataDir}/token or token.prev - nothing to scrub for`);
  process.exit(1);
}

const files = logFiles(dataDir);
if (!files.length) {
  console.log(`No log files in ${dataDir}.`);
  process.exit(0);
}
console.log(`${dryRun ? "[dry-run] " : ""}Scrubbing ${secrets.length} token value(s) from ${files.length} log file(s) in ${dataDir}`);
let total = 0;
for (const f of files) {
  try {
    const r = await scrubFile(f, secrets, { dryRun });
    total += r.removed;
    console.log(`  ${f}: ${r.removed} of ${r.lines} line(s) ${dryRun ? "would be removed" : "removed"}`);
  } catch (e) {
    console.log(`! ${f}: ${e.message}`);
  }
}
console.log(total ? `${dryRun ? "Would remove" : "Removed"} ${total} line(s).` : "No lines contained the token.");
if (total && !dryRun) console.log("Restart the server so it reopens server.log (macOS: launchctl kickstart -k gui/$(id -u)/browser-bridge).");
