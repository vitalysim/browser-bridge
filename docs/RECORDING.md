# Session recording → self-contained HTML replay

Record a live browser interaction and get back a **single self-contained HTML file** that plays the whole thing
back with a **play button, timeline scrubber, and speed control** — like a video, but built from the DOM. This is
session replay (the rrweb approach), and browser-bridge does it with a few advantages a page-level recorder can't.

## Use it

```
session_record_start({ tabId?, allFrames?, maskInputs?, recordCanvas?, canvasFps?, canvasQuality?, canvasMaxDim?, canvasBudgetMB?, eventsPath? })
   … interact with the page (scroll, click, type, navigate) …
session_record_stop({ savePath, title?, autoplay? })   → { saved, htmlBytes, eventCount, durationMs }
```

- **`session_record_start`** injects the recorder and begins capturing the DOM + mutations + input/scroll/mouse.
  It's **banner-free** (scripting only, no `chrome.debugger`). Raw events stream to
  `~/.browser-bridge/recordings/session-<ts>.events.jsonl` on disk as you go, so a long session survives the
  service-worker's memory limits.
- **`session_record_stop`** assembles a self-contained `.html` (rrweb-player + the events inlined) at `savePath`
  (default: the events file with `.html`). Double-click it — it replays offline, no server, no network.
- **`session_record_status`** lists active recordings (tab, file, events so far).

Start options: `allFrames:true` also records **cross-origin iframes** (best-effort: injected per-frame with a per-frame
timeout, so one wedged ad/embed frame can't stall the start); `maskInputs:true` redacts form values; `recordCanvas:true`
captures **`<canvas>`/WebGL** as periodic image frames the replay paints (see **Canvas / WebGL** below). Stop options:
`inlineAssets` (default **true** - see below), `assetBudgetMB` (total budget,
default 50), `perAssetMB` (per-asset cap, default 2), `skipInactive` (default **false** - play idle/scroll stretches in
real time), `autoplay`.

The replay **fills the viewer window at the recorded page's exact aspect ratio** (fit-to-viewport): the player box is
sized to the recorded viewport and scaled to fit, so there's no wasted letterbox - just a dark margin around a
correctly-proportioned replay. It **rescales on window resize** and follows mid-session viewport changes.

The replay ships with a custom **FRACTURE**-styled player chrome: a monochrome black stage, a top metabar
(`FRACTURE // <title>` + event count, duration, a live indicator) and a bottom control bar (play/pause, a mono
timecode, a scrubber, `1×/2×/4×/8×` speed chips, skip-idle, the interactions toggle, and fullscreen). rrweb's default
controller is hidden; the bar is wired to the player API.

### Interaction overlay (mouse trail, clicks, keystrokes)
- **Smooth mouse trail.** The replay draws a soft, rounded, brand-colored trail behind the cursor (replacing rrweb's
  default hard-cornered red line). It's always on and fades within ~0.6 s.
- **Interactions toggle** (a keyboard button `⌨` in the player controls, **on by default**) shows/hides:
  - **Click ripples** - an expanding ring at each click/double-click/tap.
  - **Keystroke HUD** - a caption of what you typed. For recordings made with the current extension it shows **physical
    keys** (letters plus `Enter ↵`, arrows, and shortcuts like `⌘ C`); older recordings fall back to the **typed field
    text**, and pastes/autofills are surfaced either way.
- **Privacy.** Physical-key capture logs every keystroke, so with masking **off** (the default) it will show passwords
  key-by-key. Recording with `maskInputs:true` redacts printable keys typed into inputs (shown as `•`), consistent with
  how it masks input values. Treat a recording as sensitive as the session it captured.

## Canvas / WebGL (`recordCanvas:true`)

Session replay reconstructs the DOM + CSS, not the page's JS runtime, so raw `<canvas>`/WebGL drawing is otherwise
lost. With `recordCanvas:true` the recorder **samples each canvas as an image on a timer** and streams those frames
alongside the DOM events; the replay player **paints the latest frame at-or-before the play head onto the replayed
canvas** (matched by rrweb node id). It's off by default and adds weight, so turn it on only when the canvas is the
point.

- **How it reads pixels.** 2D canvases read back anytime. A WebGL canvas with the common `preserveDrawingBuffer:false`
  is **blank if read outside the page's own paint**, so the sampler reads inside a `requestAnimationFrame` — in the same
  frame the page drew, before the compositor discards the back-buffer. `createImageBitmap` snapshots at call time, so a
  continuously-animating WebGL canvas captures its real pixels. This runs on plain `chrome.scripting` (banner-free) and
  is **independent of rrweb's own canvas code**, which the extension disables (it runs in the isolated world and reads
  WebGL blank — 0 frames for the common case).
- **Frames are de-duplicated.** An unchanged canvas ships nothing (a per-canvas hash skips identical frames), so an
  idle canvas costs almost nothing.
- **Reach.** Canvases in **open shadow DOM** and **same-origin iframes** are discovered (a plain `querySelectorAll`
  misses both).
- **Options** (on `session_record_start`): `canvasFps` (default **4**), `canvasQuality` (WebP quality 0-1, default
  **0.6**), `canvasMaxDim` (downscale a canvas past this longest edge, default **1280** px), `canvasBudgetMB` (total
  encoded-canvas byte budget; capture stops past it, default **32**).
- **Caveats (honest).** A **cross-origin-tainted** canvas (drawn from another origin's image/video without CORS) is
  unreadable — it's **skipped**, with a one-time note in the stream, never a thrown error. **Closed shadow roots** and
  canvases inside **cross-origin iframes** aren't reached. A WebGL canvas that only draws **on demand** (not every
  frame) may be sampled between paints and read blank (also skipped + noted); continuously-animating canvases are the
  solid case. `canvas.captureStream()` would sidestep the rAF-timing issue for WebGL and is a possible future
  enhancement.
