# Watch mode self-test

The fold engine has unit tests (`cd server && npm test`). Everything below the fold — the content
script, the arming handshake, tab following, service-worker survival — needs a real Chrome and
**cannot run in CI**. This is the manual pass; an agent can execute it through the bridge itself.

Prerequisites: server running, extension loaded **and reloaded after a build** (`chrome://extensions`
→ reload), and `watch_status` returning without an error.

Each step lists what to do and what the timeline must show. A step that fails is a bug, not a flake.

---

## 1. Basic capture

```
tab_new({ url: "data:text/html,<h1>hi</h1><input id=q placeholder=Search><button id=go>Go</button>" })
watch_start({ tabId })
```
Click the input, type `hello world`, click **Go**. Then `watch_read({ since: cursor })`.

**Expect:** a `nav`, a `click <input#q>`, **one** `input` action with `value:"hello world"` and
`chars:11` (not eleven separate actions), and a `click <button#go> "Go"`.

## 2. The click that navigates in under 100ms

```html
data:text/html,<a id=x href="https://example.com">go</a>
```
Click the link immediately after load.

**Expect:** the `click <a#x>` is present, followed by the `nav`. This is the case the rrweb path
loses to its 300ms batching — if the click is missing, per-event flushing has regressed.

## 3. Shadow DOM

```html
data:text/html,<div id=h></div><script>
h.attachShadow({mode:'open'}).innerHTML='<button id=inner>Inner</button>'
</script>
```
Click **Inner**.

**Expect:** `click <button#inner> "Inner"` — *not* `<div#h>`. A host label here means
`composedPath()[0]` has regressed to `event.target`.

## 4. SPA navigation (requires `console:true`)

```
watch_start({ tabId, console: true })
```
On any page: `history.pushState({}, "", "/fake-route")`.

**Expect:** a `nav` action with `via:"spa"` within a second, with no reload. This is the case rrweb
cannot see at all until its next checkout.

## 5. Following a new tab

On a watched page, click a `target="_blank"` link.

**Expect:** a `tab added` action for the new tab id, and subsequent clicks in that tab appear in the
same timeline with `[tN]` prefixes. Then open a tab with **Cmd+T** — it must **not** join.

## 6. Service-worker death

Open `chrome://serviceworker-internals`, find the extension's worker, **Stop** it. Then click
something on the watched page.

**Expect:** the click still arrives. The page holds its buffer and re-arms on the next hello; nothing
is lost. (Before this design, the recorder became a permanent silent zombie here.)

## 7. Server restart

Restart the server while watching, then `watch_read` with the **old** cursor.

**Expect:** `reset: true` and a note that the cursor belongs to an earlier session — never a silent
renumbering. The extension's `hello` re-announce should rebind the tabs.

## 8. Network causality (`network:true`)

```
watch_start({ tabId, network: true })   // banner appears — expected
```
Submit a real form.

**Expect:** `submit` → `net POST … → 30x` carrying `← #<seq of the submit>`, and any follow-up page
requests attributed to the **nav**, not back to the submit.

## 9. Redaction

Type into an `<input type=password>`.

**Expect:** `value` renders as `•••• (N chars)` with `redacted:true` under the default. Repeat with
`watch_start({ redact: "none" })` and confirm the raw value comes through — the escape hatch must
actually work.

## 10. Blindness is visible

Quit Chrome (or disable the extension) while watching, wait ~15s, restore it.

**Expect:** `health.state:"blind"` while it is down, a `gap` action with
`reason:"extension-disconnected"` and a plausible `ms`, and a pending `watch_read({waitMs:25000})`
that returns **immediately** on disconnect rather than hanging for the full 25s.

## 11. HTTP endpoint parity

```bash
curl -s -H "Authorization: Bearer $(cat ~/.browser-bridge/token)" 'http://127.0.0.1:8765/watch?limit=20'
```

**Expect:** the same timeline the tool returns, and `401` without the header.

## 12. Soak

Watch real browsing for ~30 minutes.

**Expect:** `watch_status` shows a bounded ring, the service worker's memory does not climb, and the
digest at `~/.browser-bridge/watch/` stays well under a megabyte.
