# Playbooks

A **playbook** is a saved, replayable recipe for a repetitive browser task. The first time you do a task
(delete a post, file a bug, run a BOLA check), the agent pays an expensive "understanding" cost — snapshotting,
finding the right controls, trial and error. A playbook captures that resolved knowledge so the next run is cheap.

**A playbook is a self-healing document, not a macro.** It records *intent + robust locators + checkpoints +
the hard-won understanding* — **not** raw clicks, coordinates, snapshot refs, or captured requestIds (those are
ephemeral and break on the next run). An agent executes it **with judgment**: it re-perceives the page each step,
re-resolves the target from a stable descriptor, verifies before acting, and re-derives a step that has drifted.
That LLM-in-the-loop is the whole advantage over a brittle record-replay macro.

## Where playbooks live

- **Global** (default, cross-project): `~/.browser-bridge/playbooks/<slug>.md`
- **Project-local** (git-shareable): `./playbooks/<slug>.md`

An agent checks project-local first, then the global home. Discover with a glob over `**/playbooks/*.md`; reference
a playbook by slug or natural language ("run my gmail-triage playbook"). Name files kebab-case `verb-noun.md`.

## File format

One Markdown file per playbook: **YAML frontmatter = the machine-readable contract**, **Markdown body = the steps
and prose the agent interprets**. Markdown is chosen over pure JSON/YAML because the most valuable, expensive asset
here is *prose understanding*, both the author and the reader are an LLM, and it degrades gracefully — which is
exactly the self-healing posture. JSON would invite brittle literal replay.

### Frontmatter

```yaml
---
id: linkedin-delete-post           # slug == filename
name: Delete one of my LinkedIn posts
goal: Remove a specific post I authored.
site: ["https://www.linkedin.com/*"]   # URL globs this playbook applies to
version: 1
last_verified: 2026-07-23              # bump when you re-verify / heal locators
verified_against: "www.linkedin.com desktop web, en-US, 2026-07 layout"
destructive: true                      # irreversible user-visible change → per-step confirm
reversible: false
tags: [social, moderation, dom]
tools: [navigate, snapshot, get_page_text, hover, click, wait_for]   # optional allowlist
params:
  post_text:
    desc: A distinctive substring of the post to delete (used to locate the right card).
    example: "our seed round"
    required: true
    # secret: true   ← set on any param carrying a credential; the VALUE is never stored, only this description
preconditions:
  - Logged in as the account that AUTHORED the post (delete only appears on own posts).
success: The post card is gone AND get_page_text no longer contains {{post_text}}.
---
```

**Hard rules:** never write secrets, passwords, tokens, cookies, bearers, snapshot `ref`s, or capture `requestId`s
into a playbook. Identities are referenced by *name* only (they live in server memory via `identity_capture`).
Sensitive inputs are `secret: true` params supplied at run time.

### Step schema

Each step is a `## Step N — <title>` heading + a small YAML block + optional prose:

- **`intent`** — plain language: what this accomplishes and *why*. This is the anchor a healer re-derives from.
- **`locator`** — the primary target descriptor. Prefer **role + accessible-name**, because that's exactly what
  `snapshot` returns and can cheaply re-resolve:
  - `role:` button | link | menuitem | tab | textbox | dialog | …
  - `name:` the visible text / aria-label, as `equals` / `contains` / `matches: /regex/i`
  - `within:` a scoping context ("the post card whose text contains `{{post_text}}`") — **mandatory** to
    disambiguate destructive actions.
- **`fallbacks`** — ordered, tried only if the primary yields no unambiguous match:
  1. an alternate accessible-name / aria-label,
  2. a CSS `selector` anchored on role/attribute/text (never a generated hash class),
  3. a `cdp_eval` expression (shadow/closed-root/framework-state cases),
  4. a screenshot + `input(x,y)` coordinate — last resort, canvas only.
- **`action`** — the concrete tool call: `tool:` + args, with `{{param}}` interpolation and any required flags
  (`trusted:true`, `deep:true`, `withSnapshot:true`, `viaAppClient:true`).