- **Export.** The MP4 export (`render_recording_video`) waits until each frame's canvas image has decoded before it
  screenshots, so exported canvas frames aren't stale. Regenerate the replay with this version for canvas frames to
  appear.

## What makes this better than page-level rrweb

- **Truly self-contained / offline-faithful.** On stop, the server fetches **every external asset the capture
  references — cross-origin stylesheets, fonts, and images — through the extension** (MV3 background `fetch` under
  `<all_urls>` has no CORS wall and sends your session cookies) and **inlines them** into the file (`_cssText` for
  sheets, `data:` URIs for images/fonts, `@import` chains flattened). This covers the hard cases page-level rrweb
  misses: **relative `url()`/`@import` refs** in fetched cross-origin CSS (self-hosted fonts, sprite backgrounds) are
  resolved against their sheet and inlined; **lazy-loaded images** that arrive as later DOM mutations (scroll-triggered
  `src`/`srcset`) are inlined too; **`srcset`** is parsed comma-safely and every candidate inlined; and **incremental
  CSS** (`insertRule`, `replace`/`replaceSync`, adopted stylesheets) is rewritten. So the replay renders from
  *captured* data, not by re-fetching the live site — it works offline and won't break when the CDN or site changes. It
  also **strips nodes injected by your *other* extensions** (`chrome-extension://…`). Oversized/over-budget assets
  (2 MB/asset via `perAssetMB`, 50 MB total via `assetBudgetMB` by default) are left live and reported in `skipped`.
- **Cross-origin iframes are actually captured.** Vanilla rrweb needs its script running on the third-party origin
  (which you don't control). The extension injects the recorder into *any* cross-origin child — payment, OAuth, ad,
  embedded-doc frames — via `<all_urls>`, with zero cooperation from the framed site (`allFrames:true`).
- **CSP-immune.** Hardened pages (banking, strict `script-src`) that block an injected `<script>` or a bookmarklet
  can't stop `chrome.scripting`. Recording works where page-level rrweb can't even load.
- **Banner-free.** No debugger attaches during recording — a real win for "record my session."

## Caveats (be honest about fidelity)

- **rrweb replays a reconstructed DOM + CSS, not the original JS runtime.** Visual state that isn't expressed as DOM
  or attribute mutations (e.g. raw `requestAnimationFrame` drawing) is lost — **except `<canvas>`/WebGL**, which
  `recordCanvas:true` captures as image frames (see **Canvas / WebGL** above, and its caveats).
- **Canvas / WebGL** aren't captured **by default** — pass `recordCanvas:true`. Live `<video>`/`<audio>` **pixels**
  still aren't captured (the poster is inlined; the stream isn't).
- **Closed shadow roots** and **sandboxed (no-scripts) iframes** can't run the recorder → not captured.
- **Assets over budget** (default 2 MB/asset, 50 MB total) are left as live URLs and listed in the `skipped` result —
  raise `assetBudgetMB` to inline more. Auth-gated assets that 401 for the background fetch are likewise left live.
- **Size.** Inlining images as `data:` URIs grows the HTML; the per-asset + total budgets bound it (CSS/fonts are cheap
  and always inlined; images are the bulk). Set `inlineAssets:false` for a small, online-only replay.
- **Privacy — masking is OFF by default.** The replay HTML contains **cleartext** form inputs and passwords exactly
  as typed. Pass `maskInputs:true` to redact them. Treat a recording as sensitive as the session it captured.

## How it works (architecture)

The recorder (rrweb, vendored into `extension/vendor/rrweb-record.js`) is injected into the page's frames. It relays
event batches to the service worker via `chrome.runtime.sendMessage`, which streams them over the same WebSocket
capture channel used by network capture (`{type:"capture", stream:"session"}`) to a per-tab JSONL sink on disk. On
stop, the server reads the JSONL and inlines the events + the vendored `rrweb-player` (both MIT) into one HTML file.

## Export to MP4 (`render_recording_video`)

Turn a saved replay `.html` into a **high-resolution MP4**:

```
render_recording_video({ htmlPath, out?, fps?, scale?, crf?, settleMs? })
   → { saved, frames, fps, scale, durationMs }
```

- **Deterministic + high-res.** It opens the replay in a tab and, for each frame, **seeks the player to an exact time,
  reconstructs the mouse-trail / click / keystroke overlay for that instant, and captures a lossless PNG at `scale`×**
  the recorded viewport (default `2` ≈ retina/4K; `1` = native). Frame-exact - no dropped frames, no realtime capture.
- The video is the **recorded page + the green interaction overlay, without the player bars**. `ffmpeg` encodes the
  frames to H.264 (`crf` default 16 ≈ visually lossless, `yuv420p` for universal playback).
- **Options:** `fps` (default 30), `scale` (1-4), `crf` (0-51), `settleMs` (post-seek wait, default 40), `chrome`
  (include the FRACTURE player metabar + control bar in the frame, not just the page + overlay), `out` (default = the
  `.html` path with `.mp4`).
- **Caveats:** it drives a **focused** tab for the whole render (steals focus) and is not instant - roughly
  `frames × ~0.4-0.7 s` (a 30 s clip at 30 fps ≈ several minutes); lower `fps`/`scale` to go faster. Needs `ffmpeg` on
  the machine (auto-found in Homebrew/usr paths, or set `FFMPEG_PATH`). Only works on replays generated by **v0.14+**
  (they carry the export harness). **Canvas/WebGL** frames captured with `recordCanvas:true` ARE exported (the export
  waits for each frame's image to decode first); live `<video>` **pixels** are still not captured (DOM replay limitation).
