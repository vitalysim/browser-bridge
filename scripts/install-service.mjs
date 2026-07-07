#!/usr/bin/env node
// Cross-platform autostart installer for the Browser Bridge MCP server.
//   Linux  -> systemd user service (~/.config/systemd/user/browser-bridge.service)
//   macOS  -> launchd LaunchAgent   (~/Library/LaunchAgents/browser-bridge.plist)
//   other  -> prints manual instructions
//
// Flags: --dry-run (print the unit, don't install)   --platform=linux|darwin (force, for inspection)
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { homedir, userInfo } from "os";
import { join, resolve, dirname } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const forced = (args.find((a) => a.startsWith("--platform=")) || "").split("=")[1];
const platform = forced || process.platform;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "server");
const entry = join(serverDir, "dist", "index.js");
const node = process.execPath;
const LABEL = "browser-bridge";

function run(cmd, cmdArgs) {
  try {
    execFileSync(cmd, cmdArgs, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(entry) && !dryRun) {
  console.error(`✗ Server build not found at ${entry}\n  Run:  cd server && npm install && npm run build`);
  process.exit(1);
}

function installLinux() {
  const unit = `[Unit]
Description=Browser Bridge MCP server
Documentation=https://github.com/vitalysim/browser-bridge
After=network.target

[Service]
Type=simple
ExecStart=${node} ${entry}
WorkingDirectory=${serverDir}
Restart=on-failure
RestartSec=2
# Uncomment to change the port: Environment=BRIDGE_PORT=8765

[Install]
WantedBy=default.target
`;
  const dir = join(homedir(), ".config", "systemd", "user");
  const path = join(dir, `${LABEL}.service`);
  if (dryRun) {
    console.log(`# would write ${path}\n\n${unit}`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, unit);
  console.log(`✓ wrote ${path}`);
  run("systemctl", ["--user", "daemon-reload"]);
  const ok = run("systemctl", ["--user", "enable", "--now", `${LABEL}.service`]);
  console.log(ok ? `✓ enabled & started (systemctl --user)` : `! could not start via systemctl — is a user systemd session available?`);
  console.log(`\nNext:`);
  console.log(`  • start at boot without login:  loginctl enable-linger ${userInfo().username}`);
  console.log(`  • logs:                          journalctl --user -u ${LABEL} -f`);
  console.log(`  • status/health:                systemctl --user status ${LABEL}  |  curl -s http://127.0.0.1:8765/health`);
}

function installDarwin() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node}</string>
        <string>${entry}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${serverDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(homedir(), ".browser-bridge", "server.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(homedir(), ".browser-bridge", "server.log")}</string>
</dict>
</plist>
`;
  const path = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  if (dryRun) {
    console.log(`# would write ${path}\n\n${plist}`);
    return;
  }
  const uid = process.getuid ? process.getuid() : 0;
  const gui = `gui/${uid}`;
  // Clean migration: stop any previous hand-made service so it doesn't hold port 8765.
  for (const old of ["com.vitaly.browser-bridge", LABEL]) {
    run("launchctl", ["bootout", `${gui}/${old}`]);
    const oldPlist = join(homedir(), "Library", "LaunchAgents", `${old}.plist`);
    if (old === "com.vitaly.browser-bridge" && existsSync(oldPlist)) {
      console.log(`• migrated from old service ${old}`);
    }
  }
  writeFileSync(path, plist);
  console.log(`✓ wrote ${path}`);
  const ok = run("launchctl", ["bootstrap", gui, path]);
  console.log(ok ? `✓ loaded (launchctl)` : `! could not bootstrap — try: launchctl bootstrap ${gui} ${path}`);
  console.log(`\nNext:  logs -> ${join(homedir(), ".browser-bridge", "server.log")}   |   curl -s http://127.0.0.1:8765/health`);
}

console.log(`Browser Bridge service installer  (platform: ${platform})`);
console.log(`  node:  ${node}`);
console.log(`  entry: ${entry}\n`);

if (platform === "linux") installLinux();
else if (platform === "darwin") installDarwin();
else {
  console.log(`No autostart integration for '${platform}'. Run the server manually:`);
  console.log(`  cd ${serverDir} && npm start`);
  console.log(`(or register '${node} ${entry}' with your OS service manager.)`);
}
