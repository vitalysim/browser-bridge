# Session recording → self-contained HTML replay

Record a live browser interaction and get back a **single self-contained HTML file** that plays the whole thing
back with a **play button, timeline scrubber, and speed control** — like a video, but built from the DOM. This is
session replay (the rrweb approach), and browser-bridge does it with a few advantages a page-level recorder can't.

## Use it

```
session_record_start({ tabId?, allFrames?, maskInputs?, recordCanvas?, eventsPath? })
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

Options: `allFrames:true` also records **cross-origin iframes**; `maskInputs:true` redacts form values;
`recordCanvas:true` attempts `<canvas>` (heavier, limited — see caveats).

## What makes this better than page-level rrweb

- **Cross-origin iframes are actually captured.** Vanilla rrweb needs its script running on the third-party origin
  (which you don't control). The extension injects the recorder into *any* cross-origin child — payment, OAuth, ad,
  embedded-doc frames — via `<all_urls>`, with zero cooperation from the framed site (`allFrames:true`).
- **CSP-immune.** Hardened pages (banking, strict `script-src`) that block an injected `<script>` or a bookmarklet
  can't stop `chrome.scripting`. Recording works where page-level rrweb can't even load.
- **Banner-free.** No debugger attaches during recording — a real win for "record my session."

## Caveats (be honest about fidelity)

- **rrweb replays a reconstructed DOM + CSS, not the original JS runtime.** Visual state that isn't expressed as DOM
  or attribute mutations (e.g. raw `requestAnimationFrame` drawing) is lost.
- **Canvas / WebGL** aren't captured by default (the recorder runs in the isolated world; `recordCanvas` is heavy and
  lossy). For pixel-perfect canvas/video, the upcoming MP4 export (screencast) is the better tool.
- **Cross-origin / DRM `<video>`** replays only if the source is reachable and CORS-open at view time.
- **Closed shadow roots** and **sandboxed (no-scripts) iframes** can't run the recorder → not captured.
- **Size.** Streaming solves memory during capture; very long sessions make a large HTML — mouse movement is sampled
  and a periodic full snapshot bounds it; a gzip-inlined variant is planned for huge sessions.
- **Privacy — masking is OFF by default.** The replay HTML contains **cleartext** form inputs and passwords exactly
  as typed. Pass `maskInputs:true` to redact them. Treat a recording as sensitive as the session it captured.

## How it works (architecture)

The recorder (rrweb, vendored into `extension/vendor/rrweb-record.js`) is injected into the page's frames. It relays
event batches to the service worker via `chrome.runtime.sendMessage`, which streams them over the same WebSocket
capture channel used by network capture (`{type:"capture", stream:"session"}`) to a per-tab JSONL sink on disk. On
stop, the server reads the JSONL and inlines the events + the vendored `rrweb-player` (both MIT) into one HTML file.

## Roadmap — MP4 export

A follow-up `render_recording_video` will turn a recording into an **MP4**: replay the HTML in a controlled tab, CDP-
screencast it → `ffmpeg` → MP4 (GIF fallback if ffmpeg is missing). One recording then yields both the HTML replay and
a shareable video, and the screencast also captures canvas/WebGL/video pixels that DOM capture misses.
