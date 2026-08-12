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

// Vendored rrweb recorder — a standalone IIFE injected into pages via executeScript({files}) by
// session_record_start. Kept out of the service-worker bundle; rrweb is bundled in.
await build({
  entryPoints: [join(dir, "src/rrweb-record-entry.ts")],
  bundle: true,
  format: "iife",
  outfile: join(dir, "vendor/rrweb-record.js"),
  target: "chrome116",
  legalComments: "none",
});
console.log("built vendor/rrweb-record.js");

// Watch-mode content scripts — standalone IIFEs registered via chrome.scripting.registerContentScripts
// by watch_start (not injected per-navigation), so they must not import anything from the SW bundle.
// bb-watch.js runs in the ISOLATED world (it needs chrome.runtime); bb-watch-main.js runs in the MAIN
// world (it patches the page's own console and history).
for (const name of ["watch-entry", "watch-main"]) {
  await build({
    entryPoints: [join(dir, `src/${name}.ts`)],
    bundle: true,
    format: "iife",
    outfile: join(dir, `vendor/bb-${name.replace("-entry", "")}.js`),
    target: "chrome116",
    legalComments: "none",
  });
  console.log(`built vendor/bb-${name.replace("-entry", "")}.js`);
}
