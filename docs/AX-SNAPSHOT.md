# Accessibility-tree snapshot (`ax_snapshot`)

`ax_snapshot` returns a compact, indented, YAML-like **accessibility tree** of the page: every node
is a `role` plus its accessible `name` plus the states an agent cares about. It is the highest-signal
way to *understand and drive* a page — it shows structure (landmarks, headings, lists) and form
semantics (a field with its real label, a checkbox's checked state) that a flat element list or raw
page text does not.

It is **banner-free**: a plain injected ARIA walker (`chrome.scripting`), not `chrome.debugger`. It
descends **open shadow DOM** and **same-origin iframes** through the same per-frame injection the
other tools use, and skips `aria-hidden` and not-rendered subtrees.

## Output shape

```
- banner:
  - link "Home" [ref=1]
  - navigation "Primary":
    - link "Docs" [ref=2]
    - link "Pricing" [ref=3]
- main:
  - heading "Create your account" [level=1]
  - textbox "Email" [required] [ref=8]
  - textbox "Password" [required] [ref=9]
  - checkbox "Remember me" [ref=10]
  - button "Sign up" [ref=11]
- iframe "https://embed.example.com/widget":
  - button "Play" [ref=501]
```

- Each line is `- <role> "<name>" <states> [ref=N]`. The `"name"`, the state tokens and the `[ref=N]`
  appear only when they exist; a node with children ends with `:`.
- **`[ref=N]` is a live handle.** Pass it straight to `click`, `fill`, `hover` or `type` (as `ref`) —
  it resolves through the exact same off-DOM registry a `snapshot` ref uses, with the same per-frame
  numbering, so refs from `ax_snapshot` and `snapshot` are interchangeable with the action tools.
  Only interactive nodes get a ref.
- **States** rendered (only when meaningful): `[checked]` / `[unchecked]` / `[checked=mixed]`,
  `[expanded]` / `[collapsed]`, `[selected]`, `[disabled]`, `[required]`, `[focused]`,
  `[level=N]` (headings), `[value="…"]` (textbox / combobox / slider).
- Cross-origin iframes are listed after the main tree under an `iframe "<url>"` header rather than
  nested at their position in the parent (see *Limitations*).

## How role and name are computed

- **Role** = the explicit `role` attribute if present, else the implicit role of the tag/type
  (`a[href]`→link, `button`→button, `input[type=checkbox]`→checkbox, `h1..h6`→heading, `nav`→
  navigation, `ul/ol`→list, `select`→combobox, …). Non-semantic wrappers (`div`/`span` with no role
  or name) are **flattened**, so the tree stays about meaning, not markup.
- **Accessible name**, in order: `aria-labelledby` → `aria-label` → an associated `<label>` (`for=`
  or a wrapping label) → `alt` / `title` / `placeholder` → trimmed text content (only for leaf-ish
  roles like button/link/heading, so a landmark's name never swallows its whole subtree).

## Parameters

- `tabId` — target tab (defaults to the active tab).
- `interactiveOnly` — keep only interactive nodes and the containers on the way to them; drops pure
  prose. Use it when you just want the actionable surface of a busy page.

## When to prefer which read

| Goal | Tool |
| --- | --- |
| Understand page **structure**, find a form field by its label, see checked/expanded/selected state | **`ax_snapshot`** |
| Just the flat list of clickable/fillable elements (lightest) | `snapshot` |
| Reach elements inside **closed** shadow roots (accepts the debugger banner) | `snapshot({deep:true})` |
| Read the page's **prose** (an article, a feed, a chat log) | `get_page_text` |

`ax_snapshot` is **batchable** — chain it in `browser_batch` (e.g. `navigate → ax_snapshot`).

## Token budget

The tree is intentionally lean: empty containers are elided, non-semantic wrappers flattened, and
the render caps depth and among-siblings width, printing a `… (N more)` / `… (depth capped)` note
where it trims. The in-page walk also caps total nodes per frame and notes truncation. Even so, on a
very large page a full tree is bigger than a flat `snapshot`; reach for `interactiveOnly:true` when
you only need to act.

## Limitations

- **Cross-origin iframes** are walked (each frame is injected independently) but appended after the
  main tree under an `iframe "<url>"` header, not spliced into the exact position of their `<iframe>`
  element in the parent. Same-frame and open-shadow content is positioned correctly.
- Refs live in a per-snapshot registry: taking any new `snapshot` or `ax_snapshot` replaces it, and a
  ref whose element was since re-rendered is reported as not-found so you re-snapshot.
