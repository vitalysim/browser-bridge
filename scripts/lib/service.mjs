// Pure / injectable pieces of the service installer, so they can be unit-tested without touching
// launchctl, systemctl or the real home directory (server/test/installer.test.ts).
import { realpathSync, existsSync } from "fs";
import { join } from "path";

export const LABEL = "browser-bridge";
export const LEGACY_LABELS = ["com.vitaly.browser-bridge"];

/** Escape a value for an XML text node / plist <string>. */
export function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

/**
 * Quote one systemd ExecStart/WorkingDirectory word. systemd splits on whitespace and interprets
 * backslash escapes and "$"/"%" specifiers inside double quotes, so a path with a space (or one of
 * those) must be quoted and escaped. A plain path is left as is.
 */
export function systemdQuote(s) {
  s = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) && !s.includes("%")) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$").replace(/%/g, "%%") + '"';
}

/** Environment the LaunchAgent passes to the server. */
export function serviceEnv({ port } = {}) {
  const env = {
    // launchd sends stderr to launchd.log, which nobody rotates. The server writes (and rotates) its
    // own server.log, so don't duplicate every line into launchd.log - it then only ever holds
    // output from before the logger exists (an import-time crash, a fatal Node error).
    BRIDGE_LOG_STDERR: "0",
  };
  if (port && String(port) !== "8765") env.BRIDGE_PORT = String(port);
  return env;
}

