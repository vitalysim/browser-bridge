# Browser Bridge

Control your **real, logged-in Chrome** from AI coding agents (Claude Code **and** OpenAI Codex CLI)
via a local MCP server. No headless browser, no fresh profile — the agent reads and drives the tabs
you're already signed into (Facebook, Gmail, …).

```
Claude Code ──(HTTP MCP)──┐
                          ├── bridge server (127.0.0.1:8765)
Codex CLI ───(HTTP MCP)───┘        │  WebSocket (extension dials out, token-authed)
                                   ▼
                     Chrome extension (in your real profile)
                                   │  default: chrome.tabs / chrome.scripting / captureVisibleTab
                                   │  opt-in:  chrome.debugger (CDP) for network capture,
                                   │           trusted input, closed shadow, reliable upload
                                   ▼
                     Your logged-in tabs
```

## Why this design

- **One HTTP MCP server, two clients.** Both Claude Code and Codex connect to the same
  `http://127.0.0.1:8765/mcp`. (Claude's own "Claude in Chrome" is Claude-only; Codex's own Chrome
  extension is desktop-app-only — neither gives Codex CLI a real browser. This does.)
- **Extension, not a remote-debug port.** Chrome 136+ blocks `--remote-debugging-port` on your default
  profile, so a raw CDP endpoint can't touch your real logins. A Manifest V3 extension runs *inside* your
  real profile and reuses its sessions. Default tools use banner-free extension APIs; the CDP power
  features attach `chrome.debugger` on demand (see **Debugger mode** below) — no open port, all consent-gated.
