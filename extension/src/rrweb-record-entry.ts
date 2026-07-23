/// <reference types="chrome" />
// Vendored recorder bundle — injected into the page (ISOLATED world, which has chrome.runtime and
// shares the DOM) by session_record_start. Exposes window.__bbRec.{start,stop}. rrweb is bundled in.
// Events are batched and relayed to the service worker via chrome.runtime.sendMessage({cmd:"bb-rec"}).
import { record } from "rrweb";

type StartOpts = { allFrames?: boolean; maskInputs?: boolean; recordCanvas?: boolean };

(() => {
  const w = window as any;
  if (w.__bbRec) return; // idempotent — the file may be injected more than once per frame

  let stopFn: (() => void) | null = null;
  let batch: any[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!batch.length) return;
    const events = batch;
    batch = [];
    // sendMessage wakes a sleeping MV3 service worker, so a long idle session still delivers.
    try {
      chrome.runtime.sendMessage({ cmd: "bb-rec", events });
    } catch {
      /* SW gone/asleep — the next batch retries; the periodic checkout bounds any loss */
    }
  };
  const emit = (e: any) => {
    batch.push(e);
    if (batch.length >= 50) flush();
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
          recordCanvas: !!opts.recordCanvas,
          checkoutEveryNms: 30_000, // periodic full snapshot bounds loss on SW death
          maskAllInputs: !!opts.maskInputs,
          sampling: { mousemove: 50 },
          inlineStylesheet: true,
          collectFonts: false,
        }) || null;
      this.recording = true;
      return { started: true, top: isTop, crossOrigin };
    },
    stop() {
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
