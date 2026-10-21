#!/usr/bin/env node
// Rotate the Browser Bridge token.
//
//   node scripts/rotate-token.mjs [--dry-run] [--update-claude-configs] [--data-dir=<dir>]
//
// - writes a new random token to ~/.browser-bridge/token (0600, atomic), keeping the current one as
//   ~/.browser-bridge/token.prev (0600) for rollback (`mv token.prev token`);
// - --update-claude-configs: also rewrites literal `"Authorization": "Bearer <old>"` headers of
//   browser-bridge MCP entries in ~/.claude.json and ~/.claude-shadow/.claude.json (a .bak copy of
//   each changed file is written first). Entries that use an env var (e.g. ${BROWSER_BRIDGE_TOKEN})
//   are reported, not changed;
// - --dry-run: report what would change; writes nothing.
// Token values are never printed.
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { newToken, readTokenFile, rotateTokenFile, updateClaudeConfigFile } from "./lib/token-tools.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const updateConfigs = args.includes("--update-claude-configs");
const dataDir = (args.find((a) => a.startsWith("--data-dir=")) || "").split("=")[1] || join(homedir(), ".browser-bridge");
const tokenFile = join(dataDir, "token");
const configFiles = [join(homedir(), ".claude.json"), join(homedir(), ".claude-shadow", ".claude.json")];

if (process.env.BRIDGE_TOKEN) {
  console.warn("! BRIDGE_TOKEN is set in this environment; a server started with it ignores the token file.");
}

const oldToken = readTokenFile(tokenFile);
console.log(`${dryRun ? "[dry-run] " : ""}Rotating the Browser Bridge token in ${tokenFile}`);
console.log(`  current token: ${oldToken ? "present" : existsSync(tokenFile) ? "EMPTY" : "missing"}`);

let token = null;
if (dryRun) {
  console.log(`  would write a new token to ${tokenFile} (0600)` + (oldToken ? ` and keep the current one as ${tokenFile}.prev` : ""));
} else {
  token = newToken();
  rotateTokenFile(dataDir, token);
  console.log(`✓ wrote a new token to ${tokenFile} (0600)` + (oldToken ? `; previous token saved to ${tokenFile}.prev (0600)` : ""));
}

if (updateConfigs) {
  if (!oldToken) console.log("  (no previous token, so there are no literal Bearer headers to match)");
  for (const f of configFiles) {
    const r = updateClaudeConfigFile(f, oldToken, token, { dryRun });
    if (!r.exists) continue;
    if (r.error) {
      console.log(`! ${f}: ${r.error}`);
      continue;
    }
    if (r.changed.length) {
      console.log(`${dryRun ? "  would update" : "✓ updated"} ${r.changed.length} header(s) in ${f}${r.backup ? ` (backup: ${r.backup})` : ""}:`);
      for (const c of r.changed) console.log(`    - ${c}`);
    } else console.log(`  ${f}: no literal browser-bridge Bearer header with the current token`);
    for (const e of r.envBased) console.log(`  · ${e} - not changed; open a new shell after updating the variable`);
  }
}

console.log(`
Next steps${dryRun ? " (after a real run)" : ""}:
  1. Paste the new token into the extension: Browser Bridge icon -> options -> Server token -> Save.
     Print it with:  cat ${tokenFile}
  2. Restart the server so it loads the new token:
       macOS:  launchctl kickstart -k gui/$(id -u)/browser-bridge
       Linux:  systemctl --user restart browser-bridge
  3. MCP clients: ${updateConfigs ? "the Claude configs above were updated; restart running Claude Code sessions." : "re-run with --update-claude-configs, or update the Authorization header in your MCP client configs (.mcp.json, ~/.codex/config.toml, opencode.json)."}
     If you export BROWSER_BRIDGE_TOKEN (or BRIDGE_TOKEN) from your shell profile, update it and open a new shell.
  Roll back:  mv ${tokenFile}.prev ${tokenFile}  (then restart the server)
  Old log lines may still contain the previous token: node scripts/scrub-log.mjs --dry-run`);
