#!/usr/bin/env node
// Remove the Browser Bridge autostart service for the current OS.
import { existsSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

const platform = (process.argv.find((a) => a.startsWith("--platform=")) || "").split("=")[1] || process.platform;
const LABEL = "browser-bridge";

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
  } catch {
    /* ignore */
  }
}

if (platform === "linux") {
  run("systemctl", ["--user", "disable", "--now", `${LABEL}.service`]);
  const path = join(homedir(), ".config", "systemd", "user", `${LABEL}.service`);
  if (existsSync(path)) {
    rmSync(path);
    console.log(`✓ removed ${path}`);
  }
  run("systemctl", ["--user", "daemon-reload"]);
} else if (platform === "darwin") {
  const uid = process.getuid ? process.getuid() : 0;
  for (const label of ["com.vitaly.browser-bridge", LABEL]) {
    run("launchctl", ["bootout", `gui/${uid}/${label}`]);
    const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    if (existsSync(path)) {
      rmSync(path);
      console.log(`✓ removed ${path}`);
    }
  }
} else {
  console.log(`Nothing to uninstall for '${platform}'.`);
}
console.log("Done. (The extension and ~/.browser-bridge/token are left in place.)");
