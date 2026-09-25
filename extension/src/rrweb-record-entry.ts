/// <reference types="chrome" />
// Vendored recorder bundle — injected into the page (ISOLATED world, which has chrome.runtime and
// shares the DOM) by session_record_start. Exposes window.__bbRec.{start,stop}. rrweb is bundled in.
// Events are batched and relayed to the service worker via chrome.runtime.sendMessage({cmd:"bb-rec"}).
import { record } from "rrweb";
import { startCanvasCapture, type CanvasCaptureHandle } from "./canvas-capture";

type StartOpts = {
  allFrames?: boolean;
  maskInputs?: boolean;
  recordCanvas?: boolean;
  canvasFps?: number;
  canvasQuality?: number;
  canvasMaxDim?: number;
  canvasBudgetBytes?: number;
};

// Flush a batch once its events exceed this many bytes, not only at the 50-event count. Canvas image
// frames are large and few, so a count-only flush would leave them buffered for up to 300ms; a byte cap
// ships them promptly without churning on the many-tiny-events (mousemove/scroll) case.
const FLUSH_BYTES = 512 * 1024;

(() => {
  const w = window as any;
  if (w.__bbRec) return; // idempotent — the file may be injected more than once per frame

  let stopFn: (() => void) | null = null;
  let canvasCapture: CanvasCaptureHandle | null = null;
  let keyHandler: ((e: KeyboardEvent) => void) | null = null;
  let batch: any[] = [];
  let batchBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!batch.length) return;
    const events = batch;
    batch = [];
    batchBytes = 0;
    // sendMessage wakes a sleeping MV3 service worker, so a long idle session still delivers.
    try {
      chrome.runtime.sendMessage({ cmd: "bb-rec", events });
    } catch {
      /* SW gone/asleep — the next batch retries; the periodic checkout bounds any loss */
    }
  };
  const emit = (e: any) => {
    batch.push(e);
    batchBytes += eventBytes(e);
    if (batch.length >= 50 || batchBytes >= FLUSH_BYTES) flush();
    else if (!timer) timer = setTimeout(flush, 300);
  };

  w.__bbRec = {
    recording: false,
    start(opts: StartOpts = {}) {
      if (this.recording) return { started: false, reason: "already recording" };
      const isTop = window === window.top;
      let crossOrigin = false;
      if (!isTop) {
        try {
          void (window.top as any).document; // throws (SecurityError) if a cross-origin ancestor
        } catch {
          crossOrigin = true;
        }
      }
      // allFrames mode injects into EVERY frame, but only the top frame + cross-origin children run a
      // recorder — same-origin children are captured natively by the top recorder (no double-record).
      if (!isTop && !(opts.allFrames && crossOrigin)) return { started: false, reason: "same-origin child" };
      stopFn =
        record({
          emit, // in a cross-origin child, rrweb bridges records to the parent instead of calling this
          recordCrossOriginIframes: !!opts.allFrames,
          // NOT rrweb's recordCanvas: its snapshot observer runs in this isolated world and reads a WebGL
          // back-buffer outside the page's paint (blank), so it captures 0 frames for the common case. We
          // run our own rAF sampler below instead (top frame only - it covers same-origin subframes; a
          // cross-origin child's local mirror ids wouldn't line up after rrweb's parent-side id remap).
          recordCanvas: false,
          checkoutEveryNms: 30_000, // periodic full snapshot bounds loss on SW death
          maskAllInputs: !!opts.maskInputs,
          sampling: { mousemove: 16 }, // ~60fps mouse sampling so the replay trail is dense enough to render smoothly
          inlineStylesheet: true,
          collectFonts: false,
        }) || null;
      if (opts.recordCanvas && isTop) {
        canvasCapture = startCanvasCapture(
          {
            fps: opts.canvasFps,
            quality: opts.canvasQuality,
            maxDim: opts.canvasMaxDim,
            budgetBytes: opts.canvasBudgetBytes,
          },
          emit,
          (node) => (record as any).mirror.getId(node)
        );
      }
      // rrweb doesn't record physical keydowns; capture them as custom events so the replay can show a
      // keystroke HUD (Enter/arrows/shortcuts + typed chars). Rides the same emit->relay->JSONL->replay path.
      const mask = !!opts.maskInputs;
      keyHandler = (e: KeyboardEvent) => {
        try {
          let key = e.key;
          // Honor maskInputs: don't leak, in cleartext keystrokes, what input-masking would redact.
          if (mask && typeof key === "string" && key.length === 1) {
            const t = e.target as any;
            const tag = t && t.tagName;
            const masked =
              tag === "TEXTAREA" ||
              (t && t.isContentEditable) ||
              (tag === "INPUT" && /^(text|password|search|email|tel|url|number|)$/i.test(t.type || ""));
            if (masked) key = "•";
          }
          (record as any).addCustomEvent("bb-key", {
            key,
            code: e.code,
            ctrl: e.ctrlKey,
            meta: e.metaKey,
            alt: e.altKey,
            shift: e.shiftKey,
          });
        } catch {
          /* recorder stopped between keydown and emit */
        }
      };
      document.addEventListener("keydown", keyHandler, true);
      this.recording = true;
      return { started: true, top: isTop, crossOrigin };
    },
    stop() {
      if (keyHandler) {
        try {
          document.removeEventListener("keydown", keyHandler, true);
        } catch {
          /* ignore */
        }
        keyHandler = null;
      }
      try {
        canvasCapture && canvasCapture.stop();
      } catch {
        /* already stopped */
      }
      canvasCapture = null;
      try {
        stopFn && stopFn();
      } catch {
        /* already stopped */
      }
      stopFn = null;
      flush();
      this.recording = false;
      return { stopped: true };
    },
  };
})();

// Approximate on-the-wire size of one event, cheaply. Only canvas image frames are big enough to matter
// for the byte flush; their weight is the base64 payload, so size those exactly and treat everything
// else as small (the 50-count / 300ms flush already bounds a burst of little events).
function eventBytes(e: any): number {
  try {
    if (e && e.type === 3 && e.data && e.data.source === 9 && Array.isArray(e.data.commands)) {
      for (const c of e.data.commands) {
        const arg0 = c && c.property === "drawImage" && c.args && c.args[0];
        const b64 = arg0 && arg0.args && arg0.args[0] && arg0.args[0].data && arg0.args[0].data[0] && arg0.args[0].data[0].base64;
        if (typeof b64 === "string") return b64.length;
      }
    }
  } catch {
    /* fall through to the nominal size */
  }
  return 256;
}
