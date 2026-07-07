# 🌉 Browser Bridge

> **Drive your real, logged-in Chrome from an AI agent** — over the Model Context Protocol. No headless browser, no fresh profile, no re-login. Your agent reads and acts inside the exact sessions you're already signed into.

<p>
  <img alt="version"  src="https://img.shields.io/badge/version-0.4.6-4f46e5">
  <img alt="tools"    src="https://img.shields.io/badge/tools-32-7c3aed">
  <img alt="protocol" src="https://img.shields.io/badge/MCP-streamable_HTTP-7c3aed">
  <img alt="browser"  src="https://img.shields.io/badge/Chrome%2FEdge-Manifest_V3-2563eb">
  <img alt="lang"     src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="clients"  src="https://img.shields.io/badge/clients-Claude_Code_%2B_Codex-16a34a">
</p>

Browser Bridge is a local **MCP server + Manifest V3 Chrome extension** that lets AI coding agents — **Claude Code** and **OpenAI Codex CLI** — control the Chrome you use every day. Because it runs *inside* your real profile, the agent inherits your cookies, `HttpOnly` sessions, SSO, and 2FA state automatically. Ask it to *"read my feed and summarize it"* or *"capture the API traffic on this page and show me the responses"* — and it works against the live, authenticated app.

It ships **32 tools** spanning everyday browsing, DevTools-grade network capture, and a web-security testing toolkit (in-session request replay + access-control diffing).

---

## ✨ Why Browser Bridge?

| | Browser Bridge | Headless Playwright / Puppeteer | A raw CDP debug port |
|---|:---:|:---:|:---:|
| Uses your **real logged-in profile** | ✅ | ❌ (fresh profile, re-login) | ⚠️ blocked on default profile since Chrome 136 |
| Works from **Claude Code *and* Codex** | ✅ | — | — |
| **No open debug port** on your session | ✅ (outbound WS) | n/a | ❌ any local process can hijack it |
| **DevTools-grade** capture (bodies, WS) | ✅ | partial | ✅ |
| One-command install, **no native host** | ✅ | ✅ | ✅ |

- **One server, two clients.** Both agents connect to the same token-authed endpoint `http://127.0.0.1:8765/mcp`. Anthropic's *Claude in Chrome* is Claude-only and OpenAI's Codex browser extension is desktop-app-only — neither gives the Codex **CLI** a real browser. Browser Bridge does.
- **Extension, not a debug port.** Chrome 136+ blocks `--remote-debugging-port` on your default profile. A Manifest V3 extension runs *inside* that profile instead — banner-free by default, with `chrome.debugger` (CDP) power features attached only on demand.
- **Outbound WebSocket, no native-messaging host.** The extension dials `ws://127.0.0.1:8765/ws`; there are no host-manifest files to install (the usual native-messaging headache), and the WS keepalive keeps the MV3 service worker alive.
- **Localhost-only + token auth.** The server binds `127.0.0.1`, checks a bearer token on both the MCP endpoint and the WS handshake, and rejects any WS origin that isn't `chrome-extension://`.

---

## 🧭 Architecture

```
   Claude Code ─┐                                   ┌───────────────────────────────┐
                │  streamable-HTTP MCP  ┌──────────► │  Bridge server (Node/TS)      │
                ├──────────────────────►│  :8765/mcp │  • MCP tools + auth           │
   Codex CLI  ──┘                       └──────────► │  • WS hub (req/resp correlate)│
                                                     └───────────────┬───────────────┘
                                    outbound WebSocket, token-authed  │  ws://127.0.0.1:8765/ws
                                                     ┌───────────────▼───────────────┐
                                                     │  Chrome extension (MV3)        │
                                                     │  default: chrome.tabs /        │
                                                     │           scripting / capture  │
                                                     │  opt-in:  chrome.debugger (CDP)│
                                                     │           Network · Fetch · DOM│
                                                     └───────────────┬───────────────┘
                                                                     ▼
                                              Your real, logged-in tabs (Gmail, GitHub, …)
```

---

## 🧰 What it can do

**Browse & interact** — open/close/switch/list tabs, navigate, back/forward, click, fill, hover, type, press keys, scroll, and upload files. Interaction reaches **into iframes** (including cross-origin) and **open shadow DOM** out of the box.

**Read & inspect** — extract page text (the workhorse for summarizing), snapshot interactive elements with stable refs, screenshot (viewport by default, or **`fullPage`** for the entire scrollable page, **`scale:2`** for retina/high-DPI, `format`/`quality`, `selector` to clip an element, `savePath` to write a file), and evaluate JavaScript in the page.

**DevTools-grade network capture** — record requests with **full request/response bodies**, response headers, `Set-Cookie` (via CDP ExtraInfo), timings, and **WebSocket/SSE frames** — the things a `webRequest`-based extension fundamentally can't read.