- **`checkpoint`** — a *positive* postcondition proving the step worked: `text_present` / `text_absent` (via
  `get_page_text`), `snapshot_has` / `snapshot_lacks` (role + name), `selector_appears` (via `wait_for`), or
  `response` (status / shape, for API steps). Add `on_fail:` guidance.
- **`notes` / understanding** — the expensive facts: body-level portals, hover-only mounts, iframes, shadow DOM,
  a second same-worded confirm button, a CSP page that forced `cdp_eval`, a trusted-escalation, and — for API
  flows — **the ephemeral-requestId re-resolve rule**.

The **resolve loop** for every DOM step: fresh `snapshot` → match `role` + `name` (scoped by `within`) to a
*current* ref → verify it matches intent → act → check the `checkpoint`. Refs are never stored; the descriptor is.

## Capturing a playbook (distill, don't dump)

When you save a task, produce the artifact above — **not** a raw tool-call log:

1. **Keep the winning path only.** Drop exploration, retries, and read-only reconnaissance that didn't change state.
2. **Translate each ephemeral ref you clicked into a stable descriptor.** Look up that ref's snapshot entry
   (`role`, `label`, `href`) and record a `locator` from the most stable signal — prefer aria-label / stable text
   over `innerText` embedding counts/timestamps/usernames; prefer `role` + `within` scope over position.
3. **Generalize concrete values into params** (the post text, the order id, the target origin).
4. **Write checkpoints from what actually changed** (a toast, an element appearing/disappearing, an HTTP status).
5. **Harvest the understanding** — anything that cost trial and error becomes a `notes` entry.
6. **Record the flags you needed** (`trusted:true`, `deep:true`, `viaAppClient:true`) so the next run doesn't rediscover them.
7. **Set metadata honestly** (`destructive`, `last_verified`, `preconditions`).
8. **Never persist secrets or ephemeral handles.**

**Record mode** helps: `playbook_record_start({savePath})` streams every tool call to a JSONL draft; do the task once;
`playbook_record_stop()`. The draft is a *seed* — you still distill it into the durable Markdown (refs/requestIds →
locators, strip secrets), then `playbook_save({savePath, markdown})`.

## Executing a playbook

The runner is the agent following a procedure, not a code interpreter:

1. **Load + parse.** If required sections are missing/malformed, STOP and report — never guess structure. Echo a
   one-line summary (title, N steps, params, destructive-step count).
2. **Bind params.** Merge caller values over defaults; a missing required/`secret` param → STOP and ask. Never
   proceed with a placeholder secret.
3. **Resolve the target tab** by origin (`tabs_list`); if none, `navigate` to the entry URL.
4. **Validate preconditions.** Met → go. Unmet but establishable and non-destructive (e.g. one nav away, a cookie
   banner) → fix once, re-check. Unmet and not establishable (wrong account, logged out) → **hard STOP** — never
   auto-log-in.
5. **Choose run mode.** **Dry-run by default** when `last_verified` is stale/absent or the user says "preview":
   narrate each step's resolved locator + checkpoint *without* calling any mutating tool. Otherwise execute.
6. **Step loop** — per step:
   1. Fresh `snapshot` (DOM) or `screenshot` (canvas) if perception is stale.
   2. Resolve the robust locator (role + name), not a stored ref/coord.
   3. **Verify before acting (mandatory gate):** confirm the candidate's role/label/type matches intent. Exactly
      one match → go. Zero → heal. Multiple with no disambiguator → **STOP, never pick arbitrarily.**
   4. Safety gate (destructive → confirm; see below).
   5. Act via the right tool (`ref` when just-snapshotted, else `selector`; `input` for canvas). The tool's own
      auto-wait absorbs transient timing.
   6. Inspect the result: `{clicked}/{filled}` → continue; `{notActionable, reason}` / `{staleRef}` → heal.
   7. Evaluate the `checkpoint`. Pass → advance. Fail → heal.
7. **Finalize.** Emit a structured run report (per-step `ok | healed | skipped | already-satisfied | failed`,
   `via: synthetic|trusted`, and a resume point). If any step healed, **offer** to update the playbook's locator +
   `last_verified` (never auto-write).

