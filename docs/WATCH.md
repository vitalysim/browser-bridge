# Watch mode → a live semantic timeline of your own browsing

Browser Bridge is normally **agent-driven**: the agent acts, the browser responds. Watch mode is the
inverse. **You** browse; the agent follows along and can answer questions about it at any moment.

```
watch_start({ tabId })                     → { watchId, cursor, tabId, banner:false }
   …you browse normally…
watch_read({ since: cursor })              → the timeline + the next cursor
watch_stop()                               → { stopped, actions, digestPath }
```

```
WATCH  live  tabs=5  actions=6  dropped=0  more=false
12:04:39.8  #411 click    <input#user_login> "Username or Email Address"
12:04:41.0  #412 input    <input#user_login> = "attacker"   (8 keys / 1.2s)
12:04:41.3  #413 key      ↵
12:04:41.4  #414 net      POST /wp-login.php → 302 (91ms)      ← #412
12:04:41.9  #415 console  error "Uncaught TypeError: x is undefined"  ← #414
12:04:55.0  #416 gap      extension-disconnected (14.2s)
{"nextCursor":"w1k9f3x.msq6k2s9:416","dropped":0,"more":false,"health":{"state":"live",…}}
```

## The tools

| Tool | Description |
|---|---|
| `watch_start` | Begin watching. `network:true` captures traffic (**attaches `chrome.debugger` → shows Chrome's debugging banner**) — see [Network capture](#network-capture); `console:true` folds in console errors (banner-free). `redact` controls masking of typed values; `include` picks which action kinds to record; `retain:"none"` keeps it in memory only |
| `watch_read` | Read the timeline. `since` is the cursor from the previous read — pass it back verbatim. `waitMs` (max 25000) blocks until something happens. `format:"json"` for structured actions. `file` reads a saved digest instead of the live session. Batchable (with `waitMs` forced to 0) |
| `watch_status` | Is watch mode running, on which tabs, and is capture actually live? No cursor, no actions |
| `watch_stop` | Stop, flush any in-progress typing burst, close the digest |

## What it captures

Navigations (including **SPA route changes**, instantly), clicks, typed text, special keystrokes,
form submits, copy/paste, tab open/close/focus — and optionally network requests and console errors.
Every element arrives **already labeled** with a usable selector:

```json
{ "kind": "click", "target": { "tag": "button", "id": "publish", "label": "Publish",
                               "selector": "button#publish" } }
```

That `selector` is the same shape `click` / `fill` accept, so "help me with the thing I just clicked"
is a one-step follow-up rather than a fresh `snapshot`.

**Causality.** Requests and errors are attributed to the action that caused them (`← #412`), and the
attribution **chains**: once a navigation is blamed on a click, the page load's requests attach to the
*navigation*, not back to the click. Otherwise one click on "Publish" collects eighty stylesheet
requests and the link stops meaning anything.

**Typing is coalesced.** Twenty keystrokes into one field become one action with the final value, a
character count, and a duration — finalized on blur, Enter, Tab, submit, a different field, or 1.5s of
quiet.

## Network capture

`watch_start({ network: true })` captures the human's traffic at three levels of detail:

1. **In the timeline** — method, URL, status, duration, attributed to the action that caused it. Filtered to Document/XHR/Fetch/WebSocket/EventSource plus anything ≥400 or failed, so a page load's images and CSS don't drown it.
2. **In the live buffer** — the full `net_get_requests` / `net_get_body` / `export_har` / `request_to_curl` / `replay_request` / `authz_matrix` toolset keeps working on the watched tab. Each timeline `net` action carries its `requestId` (visible with `format:"json"`), so you can jump straight from a line to its body.
3. **On disk, durably** — the complete traffic streams to `<digest>.net.<tabId>.jsonl`: request and response headers, request body, and **response bodies**.

That third level exists because of a Chrome limitation worth knowing: **a response body is evicted once its document is replaced.** Reading `net_get_body` after a form submit navigates away returns *"No resource with given identifier found"*. `networkBodies` (default `true`) fetches each body **eagerly at load-finish**, before it can be evicted — so the POST that navigated away still has its response on disk.

Followed tabs get their own capture and their own file, so a `target="_blank"` checkout or an OAuth popup isn't a hole in the record. Each carries the debugger banner.

Options: `networkBodies:false` for a lighter capture, `networkSavePath` to relocate the files.

**Other extensions' traffic is excluded.** Your installed extensions inject scripts, fonts and fetches into every page: one ordinary page load in testing produced 69 captured requests of which **3 were the user's** — the rest were Acrobat/Pocket bundles and base64 font blobs, which with `persistBodies` dominate the file. Watch mode drops non-http(s) requests. The plain `net_capture_start` tool keeps its old behavior and captures everything, with `excludeExtensionTraffic:true` available if you want the same filtering for a HAR export.

## Cursors, gaps, and blindness

The cursor is opaque — pass it back exactly as given. It is `<watchId>.<epoch>:<seq>`, and the epoch
identifies the server-side *incarnation*: the extension keeps its watch group across a server restart,
so the watchId alone stays stable while the seq counter restarts at 0. Without the epoch a pre-restart
cursor is accepted as current and points past the head — verified live, it returned **0 actions with
`dropped: 0` while browsing was actively happening**. With it, the stale cursor is reported as
`reset: true` and served from the start.

**A connected socket does not mean capture is alive.** When the extension is reloaded or updated it
comes back and reconnects, but it may no longer hold the watch — every page then disarms itself on the
hello handshake and nothing is captured. The extension re-announces its live watches on every connect,
and a session the browser does *not* announce is marked `blind` with a `watch-lost` gap and an explicit
"call `watch_start` again". This was found in testing: before the reconciliation existed, health
cheerfully reported `live` while capture was completely dead.

Four things are reported rather than hidden, because an agent that cannot tell silence from breakage
will confabulate activity to fill the gap:

- `dropped: N` — you fell behind the in-memory ring and missed N actions.
- `gap` **actions in the timeline** — `extension-disconnected`, `sw-restarted`, `watch-lost`,
  `ring-evicted`, `unscriptable`, `tab-closed`, with a duration.
- `health.state` — `live`, `blind`, or `stopped`. **`blind` means capture is down, not that you were
  idle.**

## Following you across tabs

Watch starts on one tab and automatically follows tabs that tab opens — `target="_blank"`,
middle-click, `window.open`, OAuth popups — via `openerTabId` and
`webNavigation.onCreatedNavigationTarget`. A tab you open yourself with Cmd+T deliberately does not
join. Prerender activation (which swaps the tab id) is handled, so a tab does not silently drop out
mid-session.

## Continuous awareness (the prompt hook)

MCP is pull-only and cannot wake an agent turn, so "continuous" via tool calls always means polling.
The server therefore also exposes the timeline over plain HTTP:

```bash
curl -s -H "Authorization: Bearer $(cat ~/.browser-bridge/token)" \
  'http://127.0.0.1:8765/watch?since=<cursor>'
```

Wire that into a Claude Code `UserPromptSubmit` hook and recent activity is prepended to every
message you send — no tool call, no approval prompt, no polling loop:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -H \"Authorization: Bearer $(cat ~/.browser-bridge/token)\" 'http://127.0.0.1:8765/watch?limit=40' || true"
          }
        ]
      }
    ]
  }
}
```

`watch_read({waitMs})` is the other half: it returns the instant something happens, which makes a
`/loop` tight. It is a latency smoother, not an event loop — a blocked agent cannot answer questions,
so keep `waitMs` modest and prefer the hook for genuine background awareness.

## How it works

A content script registered on `<all_urls>` (`chrome.scripting.registerContentScripts`,
`persistAcrossSessions: true`, `document_start`, all frames) captures events and labels them **in the
page**, where the DOM is. It is present everywhere by construction — surviving service-worker
eviction, browser restart and navigation with no injection race — and **scope is enforced by arming**:
the script buffers locally, asks the service worker whether its tab is in a watch group, and either
flushes or goes dormant. Buffering before the answer is what stops the first click on a newly-opened
tab from being lost.

**The page is the durable queue.** Events are held in the page until the service worker acks that they
reached the socket. A service-worker restart therefore costs nothing, and a dropped batch costs one
event rather than a corrupted index.

Watch groups live in `chrome.storage.local` — **not** `storage.session`, which Chrome wipes exactly
when the extension is reloaded, i.e. precisely when the group most needs to survive. On startup the
service worker rehydrates, drops tabs that are gone, expires groups older than 12 hours, and
**re-injects into the tabs still open** (registration alone only covers future document loads, so an
already-open page would otherwise stay dormant until it happened to navigate). Verified live: after an
extension reload, a click on an untouched page is captured with no page reload, with the downtime
recorded as `sw-restarted`.

The service worker forwards batches verbatim over the existing WebSocket (`{type:"watch"}`); the
server folds them in `server/src/watch.ts` — coalescing, causality, the ring, and the cursor.

### Error capture and the one intrusive option

`console: true` (the default while watching) captures **uncaught errors and unhandled rejections**
from the isolated world. It touches no page global and is invisible to the page.

`console: "calls"` additionally wraps `console.error/warn` in the **MAIN world** to catch explicit
calls. That is genuinely intrusive and it shows: every console call the page makes routes through our
function, so **this extension's file appears in the page's own stack traces** — and therefore in any
error telemetry the site ships. Observed in the wild on a pentest target, whose error reporter
recorded `vendor/bb-watch-main.js` as the top frame of one of its own errors, effectively logging that
the browser was instrumented. On a security-testing tool that is a real cost.

Prefer `console: true`. If you need explicit `console.*` calls, the CDP path (`console_start`, or
anything that already attached the debugger via `network:true`) captures them passively — it costs the
banner instead of a page-visible modification.

SPA routes need no page patching either: `webNavigation.onHistoryStateUpdated` in the service worker
reports them, which is what wins the race in practice anyway.

### Why not rrweb?

Browser Bridge already records with rrweb (see [RECORDING.md](RECORDING.md)), so deriving the timeline
from that stream was the obvious design. It was measured and rejected:

| | rrweb-derived | activity listener |
|---|---|---|
| 8-hour session | **~910 MB** (97% full DOM snapshots) | ~120 KB |
| Click labels | reconstructed from a node index | read from the DOM, exact |
| Node ids | **restart at 1 in every document** — one missed batch mislabels every later click | n/a |
| SPA routes | up to 30s stale, or never if you go idle | instant |
| Click that navigates in <300ms | **lost** (300ms batch, no `pagehide` flush) | captured |
| Selector for follow-up actions | none | yes |

The two are independent and compose: run `session_record_start` on the same tab whenever you also
want the visual replay or an MP4.

## Caveats

- **Values are captured in cleartext** unless redacted. `redact:"auto"` (the default) masks fields
  that are `type=password` or `autocomplete=current-password/new-password`, plus name/id matches for
  pass/secret/token/otp/cvv/ssn/card. `redact:"all"` masks every typed value; `redact:"none"` is raw.
  The timeline flows into the agent's context and transcript — choose accordingly.
- **`network:true` shows Chrome's debugging banner** for the whole session and cannot be banner-free
  (it needs `chrome.debugger`). Everything else in watch mode is banner-free.
- **Restricted pages are invisible.** Content scripts cannot run on `chrome://`, the Web Store,
  `view-source:`, or other extensions' pages. `watch_status` reports those tabs as `unscriptable`;
  treat them as blind, not idle.
- **Selectors on hash-heavy CSS frameworks** may not be re-queryable. Ids, names and roles are
  preferred; the fallback path is capped and best-effort.
- **The in-memory ring is bounded** (5000 actions / 4 MB). With the default `retain:"digest"` the full
  timeline is still on disk at `~/.browser-bridge/watch/`, readable with `watch_read({file})`.
- **Network requests are filtered** to Document/XHR/Fetch/WebSocket/EventSource plus anything ≥400 or
  failed, so a page load's images and stylesheets do not drown the timeline.