**Trusted mode (opt-in, `chrome.debugger`)** — real `isTrusted` mouse/keyboard input (fires pure-CSS `:hover`, real keystroke timing), **closed** shadow-root access via `snapshot(deep:true)`, and reliable uploads via `DOM.setFileInputFiles`.

**Web-security testing** — snapshot named **identities** (cookies incl. `HttpOnly`, storage, bearer), an **in-session request replayer** (page-fetch or CDP-Fetch with full header/identity override), and an **`authz_matrix`** that replays a request set across identities and diffs the responses to surface **BOLA / IDOR / BFLA** access-control breaks.

---

## 📇 Tool reference (32)

<details open>
<summary><b>Browsing & interaction</b></summary>

| Tool | Description |
|---|---|
| `tabs_list` · `tab_new` · `tab_activate` · `tab_close` | Manage tabs |
| `navigate` · `go_back` · `go_forward` · `wait_for` | Navigation |
| `click` · `fill` · `hover` · `type` · `press_key` · `scroll` | Interaction (iframe + open-shadow aware; `trusted:true` for real CDP input) |
| `file_upload` | Set a file input via base64 or a local `path` (`DOM.setFileInputFiles`) |
</details>

<details open>
<summary><b>Read & inspect</b></summary>

| Tool | Description |
|---|---|
| `get_page_text` | Rendered text of the page (and its iframes) |
| `snapshot` | Interactive elements with refs; `deep:true` pierces **closed** shadow roots. Deep-snapshot refs are numbered in their own range per snapshot generation, so they can never be confused with a plain-snapshot ref or a stale one from an earlier deep snapshot |
| `screenshot` | Visible viewport (banner-free) by default; `fullPage` for the whole page, `scale` for retina, `format`/`quality`, `selector` to clip, `savePath` to write a file |
| `eval_js` | Evaluate JavaScript in the page's main world |
| `bridge_status` | Is the extension connected? |
</details>

<details open>
<summary><b>Network capture (chrome.debugger — shows the debugging banner)</b></summary>

| Tool | Description |
|---|---|
| `net_capture_start` | Begin capturing; then navigate/reload to record load traffic |
| `net_get_requests` | Requests with headers, `Set-Cookie`, timings, and (opt-in) response **bodies** |
| `net_get_body` | Fetch one response body on demand |
| `net_get_ws_frames` | Captured WebSocket / EventSource frames |
| `debugger_detach` · `debugger_status` | End a session (banner off) / inspect sessions |
</details>

<details open>
<summary><b>Web-security testing</b></summary>

| Tool | Description |
|---|---|
| `identity_capture` · `identity_list` · `identity_purge` | Snapshot/manage named sessions (cookies incl. `HttpOnly`, storage, bearer) |
| `replay_request` | In-session Repeater — replay a captured or ad-hoc request; override any header or swap identity (`anon` strips auth) |
| `authz_matrix` | Replay a request set across identities and diff → flags access-control breaks |
| `response_diff` | Structural diff of two responses (status, length, token-Jaccard, noise-suppressed) |
</details>

---

## 🚀 Getting started

### Prerequisites
- **Node.js 18+** and **Chrome, Chromium, or Edge** — on **Linux, macOS, or Windows** (Chromium-based; not Brave/Arc, not WSL)
- **Claude Code ≥ 2.0.73** and/or **OpenAI Codex CLI**

### 1 · Build

```bash
git clone https://github.com/vitalysim/browser-bridge.git
cd browser-bridge
( cd server    && npm install && npm run build )   # MCP server
( cd extension && npm install && npm run build )    # bundles background.js + options.js
```

### 2 · Run the server

The server generates a random bearer token on first run and stores it at `~/.browser-bridge/token` (also
printed on startup). Pick one:

**Autostart (recommended)** — one command installs a background service for your OS (**systemd** user
service on Linux, **launchd** LaunchAgent on macOS):

```bash
cd server && npm run install-service     # runs at login, restarts on crash
# Linux: to start at boot without an active login:  loginctl enable-linger "$USER"
# remove later with:  npm run uninstall-service
```

**Manual** — just run it in a terminal:

```bash
cd server && npm start        # or: nohup node dist/index.js >~/.browser-bridge/server.log 2>&1 &
```

Verify: `curl -s http://127.0.0.1:8765/health` → `{"ok":true,"extensionConnected":false}` (becomes `true`
once the extension is loaded). Logs: Linux `journalctl --user -u browser-bridge -f`; macOS/manual
`tail -f ~/.browser-bridge/server.log`.

### 3 · Load the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open the extension's popup/options → paste the token from `~/.browser-bridge/token` → **Save & connect**. The status turns green.

Verify: `curl -s http://127.0.0.1:8765/health` → `{"ok":true,"extensionConnected":true}`.

> Reloading the extension after an update may prompt for new permissions (e.g. `webNavigation`, `debugger`) — re-enable it if Chrome disables it.

### 4 · Connect your agent

**Claude Code**
```bash
claude mcp add --transport http --scope user browser-bridge \
  http://127.0.0.1:8765/mcp --header "Authorization: Bearer $(cat ~/.browser-bridge/token)"
```

