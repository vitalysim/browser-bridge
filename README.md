# 🌉 Browser Bridge

> **Drive your real, logged-in Chrome from an AI agent** — over the Model Context Protocol. No headless browser, no fresh profile, no re-login. Your agent reads and acts inside the exact sessions you're already signed into.

<p>
  <img alt="version"  src="https://img.shields.io/badge/version-0.7.0-4f46e5">
  <img alt="tools"    src="https://img.shields.io/badge/tools-55-7c3aed">
  <img alt="protocol" src="https://img.shields.io/badge/MCP-streamable_HTTP-7c3aed">
  <img alt="browser"  src="https://img.shields.io/badge/Chrome%2FEdge-Manifest_V3-2563eb">
  <img alt="lang"     src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="clients"  src="https://img.shields.io/badge/clients-Claude_Code_%2B_Codex-16a34a">
</p>

Browser Bridge is a local **MCP server + Manifest V3 Chrome extension** that lets AI coding agents — **Claude Code** and **OpenAI Codex CLI** — control the Chrome you use every day. Because it runs *inside* your real profile, the agent inherits your cookies, `HttpOnly` sessions, SSO, and 2FA state automatically. Ask it to *"read my feed and summarize it"* or *"capture the API traffic on this page and show me the responses"* — and it works against the live, authenticated app.

It ships **55 tools** spanning everyday browsing, DevTools-grade network capture, and a web-security testing toolkit (self-healing interaction, in-session request replay, **live request/response interception**, an **intruder-style fuzzer** (sniper/pitchfork/clusterbomb/race), access-control diffing, real-cookie-jar read/write, **CSP-bypassing page evaluation**, **passive header/CORS/secret analysis + JWT decode**, **copy-as-curl**, and **durable HAR/JSONL/MHTML** evidence export).

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

**Browse & interact** — open/close/switch/list tabs, navigate, back/forward, click, fill, hover, type, press keys, scroll, upload files, and **paste images** into rich-text editors (with a trusted-clipboard mode for strict editors). Interaction reaches **into iframes** (including cross-origin) and **open shadow DOM** out of the box.

**Read & inspect** — extract page text (the workhorse for summarizing), snapshot interactive elements with stable refs, screenshot (viewport by default, or **`fullPage`** for the entire scrollable page, **`scale:2`** for retina/high-DPI, `format`/`quality`, `selector` to clip an element, `savePath` to write a file), and evaluate JavaScript in the page — with `eval_js` **auto-falling back to CSP-immune CDP evaluation** (`cdp_eval`) on strict-CSP sites where in-page `eval` is blocked.

**Download resources** — `download_resource` saves a URL to disk via Chrome's own download engine (not the network-capture path), so it isn't bound by the 512 KB body cap: files up to 100MB by default, larger with `maxBytes`, streamed straight to disk with correct binary handling and the real session's cookies attached automatically. Banner-free.

**DevTools-grade network capture** — record requests with **full request/response bodies**, response headers, `Set-Cookie` (via CDP ExtraInfo), timings, and **WebSocket/SSE frames** — the things a `webRequest`-based extension fundamentally can't read.

**Trusted mode (opt-in, `chrome.debugger`)** — real `isTrusted` mouse/keyboard input (fires pure-CSS `:hover`, real keystroke timing), **closed** shadow-root access via `snapshot(deep:true)`, and reliable uploads via `DOM.setFileInputFiles`.

**Web-security testing** — snapshot named **identities** (cookies incl. `HttpOnly`, storage, bearer), an **in-session request replayer** (page-fetch or CDP-Fetch with full header/identity override), an **`authz_matrix`** that replays a request set across identities and diffs the responses to surface **BOLA / IDOR / BFLA** access-control breaks, **live request/response interception** (Burp-Proxy-style pause/modify/fulfill/block via CDP Fetch), and an **intruder-style `fuzz`** (payload iteration with anomaly flagging).

**Session, storage & evidence** — read/write the **real cookie jar** (incl. `HttpOnly`, with full flags) via `chrome.cookies`, dump/set/clear **localStorage & sessionStorage**, capture **console + CSP + uncaught-exception** logs, and save a page as a single-file **`.mhtml`** evidence snapshot.

---

## 📇 Tool reference (55)

<details open>
<summary><b>Browsing & interaction</b></summary>