### Heal decision tree (cap 3 attempts/step; never blunder on ambiguity)

- **Transient** — `notActionable` reason ∈ {hidden, disabled, "not-found-after-Nms"} while the page is still
  loading, or `staleRef`, or the checkpoint's element is "not yet" present → **wait/re-snapshot/retry** the same
  resolved action with small backoff. Still failing after N → treat as drifted.
- **Drifted** — locator resolves to zero candidates, or to an element whose role/label doesn't match intent, or a
  checkpoint fails though the action "succeeded" → **re-derive** the target from the step's `intent` + `notes` on
  the *current* page (search for an element whose role+name satisfies the intent, using the understanding as the
  semantic anchor). Exactly one strong match → act, mark `healed:{from,to}`. Several plausible or none → **STOP.**
- **Blocked** — a precondition that held at start is gone: logged out, 403/paywall, CAPTCHA/2FA, wrong account →
  **hard STOP immediately.** No retry, no auto-auth. Report the broken invariant + the resume point.

Give-up rule: after N heals on one step, OR on any ambiguity, OR on any `blocked` signal → stop and report; never
advance. The report includes the step, the classified cause, a page excerpt, and the first unrun step (for resume).

### Safety rules

- **Destructive steps** (`destructive: true` — delete / submit / pay / send) require an **explicit per-step
  confirmation** naming the exact resolved target (role + label) and the concrete effect. No batch-approve. "No" →
  skip and stop the run. This holds even under a "no guardrails" preference — irreversible is the carve-out.
- **Dry-run / preview** walks the whole protocol but substitutes narration for every mutating call; default it for
  a stale/unverified playbook before offering to execute.
- **Idempotency guard** — before a destructive step, check its checkpoint first; if already satisfied (e.g. a
  resumed run), skip rather than repeat.
- **Hard STOP (no heal)** on: ambiguity at the verify gate, a blocked signal, running as the wrong account/identity,
  an unexpected origin/tab switch, or N-heal exhaustion. Leave the browser as-is; don't attempt cleanup that could
  itself be destructive.
- **Secrets** are redacted in the run report and never written to the playbook.

### Canvas / pixel mode (remote desktop, games, WebGL)

There are no DOM elements to re-derive from, so:

| Phase | DOM mode | Canvas mode |
|---|---|---|
| Perceive | `snapshot` (+ `get_page_text`) | `screenshot` (read `dpr`, `cssWidth/Height`, `visibilityState`, `warning`) |
| Resolve | role + name → ref/selector | vision: locate the region; `inputCoord = screenshotPixel / dpr` |
| Verify | candidate role/label matches intent | the expected control is visibly present at that spot |
| Act | `click/fill/type/hover/scroll` | `input` (`activate:true` so a throttled tab foregrounds and you can observe) |
| Checkpoint | element/URL/text predicate | a fresh `screenshot` shows the expected pixels changed |
| Heal | re-snapshot, re-derive from role/text | re-screenshot, re-locate by appearance; **never reuse a saved coord** |

Use `visibilityState`/`warning` to tell a *stale throttled frame* (re-`activate`, re-capture) from a *genuinely
changed screen* (re-derive from vision, or STOP if unrecognizable). Coordinates are the most fragile locator — always
re-derive them from a fresh screenshot; resolve ambiguity by asking, never by guessing pixels.

---

## Example — delete a LinkedIn / X-style post (DOM, destructive)

~~~markdown
---
id: linkedin-delete-post
name: Delete one of my LinkedIn posts
goal: Remove a specific post I authored.
site: ["https://www.linkedin.com/*"]
version: 1
last_verified: 2026-07-23
verified_against: "www.linkedin.com desktop web, en-US, 2026-07 layout"
destructive: true
reversible: false
tags: [social, moderation, dom]
tools: [navigate, snapshot, get_page_text, hover, click, wait_for]
params:
  post_text: { desc: distinctive substring of the post to delete, example: "our seed round", required: true }
  activity_url: { desc: your activity page, example: "https://www.linkedin.com/in/me/recent-activity/all/", required: false }
