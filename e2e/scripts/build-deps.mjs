#!/usr/bin/env node
// Build the server (tsc -> server/dist) and the extension (esbuild -> extension/background.js etc.)
// so the e2e run always exercises the code in this checkout. Installs each package's dependencies
// first if they are missing. Set E2E_SKIP_BUILD=1 to use whatever build outputs already exist.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cwd, args) {
  console.log(`[e2e] (${cwd.replace(repo + "/", "")}) npm ${args.join(" ")}`);
  execFileSync(npm, args, { cwd, stdio: "inherit" });
}

const outputs = {
  server: join(repo, "server", "dist", "index.js"),
  extension: join(repo, "extension", "background.js"),
};

if (process.env.E2E_SKIP_BUILD === "1") {
  for (const [name, file] of Object.entries(outputs)) {
    if (!existsSync(file)) {
      console.error(`[e2e] E2E_SKIP_BUILD=1 but ${name} build output is missing: ${file}`);
      process.exit(1);
    }
  }
  console.log("[e2e] E2E_SKIP_BUILD=1 - using existing server/dist and extension build outputs");
  process.exit(0);
}

for (const pkg of ["server", "extension"]) {
  const dir = join(repo, pkg);
  if (!existsSync(join(dir, "node_modules"))) run(dir, ["ci", "--no-audit", "--no-fund"]);
  run(dir, ["run", "build"]);
}
