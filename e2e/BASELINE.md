# e2e baseline: main @ b7a1d25 (v0.18.1)

Run 2026-10-21 on macOS (arm64), Node 26, Playwright Chromium 1248, **new headless**. 77 tools
exposed. The suite ran **3 times** (one with a full `npm test` rebuild). Every scenario produced the
same verdict each time: **6 pass, 14 fail, 0 flaky**. The hang durations were the same across runs
(confirm-dialog about 30.05s, slow-iframe about 24.05s, wait-for-invalid-selector about 10.1s). No
processes or temp dirs were left behind after any run (checked with `ps` and the temp dir).

Tool output below is real, trimmed.

| # | scenario | result | why |
|---|---|---|---|
| 1 | pointerdown-menu | FAIL | `click` -> `{"clicked":true,"via":"synthetic"}`, but the page saw only `["click"]`. A synthetic `el.click()` sends no pointerdown, so a Radix-style trigger never opens. |
| 1 | mousedown-menu | FAIL | Same: `{"clicked":true}` while the page's events are `[]`, so no mousedown fired. |
| 2 | shadow-button | FAIL | `{"coveredBy":"x-save-button","notActionable":true,"reason":"covered"}` and the handler ran 0 times. `elementFromPoint` returns the shadow host, so the button counts as covered by its own host. The auto-trusted escalation then gives up silently (probably because a shallow-snapshot ref can't be resolved over CDP), even though a trusted click works (see trusted-click-sanity). |
| 3 | confirm-dialog | FAIL | The dialog opens. `click` hangs (no reply within 15001ms), then `get_page_text` also hangs (15003ms). No tool can see or answer a JS dialog. Once the harness accepts it out of band, the page continues (`__answer=true`). |
| 4 | many-elements-modal | FAIL | `{"count":400,"elements":[...]}` with keys `url,count,elements` only. The modal's Confirm button (element 701) has no ref, and nothing reports that the list was truncated. |
| 5 | custom-controls | FAIL | The snapshot holds just 1 element: `{"label":"on","tag":"input","type":"checkbox"}`. Clicking it does check the box. The role=option, onclick/cursor:pointer div and `<summary>` get no refs. |
| 6 | select-by-visible-text | FAIL | `fill("California")` -> `{"filled":true,"tag":"select"}`, but `select.value` is `""` (want `"CA"`). It sets `.value` to the label, which matches no option. |
| 6 | checkbox-fill-true | FAIL | `fill("true")` -> `{"filled":true}`, but `checked=false`. It sets `input.value="true"` instead of toggling `checked`. |
| 6 | fill-reports-unsettable-value | FAIL | `fill("Texas")` -> `{"filled":true}` and the select is cleared to `""`. The failure is reported as success. |
| 7 | duplicate-selector | FAIL | `{"filled":true,"tag":"input"}` but values are `{"mobile":"","desktop":"","frame":"dup@example.com"}`. bbAct runs in every frame. The top frame's `querySelector` hits the hidden mobile input, the iframe's copy gets filled, and that result is returned. The visible desktop input is untouched and there's no `matchCount`. |
| 8 | slow-iframe | FAIL | When an iframe's response never finishes, `snapshot` and `click` each time out at the 12s per-call limit. The click did run (`__go=1`), but the call never returned. |
| 9 | stale-ref | FAIL | After the re-sort, the old "Delete Alice" ref -> `{"clicked":true,"label":"Delete Carol"}` and `__deleted=["Carol"]`. The wrong row was clicked silently (index-keyed DOM reuse keeps the node connected, so the staleRef check never fires). |
| 10 | react-like-input | PASS | `{"filled":true}`, and state and DOM are both `"Ada Lovelace"` after a re-render (the native prototype setter beats the value tracker). |
| 11 | smooth-scroll-target | PASS | `{"clicked":true,"via":"synthetic"}`, `__farClicked=1`. The pre-scroll center falls outside the viewport, so `elementFromPoint` is null and the cover check passes. |
| 12 | wait-for-text | PASS | Uses a selector: `wait_for` has no `text` param. `{"found":true}` after about 1.5s. |
| 12 | wait-for-invalid-selector | FAIL | `div[` -> `Error [TIMEOUT]: Timed out after 10000ms waiting for selector: div[` after 10029ms. The SyntaxError inside the injected function gets swallowed and polled as "not found". |
| 13 | screenshot-basic | PASS | Returns a 1280×813 PNG of 14021 bytes. |
| 13 | navigate-basic | PASS | `navigate` -> `{"url":".../basic2.html"}`, and `get_page_text` shows the new page. |
| 13 | trusted-click-sanity | PASS | Harness self-check: `{"clicked":true,"trusted":true,"via":"trusted"}` and the handler ran. CDP works inside the harness. |
| 13 | batch-halts-on-notActionable | FAIL | `{"executed":2,"total":2,...}`. The click returned `notActionable/covered`, but that's a normal (non-isError) result, so the batch went on and the fill ran (`#after="SHOULD-NOT-RUN"`). |

## Harness notes

- Headless works: Chromium's new headless loads the unpacked MV3 extension, and `captureVisibleTab`,
  `chrome.debugger` and `executeScript` all behave. `E2E_HEADED=1` is supported but wasn't needed
  for this baseline.
- Calls that time out on the client side (confirm-dialog, slow-iframe) may still be in flight in
  the hub until its own 30s timer runs out. Later scenarios use fresh tabs and weren't affected in
  any run.
- The confirm dialog is answered through Playwright only because the product has no dialog tool.
  The scenario will use a `*dialog*` tool automatically once one exists.