**Codex CLI** — `~/.codex/config.toml`
```toml
[mcp_servers.browser-bridge]
url = "http://127.0.0.1:8765/mcp"
bearer_token_env_var = "BROWSER_BRIDGE_TOKEN"
```
Export the token for Codex (e.g. add to your shell profile):
```bash
export BROWSER_BRIDGE_TOKEN="$(cat "$HOME/.browser-bridge/token")"
```

---

## 💡 Usage

With Chrome open and logged in, just ask your agent in natural language:

```text
# Everyday
list my open tabs
open github.com, read my notifications, and summarize them

# Screenshots
take a full-page retina screenshot of this page and save it to ~/Downloads/page.png

# Network capture
start a network capture on this tab, reload it, and show me the JSON API responses

# Web-security (authorized targets only)
capture identity "A" for app.example.com, then log in as B and capture "B";
replay the invoices request as A, B and anon and show me the authz_matrix
```

Both Claude Code and Codex drive the same live browser through the same endpoint.

### Screenshots

`screenshot` defaults to a banner-free capture of the visible viewport. Options (these use
`chrome.debugger`, so they show the debugging banner):

| Want | Call |
|---|---|
| Entire scrollable page | `screenshot(fullPage: true)` |
| Retina / high-DPI (dimensions = CSS × scale) | `screenshot(fullPage: true, scale: 2)` |
| Smaller file | `screenshot(format: "jpeg", quality: 85)` |
| Just one element | `screenshot(selector: "#invoice")` |
| Write to disk (best for large full pages) | `screenshot(fullPage: true, savePath: "/abs/path.png")` |

`savePath` returns `{ path, bytes, width, height }` instead of a multi-MB inline image. Limits: capture
maxes out at Chrome's ~16384px surface size (a very tall page at `scale:2` errors clearly), and an
oversized PNG auto-falls back to JPEG.

### Platform support

| OS | Server | Extension | Autostart |
|---|:---:|:---:|---|
| **Linux** | ✅ | ✅ | systemd user service (`npm run install-service`) |
| **macOS** | ✅ | ✅ | launchd LaunchAgent (`npm run install-service`) |
| **Windows** | ✅ | ✅ | manual (`npm start`); register with your service manager |

---

## 🔒 Security & responsible use

- **The agent acts with your real cookies.** Treat every tool call as running as *you*.
- **Prompt injection is the ambient risk.** Pages the agent reads are untrusted input; a malicious page can try to steer it. Keep write-capable tools behind your MCP client's permission prompts and don't point it at pages you don't trust.
- **Debugger mode is powerful.** While attached it can read full request/response bodies (including auth headers) and dispatch trusted input. It shows Chrome's *"started debugging this browser"* banner, auto-detaches after ~5 min idle, and can be ended immediately with `debugger_detach`.
- **The security-testing tools are raw offensive primitives with no built-in scope guard — by design.** Like Burp Suite Repeater/Intruder/Autorize, staying within an authorized engagement's scope is the **operator's responsibility**. Only point Browser Bridge at systems you are authorized to test.
- **No secrets in the repo.** The bearer token lives in `~/.browser-bridge/` (gitignored); binding is localhost-only.

---

## ⚠️ Limitations

- Default interaction uses synthetic events (no banner); a few sites ignore untrusted input — use `trusted:true` for real events.
- `chrome.debugger` requires sole access to a tab — it **can't attach if DevTools is open** on that tab. `net_capture_start` only records traffic sent *after* it's called (navigate/reload to capture a page load).
- The capture buffer is in-memory (last 500 requests/tab, ~512 KB/body); a long idle can drop it.
- One extension connection at a time (last connect wins); multiple MCP clients can share it concurrently.

---

## 🗺️ Roadmap

Ideas explored for future phases: HAR / curl / Burp export, passive header/CORS/CSP/secret scanners, CDP-Fetch live interception rules, parameter fuzzing, JWT/GraphQL/race-condition helpers, a client-side DOM-XSS / postMessage / prototype-pollution suite, and hunt-workflow playbooks with structured findings.

---

## 🏗️ Project structure

```
server/                 MCP server (TypeScript · @modelcontextprotocol/sdk · ws · express)
  src/index.ts            HTTP MCP endpoint + auth + session management
  src/hub.ts              single extension socket, request/response correlation
  src/tools.ts            the 32 MCP tools
extension/              Manifest V3 extension (bundled with esbuild)
  manifest.json
  src/background.ts       service worker: WS client, injection, chrome.debugger (CDP) layer
  src/options.ts          token + connection UI
  icons/                  generated app icons
scripts/                install-service.mjs / uninstall-service.mjs (systemd or launchd)
```

---

## 📄 Disclaimer

Browser Bridge is provided for **authorized** automation, research, and security testing only. You are responsible for complying with the terms of service of the sites you automate and with the scope of any security engagement. The authors accept no liability for misuse.