preconditions:
  - Logged in as the AUTHOR (delete only appears on own posts).
success: Post card gone AND get_page_text lacks {{post_text}}.
---

# Delete a LinkedIn post

> DESTRUCTIVE + irreversible. Before the final confirm (Step 5), re-read the card and assert its text
> contains {{post_text}}. If more than one card matches, STOP and ask.

## Step 1 — Open the activity page and find the target card
```yaml
intent: Get the post rendered so its controls exist.
action: { tool: navigate, url: "{{activity_url | default:https://www.linkedin.com/in/me/recent-activity/all/}}" }
checkpoint:
  text_present: "{{post_text}}"
  on_fail: the feed is VIRTUALIZED — scroll down repeatedly (up to ~15x) to force-mount cards; if still absent, abort ("post not found").
notes: get_page_text only sees mounted cards; scroll to force-mount before concluding a post is missing.
```

## Step 2 — Reveal the overflow (…) control on that card
```yaml
intent: Surface the per-post "…" menu button, hidden until hover on desktop.
locator: { role: button, name: { matches: "/^(more|open (control|options) menu|control your feed)/i" }, within: "post card containing {{post_text}}" }
action: { tool: hover, trusted: true }
checkpoint: { snapshot_has: { role: button, name: { matches: "/more|control/i" }, within: "the {{post_text}} card" } }
notes: |
  Use trusted:true — the reveal is real CSS :hover on some builds. The button's accessible name varies
  ("More", "Open control menu for this post", "Control your feed"): match loosely and SCOPE to the card,
  or you may grab the global feed-sort control instead.
```

## Step 3 — Open the menu
```yaml
intent: Click the … button to open the actions menu.
locator: { role: button, name: { matches: "/more|control/i" }, within: "the {{post_text}} card" }
action: { tool: click, withSnapshot: true }
checkpoint:
  snapshot_has: { role: menuitem, name: { matches: "/delete/i" } }
  on_fail: the menu is a PORTAL at the end of <body>, not inside the card — re-snapshot the whole page.
notes: Menu items are NOT descendants of the card (role=menu portal on document.body); match page-wide, pick from the menu that just opened.
```

## Step 4 — Choose "Delete post"
```yaml
intent: Select the delete action.
locator: { role: menuitem, name: { matches: "/^delete/i" } }
fallbacks: [ { role: button, name: { matches: "/delete/i" } } ]
action: { tool: click, withSnapshot: true }
checkpoint: { snapshot_has: { role: dialog }, text_present: "Delete post?" }
```

## Step 5 — Confirm in the dialog  (FINAL, irreversible)
```yaml
intent: Confirm deletion in the modal.
precheck: Re-read the dialog/card with get_page_text and assert it references {{post_text}}. If ambiguous, STOP.
locator: { role: button, name: { equals: "Delete" }, within: "the confirmation dialog (role=dialog)" }
action: { tool: click, trusted: true }
checkpoint:
  text_absent: "{{post_text}}"     # or text_present: "Post deleted" (toast)
  on_fail: the dialog may still be closing — wait_for the toast, then re-check. Do NOT re-click.
notes: |
  TWO "Delete" affordances — the menuitem (Step 4) and this dialog button. Scope the confirm to role=dialog
  so you don't re-open the menu. Overlay/animation can cover it → trusted:true (click auto-escalates anyway).
```
~~~

---

## Example — BOLA / IDOR check (pentest, non-DOM tool sequence)

Playbooks aren't just clicks — they encode methodology. Note the rule that **requestIds are ephemeral** (the pentest
twin of snapshot refs) and must be re-resolved by signature every run.