- **Outbound WebSocket, no native-messaging install.** The extension dials `ws://127.0.0.1:8765/ws`.
  No host-manifest files to install (the #1 setup headache of native-messaging bridges), and WS traffic
  keeps the MV3 service worker alive (a 20 s keepalive ping resets its idle timer).
- **Token-authed, localhost-only.** The server binds `127.0.0.1`, checks a bearer token on both the MCP
  endpoint and the WS handshake, and rejects any WS origin that isn't `chrome-extension://`.

## Layout

```
server/       TypeScript MCP server (@modelcontextprotocol/sdk + ws + express)
  src/index.ts   HTTP MCP endpoint + WS hub + auth + session mgmt
  src/hub.ts     single extension socket, request/response correlation, timeouts
  src/tools.ts   the 25 MCP tools
extension/    Manifest V3 Chrome extension (bundled with esbuild)
  manifest.json
  src/background.ts  service worker: WS client, reconnect, keepalive, command dispatch,
                     iframe/shadow injection, chrome.debugger (CDP) session layer
  src/options.ts     token + status UI
  options.html
```

## Tools

25 tools.

**Banner-free (default):** `tabs_list`, `tab_new`, `tab_activate`, `tab_close`, `navigate`, `go_back`,
`go_forward`, `get_page_text`, `snapshot`, `click`, `fill`, `hover`, `type`, `press_key`, `scroll`,
`screenshot`, `eval_js`, `wait_for`, `file_upload`, `bridge_status`.

**Debugger mode (`chrome.debugger`, shows the "started debugging this browser" banner):**
`net_capture_start`, `net_get_requests`, `net_get_body`, `debugger_detach`, `debugger_status` — plus
opt-in params on existing tools: `snapshot(deep:true)`, `click/hover/type(trusted:true)`,
`file_upload(path:…)`.

`get_page_text` is the workhorse for "summarize my feed". `snapshot` lists interactive elements with
numeric refs that `click`/`fill`/`hover`/`type` accept (or pass a CSS `selector`).

**Coverage (banner-free):** `get_page_text`, `snapshot`, and the interaction tools reach **into iframes**
(including cross-origin, via `executeScript` + `<all_urls>`) and **open shadow DOM**.

**Debugger mode** overcomes the remaining limits (auto-attaches on first use, auto-detaches after ~5 min
idle; the banner shows while attached and it conflicts with having real DevTools open on that tab):
- **Network capture** — `net_capture_start` then navigate/reload, then `net_get_requests`
  (`includeBodies:true`) / `net_get_body`: raw requests **and response bodies** (the only way; `webRequest`
  can't read response bodies).
- **Closed shadow roots** — `snapshot(deep:true)` pierces them; interact with those refs via
  `click/hover/type(trusted:true)`.
- **Trusted input** — `click/hover/type(trusted:true)` dispatch real `isTrusted` events (fires pure-CSS
  `:hover`, real keystroke timing).
- **Reliable upload** — `file_upload(path:"/abs/path")` uses `DOM.setFileInputFiles` (no size limit).

Remaining hard limits: none of the above works if you have DevTools open on the same tab (one debugger
per tab); `net_capture_start` only sees traffic *after* it's called (navigate/reload to capture a load).

## Setup

### 1. Build

```bash
cd server && npm install && npm run build
cd ../extension && npm install && npm run build   # produces background.js + options.js
```

### 2. Run the server

A macOS LaunchAgent is already installed at `~/Library/LaunchAgents/com.vitaly.browser-bridge.plist`
(runs at login, restarts on crash). Manage it with:

```bash
launchctl bootout    gui/$(id -u)/com.vitaly.browser-bridge   # stop
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/com.vitaly.browser-bridge.plist  # start
tail -f ~/.browser-bridge/server.log
curl -s http://127.0.0.1:8765/health
```

To run it by hand instead: `cd server && npm start`.

The server generates a token on first run and stores it in `~/.browser-bridge/token`. It's printed to
`~/.browser-bridge/server.log` on startup.

### 3. Load the extension into Chrome  *(the one manual step)*

1. Open `chrome://extensions`, enable **Developer mode** (top-right).
2. **Load unpacked** → select the `extension/` folder.
3. Click the extension's icon (or open its options) → paste the token from `~/.browser-bridge/token`
   → **Save & connect**. The status should turn green ("Connected to bridge server").

Verify: `curl -s http://127.0.0.1:8765/health` → `{"ok":true,"extensionConnected":true}`.

### 4. Client config (already done on this machine)

**Claude Code** (user scope):
```bash
claude mcp add --transport http --scope user browser-bridge \
  http://127.0.0.1:8765/mcp --header "Authorization: Bearer $(cat ~/.browser-bridge/token)"
```

**Codex CLI** — `~/.codex/config.toml`:
```toml
[mcp_servers.browser-bridge]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "BROWSER_BRIDGE_TOKEN"
```
The token is exported for Codex via a line added to `~/.zshrc`:
```bash
[ -f "$HOME/.browser-bridge/token" ] && export BROWSER_BRIDGE_TOKEN="$(cat "$HOME/.browser-bridge/token")"
```

Note: loading v0.3+ adds the `webNavigation` and `debugger` permissions. On reload Chrome may disable
the extension pending a permission prompt — just re-enable it at `chrome://extensions`.

## Usage

With Chrome open and logged in, in **Claude Code**:

> list my open browser tabs
> open facebook.com, read the feed, and summarize the top posts

Debugger-mode (shows the banner while attached):

> start a network capture on this tab, reload it, and show me the API responses
> take a deep snapshot and click the button inside the closed shadow root

In **Codex CLI** (new terminal so `BROWSER_BRIDGE_TOKEN` is set): the same prompts work — verified with
`codex exec "call the browser-bridge tabs_list tool and list my tabs"`, which reads the same real browser.

## Security notes

- The agent acts with **your real cookies**. Treat every tool call as running as you.
- **Prompt injection** is the real risk: a malicious post/page can carry hidden instructions the agent
  might follow using your session. v1 is read-mostly; keep the write-ish tools (`click`, `fill`,
  `eval_js`) behind your MCP client's permission prompts, and don't point it at pages you don't trust.
- The token is localhost defense-in-depth, not a secret worth guarding heavily. Rotate it by deleting
  `~/.browser-bridge/token` and restarting the server (then re-paste into the extension and re-run the
  `claude mcp add` command).
- **Debugger mode is powerful**: while attached it can read full request/response bodies (including auth
  headers and API payloads) and dispatch real trusted input. It auto-detaches after ~5 min idle, and the
  banner tells you when it's active. Use `debugger_detach` to end a session immediately.

## Limitations / roadmap

- Default interaction uses synthetic events (no banner); a few sites ignore untrusted events, so use
  `click/hover/type(trusted:true)` for real `isTrusted` input via `chrome.debugger` (shipped in v0.3).
- Debugger mode needs sole access to the tab's debugger — it **can't attach if you have DevTools open**
  on that tab (clear error surfaced). `net_capture_start` only sees traffic *after* it's called.
- The network capture buffer is in-memory (last 500 requests/tab, response bodies ~512 KB); the WS
  keepalive keeps the service worker warm during active capture, but a long idle can drop the buffer.
- MV3 service workers can still be evicted; the alarm + keepalive revive it, and the extension
  auto-reconnects. If it ever shows "disconnected", open the extension options and it reconnects.
- One extension connection at a time (last connect wins). Multiple MCP clients can share it concurrently.
- Closed shadow roots and full network bodies require the debugger banner — there is no banner-free way
  to reach them (Chrome limitation, not a design shortcut).
