# browser-bridge e2e harness

Drives the **real** MCP server and the **real** MV3 extension end-to-end, in a fully isolated sandbox:

```
node:test scenarios ──MCP (streamable HTTP, Bearer)──▶ server/dist/index.js ──WS──▶ extension (temp copy)
                                                                                      in Playwright Chromium
                                                                                      ──▶ fixture pages (local HTTP)
```

## Run

```bash
cd e2e
npm install          # playwright-core 1.64.1 (uses cached chromium-1248), MCP SDK, tsx
npm test             # builds server + extension, then runs every scenario
npm run test:nobuild # same, using the existing server/dist + extension/background.js
```

Prerequisites: Node 20+, and Playwright's Chromium build **1248** in `~/Library/Caches/ms-playwright`
(`npx playwright-core install chromium` if it's missing). `npm test` runs `npm ci` in `server/` and
`extension/` if their `node_modules` are missing, then `npm run build` in both.

Recording/export scenarios also require **ffmpeg and ffprobe** on PATH (`brew install ffmpeg` on macOS,
`sudo apt-get install ffmpeg` on Ubuntu). CI installs them explicitly. Its raw Chromium fixture uses the
same Linux sandbox/shared-memory launch flags as Playwright; this only affects the isolated test browser.

Environment knobs:

| var | effect |
|---|---|
| `E2E_SKIP_BUILD=1` | skip the server/extension build (fails fast if outputs are missing) |
| `E2E_HEADED=1` | launch a visible Chromium window instead of new-headless |
| `E2E_CALL_TIMEOUT_MS` | default per-tool-call timeout (20000) |

Output: node:test's spec report, then a summary table (scenario, result, ms, reason). Every tool call
each scenario made (args, duration, trimmed output) is written to `e2e/.artifacts/results.json`; the
bridge server's log goes to `e2e/.artifacts/server.log`. Both are git-ignored.

## What it isolates

- **Bridge server**: spawned from `server/dist/index.js` on a free random port (never 8765) with a
  random `BRIDGE_TOKEN` and `HOME` pointed at a temp dir, so its `~/.browser-bridge` writes (token,
  playbooks, recordings) land in the temp dir. It never touches the real bridge or its files.
- **Browser**: Playwright's bundled Chromium via `launchPersistentContext` with a temp user-data-dir
  and `--disable-extensions-except/--load-extension` pointing at a temp **copy** of the built
  extension. The extension is configured by writing `chrome.storage.local {token, port}` from its
  service worker; setup waits for `/health` to report `extensionConnected: true`.
- **Fixtures**: `fixtures/*.html` served by an in-process HTTP server on a random port. `/hang`
  sends headers and part of a body and never finishes (for the slow-iframe scenario).
- **Teardown** (runs on failure too, plus `exit`/`SIGINT` hooks): MCP session terminated, browser
  closed (then `pkill -f --user-data-dir=<our temp profile>` as a fallback), server SIGTERM then
  SIGKILL, fixture sockets destroyed, temp dir removed.

JS dialogs: real Chrome never auto-dismisses `alert/confirm`, but Playwright does when no one
listens. The harness listens on the context and leaves dialogs open, so the browser behaves like the
user's real one; scenarios answer them explicitly.

## Timeouts

Each tool call has its own timeout (default 20s, some scenarios use 12-15s and record the hang
rather than throw). Each scenario also has a node:test timeout (90-120s). A hang is reported as a
failure with its duration, never a stuck run.

## Scenarios

Each asserts the **desired** behaviour; several fail on the current code by design. See
[BASELINE.md](BASELINE.md) for the results against main and why.

`hidden-tab-raf-commit` needs a tab that is really hidden (`visibilityState:'hidden'`, no rAF). Playwright
enables `Emulation.setFocusEmulationEnabled` on every page it controls, which keeps background tabs
visible and rendering, so that scenario starts a second `Harness({ rawBrowser: true })`: the same
Chromium build spawned directly with `--remote-debugging-pipe`, configured through a one-off CDP session
to the extension's service worker only (no page is attached), with its own bridge server
(`server-raw.log`). `harness.rawCdp` stays available for measurements. No dialog tracking in that mode.

Known Linux limitation: focus emulation can leave frames throttled, delaying trusted actions and
rAF commits despite `keptAlive:true`. `hidden-tab-raf-commit` retains its timing and commit assertions
to expose this issue. Recording capture, canvas replay and MP4 export are covered independently.

`trusted-click-sanity` is a harness self-check: it proves the `chrome.debugger` (CDP) path works in
this Playwright-launched Chromium, so failures involving trusted escalation are product failures.