~~~markdown
---
id: bola-order-endpoint
name: BOLA/IDOR check on the order-detail API
goal: Verify GET /api/orders/{id} enforces per-user ownership.
site: ["https://app.target.example/*", "https://api.target.example/*"]
version: 1
last_verified: 2026-07-18
destructive: false
tags: [pentest, bola, idor, authz]
tools: [navigate, net_capture_start, net_get_requests, identity_capture, replay_request, authz_matrix, response_diff]
params:
  base_api:   { desc: API origin, example: "https://api.target.example", required: true }
  endpoint:   { desc: path template with the object-id marker, example: "/api/orders/{{order_id}}", required: true }
  order_id_A: { desc: an order id OWNED BY account A, example: "80231", required: true }
  order_id_B: { desc: an order id OWNED BY account B (A must NOT own it), example: "80244", required: true }
preconditions:
  - You are AUTHORIZED to test this target (raw offensive primitives, no scope guard — operator's responsibility).
  - You can log in as two separate accounts A and B.
success: >
  If B or anon reach A's order (status <400 + similar body), that is a CONFIRMED BOLA — authz_matrix flags it.
---

# BOLA on order-detail

## Step 1 — Capture identity A
```yaml
intent: Snapshot account A's live session for replay.
action: { tool: identity_capture, name: "A", domain: "target.example" }
checkpoint: { response: "identity A stored with >=1 cookie" }
notes: Log in as A in the active tab FIRST, then capture. HttpOnly cookies come via the debugger. Never paste tokens here — identities live in server memory, referenced by name.
```

## Step 2 — Capture identity B
```yaml
intent: Snapshot account B's session (second tab / after re-login as B).
action: { tool: identity_capture, name: "B", domain: "target.example" }
checkpoint: { response: "identity B stored" }
```

## Step 3 — Observe a real authenticated request as A (resolve by SIGNATURE, not id)
```yaml
intent: Capture a genuine request so the replay carries the app's real headers/tokens.
action:
  - { tool: net_capture_start, urlFilter: "{{base_api}}" }
  - { tool: navigate, url: "{{base_api}}{{endpoint | with:order_id=order_id_A}}" }
  - { tool: net_get_requests, urlFilter: "/api/orders/" }
checkpoint: { response: "a GET matching /api/orders/{{order_id_A}} with status 200" }
notes: |
  requestIds are EPHEMERAL to this capture (like snapshot refs). DO NOT hardcode one. Re-resolve every run by
  matching method+URL in net_get_requests, then feed THAT id to authz_matrix. (Id-free alternative: drive
  replay_request ad-hoc with {url,method} — but capturing preserves app-specific auth/anti-CSRF headers.)
```

## Step 4 — Cross-identity access-control matrix
```yaml
intent: Replay A's request to A's order as A (baseline), B, and anon; diff the responses.
action: { tool: authz_matrix, requestIds: ["<resolved in Step 3>"], identities: ["A", "B", "anon"], mutateIds: true }
checkpoint:
  response: |
    PASS = B and anon BLOCKED (401/403 or divergent/empty body). FINDING if a non-baseline cell has
    status <400 and diff.similarity > 0.6 ("ACCESS-CONTROL"), or anon <400 ("BROKEN-AUTH").
notes: identities[0] is the baseline; always include "anon". mutateIds also probes {{order_id_A}}+1 for sequential IDOR.
```

## Step 5 — Direct B-owned-object probe (confirm horizontal escalation)
```yaml
intent: As A, request an order KNOWN to belong to B.
action: { tool: replay_request, url: "{{base_api}}{{endpoint | with:order_id=order_id_B}}", method: GET, identity: "A" }
fallbacks: [ { tool: replay_request, note: "retry viaAppClient:true so the app's own CSRF/auth interceptors apply (rules out a header we omitted)" } ]
checkpoint: { response: "PASS if 403/404. FINDING if 200 returning B's order data." }
```
~~~

---

## Record-mode quickstart

```
playbook_record_start({ savePath: "~/.browser-bridge/playbooks/<slug>.draft.jsonl" })
   … do the task once …
playbook_record_stop()            → { saved, count }
   … distill the JSONL into Markdown (refs/requestIds → locators; strip secrets) …
playbook_save({ savePath: "~/.browser-bridge/playbooks/<slug>.md", markdown: "…" })
```

The `.draft.jsonl` is a seed for your memory, never the shipped playbook.
