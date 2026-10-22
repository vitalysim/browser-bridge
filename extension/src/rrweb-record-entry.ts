/// <reference types="chrome" />
// Vendored recorder bundle — injected into the page (ISOLATED world, which has chrome.runtime and
// shares the DOM) by session_record_start. Exposes window.__bbRec.{start,stop}. rrweb is bundled in.
// Events are batched and relayed to the service worker via chrome.runtime.sendMessage({cmd:"bb-rec"}).
import { record } from "rrweb";
import { startCanvasCapture, type CanvasCaptureHandle } from "./canvas-capture";

type StartOpts = {
  recordingId?: string;
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
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let recordingId = "";
  let documentId = "";
  let seq = 0;
  const pending: { seq: number; events: any[] }[] = [];
  let sending: Promise<void> | null = null;

  async function deliver(item: { seq: number; events: any[] }): Promise<boolean> {
    try {
      const reply = await chrome.runtime.sendMessage({ cmd: "bb-rec", recordingId, documentId, ...item });
      if (reply?.accepted) {
        const i = pending.indexOf(item);
        if (i >= 0) pending.splice(i, 1);
        return true;
      }
      if (reply?.armed === false) {
        pending.length = 0;
        // A document restored from BFCache may outlive the tab's stopped recording.
        if (w.__bbRec.recording) void w.__bbRec.stop(recordingId);
      }
    } catch { /* keep custody until the worker acknowledges this batch */ }
    return false;
  }
  function pump(): Promise<void> {
    if (sending) return sending;
    sending = (async () => {
      while (pending.length && await deliver(pending[0])) { /* ordered, acknowledged transfer */ }
    })().finally(() => {
      sending = null;
      if (pending.length && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; void pump(); }, 250);
    });
    return sending;
  }

  const flush = (final = false) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (batch.length) {
      pending.push({ seq: ++seq, events: batch });
      batch = [];
      batchBytes = 0;
    }
    // A dying document cannot wait for an earlier ACK before sending its tail. Duplicate delivery
    // is harmless: the worker dedupes by documentId + seq.
    if (final) for (const item of [...pending]) void deliver(item);
    return pump();
  };
  const emit = (e: any) => {
    batch.push({ ...e, bbDocumentId: documentId });
    batchBytes += eventBytes(e);
    if (batch.length >= 50 || batchBytes >= FLUSH_BYTES) flush();
    else if (!timer) timer = setTimeout(() => void flush(), 300);
  };
  window.addEventListener("pagehide", () => { if (w.__bbRec.recording) void flush(true); });
  window.addEventListener("pageshow", (e) => {
    // A BFCache restore reuses this document. A fresh snapshot makes it a usable segment again.
    if (e.persisted && w.__bbRec.recording) {
      (record as any).takeFullSnapshot?.(true);
      void flush();
    }
  });

  w.__bbRec = {
    recording: false,
    start(opts: StartOpts = {}) {
      if (this.recording) return { started: false, reason: "already recording", recordingId };
      recordingId = opts.recordingId ?? "legacy";
      documentId = crypto.randomUUID();
      seq = 0;
      pending.length = 0;
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
          maskTextSelector: opts.maskInputs ? '[contenteditable]:not([contenteditable="false"]), [contenteditable]:not([contenteditable="false"]) *' : undefined,
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
          let code = e.code;
          // Honor maskInputs: don't leak, in cleartext keystrokes, what input-masking would redact.
          if (mask && typeof key === "string" && key.length === 1) {
            const path = e.composedPath();
            let focused: any = document.activeElement;
            while (focused) {
              path.push(focused);
              focused = focused.shadowRoot?.activeElement;
            }
            const masked = path.some((t: any) => t?.tagName === "TEXTAREA" || t?.isContentEditable ||
              (t?.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|range|color|file|hidden)$/i.test(t.type || "")));
            if (masked) { key = "•"; code = ""; }
          }
          (record as any).addCustomEvent("bb-key", {
            key,
            code,
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
    async stop(expectedId?: string) {
      if (expectedId && expectedId !== recordingId) return { stopped: false, reason: "different recording" };
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
      this.recording = false;
      // Stop the producer first, then wait for the worker to own the tail before the done marker.
      await Promise.race([flush(), new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (!pending.length && retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      return { stopped: true, drained: pending.length === 0 };
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