export function buildPlist({ label = LABEL, node, entry, serverDir, dataDir, env = serviceEnv() }) {
  const e = xmlEscape;
  const launchdLog = join(dataDir, "launchd.log");
  const envXml = Object.entries(env)
    .map(([k, v]) => `        <key>${e(k)}</key>\n        <string>${e(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${e(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${e(node)}</string>
        <string>${e(entry)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${e(serverDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <!-- The server writes its own size-rotated log (server.log, .1..3). launchd.log only catches output
         from before the logger starts, and the server trims it at startup if it ever grows past 1 MB. -->
    <key>StandardOutPath</key>
    <string>${e(launchdLog)}</string>
    <key>StandardErrorPath</key>
    <string>${e(launchdLog)}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit({ node, entry, serverDir, env = {} }) {
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=Browser Bridge MCP server
Documentation=https://github.com/vitalysim/browser-bridge
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(node)} ${systemdQuote(entry)}
WorkingDirectory=${systemdQuote(serverDir)}
Restart=on-failure
RestartSec=2
UMask=0077
${envLines ? envLines + "\n" : ""}# Uncomment to change the port: Environment=BRIDGE_PORT=8765

[Install]
WantedBy=default.target
`;
}

// Paths that change on every upgrade of the Node install that owns them.
const VERSIONED_NODE = [/\/Cellar\/node(@\d+)?\/[^/]+\//, /\/\.nvm\/versions\/node\//, /\/fnm\/node-versions\//, /\/\.volta\/tools\/image\/node\//, /\/n\/versions\/node\//, /\/\.asdf\/installs\/nodejs\//, /\/mise\/installs\/node\//];

export function isVersionedNodePath(p) {
  return VERSIONED_NODE.some((re) => re.test(p));
}

/**
 * Pick the node binary path to pin in the service definition. process.execPath is the RESOLVED path
 * (e.g. /opt/homebrew/Cellar/node/24.3.0/bin/node), which disappears on the next `brew upgrade` and
 * leaves the LaunchAgent pointing at nothing. Prefer a stable symlink that resolves to the SAME binary.
 *
 * @returns {{ path: string, warning: string | null, source: string }}
 */
export function pickNodePath({
  execPath,
  whichNode = null,
  candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"],
  realpath = (p) => realpathSync(p),
  exists = (p) => existsSync(p),
}) {
  if (!isVersionedNodePath(execPath)) return { path: execPath, warning: null, source: "execPath" };
  let target;
  try {
    target = realpath(execPath);
  } catch {
    target = execPath;
  }
  const seen = new Set();
  for (const c of [whichNode, ...candidates]) {
    if (!c || seen.has(c) || c === execPath) continue;
    seen.add(c);
    if (isVersionedNodePath(c)) continue; // `which node` under nvm is just as version-specific
    try {
      if (exists(c) && realpath(c) === target) return { path: c, warning: null, source: c === whichNode ? "which" : "symlink" };
    } catch {
      /* dangling symlink */
    }
  }
  return {
    path: execPath,
    source: "execPath",
    warning:
      `pinning a version-specific node path (${execPath}); the service will stop starting after this Node ` +
      `install is upgraded/removed. Re-run the installer after upgrading Node, or install with a node whose ` +
      `stable symlink (e.g. /opt/homebrew/bin/node) points at the same binary.`,
  };
}

/** Parse `launchctl print gui/<uid>/<label>` output. */
export function parseLaunchctlPrint(out) {
  const text = String(out ?? "");
  const state = /^\s*state = (.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const pid = Number(/^\s*pid = (\d+)/m.exec(text)?.[1] ?? NaN);
  const lastExit = /^\s*last exit code = (.+)$/m.exec(text)?.[1]?.trim() ?? null;
  return { loaded: text.trim().length > 0, state, running: state === "running", pid: Number.isFinite(pid) ? pid : null, lastExit };
}

/**
 * Load the LaunchAgent and VERIFY it: loaded, running, and answering /health. All side effects are
 * injected (`launchctl(args) -> {status, stdout, stderr}`, `health() -> Promise<boolean>`, `sleep`).
 *
 * If bootstrap fails (typically "5: Input/output error" / "already loaded" because a previous
 * instance is still registered), the label is booted out and bootstrap is retried once.
 *
 * @returns {Promise<{ ok: boolean, steps: string[], error?: string, print?: string }>}
 */
export async function bootstrapAndVerify({ uid, label = LABEL, plistPath, launchctl, health, sleep, timeoutMs = 10_000, pollMs = 500 }) {
  const gui = `gui/${uid}`;
  const steps = [];
  let r = launchctl(["bootstrap", gui, plistPath]);
  if (r.status !== 0) {
    steps.push(`bootstrap failed (${r.status}): ${String(r.stderr || r.stdout).trim()} - booting out and retrying`);
    launchctl(["bootout", `${gui}/${label}`]);
    await sleep(1_000);
    r = launchctl(["bootstrap", gui, plistPath]);
    if (r.status !== 0) {
      return {
        ok: false,
        steps,
        error:
          `launchctl bootstrap ${gui} ${plistPath} failed (${r.status}): ${String(r.stderr || r.stdout).trim()}\n` +
          `  Try:  launchctl bootout ${gui}/${label}; launchctl bootstrap ${gui} ${plistPath}\n` +
          `  Check the plist:  plutil -lint ${plistPath}`,
      };
    }
  }
  steps.push("bootstrapped");
  const deadline = Date.now() + timeoutMs;
  let last = { loaded: false, running: false, state: null, pid: null, lastExit: null };
  let lastPrint = "";
  for (;;) {
    const p = launchctl(["print", `${gui}/${label}`]);
    lastPrint = String(p.stdout ?? "");
    last = p.status === 0 ? parseLaunchctlPrint(lastPrint) : { ...last, loaded: false };
    if (last.running && (await health())) {
      steps.push(`running (pid ${last.pid ?? "?"}) and /health answers`);
      return { ok: true, steps };
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  const why = !last.loaded
    ? `the job is not loaded (launchctl print ${gui}/${label} found nothing)`
    : !last.running
      ? `the job is loaded but not running (state = ${last.state ?? "?"}${last.lastExit ? `, last exit code = ${last.lastExit}` : ""})`
      : `the job is running (pid ${last.pid ?? "?"}) but /health did not answer`;
  return { ok: false, steps, error: `${why} within ${Math.round(timeoutMs / 1000)}s`, print: lastPrint };
}
