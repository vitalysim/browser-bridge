#!/usr/bin/env node
// Build the extension with esbuild, single-sourcing the version from package.json:
//  - injects __BB_VERSION__ (used by background.ts's VERSION) via esbuild define
//  - keeps manifest.json's "version" in sync (Chrome reads that file directly)
// Run via `npm run build`.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const dir = dirname(fileURLToPath(import.meta.url));
const version = String(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version || "0.0.0");

// Keep manifest.json in lockstep so chrome://extensions shows the same number.
const manifestPath = join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.version !== version) {
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`synced manifest.json version → ${version}`);
}

await build({
  entryPoints: [join(dir, "src/background.ts"), join(dir, "src/options.ts")],
  bundle: true,
  format: "iife",
  outdir: dir,
  target: "chrome116",
  define: { __BB_VERSION__: JSON.stringify(version) },
});
console.log(`built extension v${version}`);