| Tool | Description |
|---|---|
| `tabs_list` · `tab_new` · `tab_activate` · `tab_close` | Manage tabs. `tabs_list(short:true)` returns id/title/origin/active only (no path/query), for quickly identifying tabs without echoing full URLs |
| `navigate` · `go_back` · `go_forward` · `wait_for` | Navigation |
| `click` · `fill` · `hover` · `type` · `press_key` · `scroll` | Interaction (iframe + open-shadow aware). **Auto-waits** for the element to be actionable (found + visible + enabled, `timeoutMs`) and returns structured `{notActionable, reason}` on failure. `click` detects overlay-covered targets and **auto-escalates to a trusted CDP click** (`via:"trusted"`); `fill`/`type` register in React inputs (native setter) and rich editors (execCommand). `trusted:true` for real CDP input; `withSnapshot:true` to get a fresh `snapshot` back inline |
| `file_upload` | Set a file input via base64 or a local `path` (`DOM.setFileInputFiles`) |
| `paste_image` | Paste a local image into a rich-text / contenteditable field; `trusted:true` uses the real OS clipboard + a genuine Cmd/Ctrl+V for strict editors (e.g. YesWeHack) that ignore synthetic events |
</details>

<details open>
<summary><b>Read & inspect</b></summary>

| Tool | Description |
|---|---|
| `get_page_text` | Rendered text of the page (and its iframes) |
| `snapshot` | Interactive elements with refs (+ `enabled`/`inViewport` hints); `deep:true` pierces **closed** shadow roots. Refs are held in an **off-DOM registry**, so a snapshot no longer mutates the page (a ref whose element was since re-rendered is reported so the caller re-snapshots). Deep-snapshot refs are numbered in their own range per snapshot generation, so they can never be confused with a plain-snapshot ref or a stale one from an earlier deep snapshot |
| `screenshot` | Visible viewport (banner-free) by default; `fullPage` for the whole page, `scale` for retina, `format`/`quality`, `selector` to clip, `savePath` to write a file |
| `download_resource` | Download a URL to disk via Chrome's own download engine — up to 100MB by default (`maxBytes` to raise it), correct binary handling, real session cookies, banner-free; `savePath` to relocate it from the Downloads folder |
| `eval_js` | Evaluate JavaScript in the page's main world (banner-free). **Auto-falls back to `cdp_eval` on strict-CSP pages** where in-page `eval` is blocked (`via:"cdp-fallback"`); `cdp:true` forces it, `noFallback:true` disables it |
| `cdp_eval` | Evaluate JS in the page's real main-world context via CDP `Runtime.evaluate` — **not subject to CSP `unsafe-eval`**, so it runs on strict-CSP sites, and reaches the page's live JS (in-memory state, framework internals, closures, the app's own functions). Uses `chrome.debugger` (shows the banner) |
| `bridge_status` | Is the extension connected? |
</details>

<details open>
<summary><b>Network capture (chrome.debugger — shows the debugging banner)</b></summary>

| Tool | Description |
|---|---|
| `net_capture_start` | Begin capturing; then navigate/reload to record load traffic. `maxEntries` sizes the in-memory ring (default 500, max 5000); `persist:true` + `savePath` also **streams** each finished request/WS frame to a JSON-Lines file on disk (durable — survives the ring cap and, up to the last batch, a service-worker crash; `persistBodies:true` includes bodies) |
| `net_get_requests` | Requests with headers, `Set-Cookie`, timings, and (opt-in) response **bodies** |
| `net_get_body` | Fetch one response body on demand |
| `net_get_ws_frames` | Captured WebSocket / EventSource frames |
| `export_har` | Write the tab's captured traffic to a **HAR 1.2** file (import into Burp / DevTools / Playwright); bodies included by default |
| `debugger_detach` · `debugger_status` | End a session (banner off) / inspect sessions |
</details>

<details open>
<summary><b>Web-security testing</b></summary>

| Tool | Description |
|---|---|
| `identity_capture` · `identity_list` · `identity_purge` | Snapshot/manage named sessions (cookies incl. `HttpOnly`, storage, bearer) |
| `replay_request` | In-session Repeater — replay a captured or ad-hoc request; override any header or swap identity (`anon` strips auth). `viaAppClient:true` replays through the **page's own `fetch`** so app CSRF/auth interceptors apply |
| `authz_matrix` | Replay a request set across identities and diff → flags access-control breaks |
| `response_diff` | Structural diff of two responses (status, length, token-Jaccard, noise-suppressed) |
| `intercept_start` · `intercept_pending` · `intercept_resolve` · `intercept_stop` | Burp-Proxy-style live interception (CDP Fetch): pause matching requests/responses, then **continue** (optionally mutating url/method/headers/body), **fail** (block), or **fulfill/modify** (synthesize a response). `rules` auto-apply; otherwise requests queue for resolution |
| `fuzz` | Intruder-style fuzzer over a request template — modes **sniper** / **pitchfork** / **clusterbomb** (multi-marker `payloadSets`) / **race** (fire N together for race conditions). Per-request `status`/`length`/`timeMs` with anomalies flagged first |
| `analyze` | One-call **passive recon**: grades response security headers (CSP/HSTS/CORS/X-Frame/nosniff/leaks), cookie flags, and sweeps the body for exposed secrets/API-keys/JWTs → findings ranked by severity. `deep:true` also fetches same-origin external `<script src>` bundles and sweeps those |
| `jwt_decode` | Decode a JWT (header/payload, no verify); flags `alg:none`, HS/RS confusion, expiry |
| `request_to_curl` | Emit a ready-to-run **curl** command reproducing a captured request (real sent headers incl. `Cookie`, plus body) or an ad-hoc one — for handoff to a terminal / Burp workflow |
</details>

<details open>
<summary><b>Session, storage & evidence</b></summary>

| Tool | Description |
|---|---|
| `cookies_get` · `cookies_set` · `cookies_delete` | Read/write the real browser cookie jar via `chrome.cookies` — includes `HttpOnly`, with full flags (`secure`, `sameSite`, `expirationDate`) |
| `storage_dump` · `storage_set` · `storage_remove` · `storage_clear` | Read/write this origin's `localStorage` / `sessionStorage` |
| `console_start` · `console_get` · `console_stop` | Buffer console output, uncaught exceptions, and CSP/log violations (via CDP; CSP-independent). Filter `console_get` by regex `pattern` / `level` |
| `save_page` | Save the tab as a single self-contained `.mhtml` evidence snapshot |
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

> Reloading the extension after an update may prompt for new permissions (e.g. `webNavigation`, `debugger`, `downloads`) — re-enable it if Chrome disables it.

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

- Interaction auto-waits for actionability and, on `click`, auto-escalates to a trusted CDP click when the target is overlay-covered (`via:"trusted"`, shows the banner); force it anytime with `trusted:true`. A covered/hidden/disabled target returns a structured `{notActionable, reason}`.
- A strict page **CSP** (`script-src` without `'unsafe-eval'`) blocks the banner-free `eval_js`; it auto-falls back to `cdp_eval` (CDP `Runtime.evaluate`, banner shown), which CSP cannot block. The isolated-world read/interact tools and all CDP/background tools are unaffected by CSP either way.
- `chrome.debugger` requires sole access to a tab — it **can't attach if DevTools is open** on that tab. `net_capture_start` only records traffic sent *after* it's called (navigate/reload to capture a page load).
- The capture buffer is in-memory (a ring of `maxEntries` requests/tab, default 500, ~512 KB/body). An active capture is no longer torn down by the idle sweep; for a durable record beyond the ring cap use `net_capture_start(persist:true, savePath:…)`, which streams to disk. Persistence is **durability, not continuity** — if the service worker dies the debugger detaches and capture stops until restarted; the file holds what was captured before that.
- One extension connection at a time (last connect wins); multiple MCP clients can share it concurrently. A call in flight when the extension disconnects now fails fast instead of waiting out the timeout.
- `download_resource` always uses the browser's live session — it can't download as a captured `identity`. `Cookie`/`Host`/`Origin`/`Referer`/`Content-Length` in its `headers` param are browser-forbidden and silently ignored. If Chrome's "Ask where to save each file" setting is enabled, downloads may prompt for a location instead of completing automatically.

---

## 🗺️ Roadmap

Shipped in v0.7: **durable capture persistence** (`net_capture_start(persist)` streams to on-disk JSON-Lines, `maxEntries` sizes the ring), **copy-as-curl** (`request_to_curl`), **`analyze deep`** (same-origin external-JS secret sweep), plus reliability fixes (fail-fast on disconnect, no idle-detach of active captures, fast load-wait, off-DOM snapshot refs, single-sourced versioning). v0.6: **self-healing interaction**, **passive recon** (`analyze`) + **`jwt_decode`**, **HAR export**, **fuzz modes** + **`viaAppClient`** replay. v0.5 shipped interception, fuzzing, cookie/storage, console/CSP capture, and MHTML.

Ideas explored for future phases: source-map de-minification on downloads, GraphQL introspection helpers, a client-side DOM-XSS / postMessage / prototype-pollution suite, and hunt-workflow playbooks with structured findings.

---

## 🏗️ Project structure

```
server/                 MCP server (TypeScript · @modelcontextprotocol/sdk · ws · express)
  src/index.ts            HTTP MCP endpoint + auth + session management
  src/hub.ts              single extension socket, request/response correlation, capture sinks
  src/capture-sink.ts     durable on-disk JSON-Lines sink for persist captures
  src/tools.ts            the 55 MCP tools
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
