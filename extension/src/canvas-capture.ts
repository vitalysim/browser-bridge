/// <reference types="chrome" />
// Periodic <canvas>/WebGL frame capture for session recording, injected alongside rrweb into the page
// (ISOLATED world - shares the DOM, has its own JS global). rrweb's own recordCanvas is disabled: it
// runs in the isolated world too, so its getContext/draw patches never see the page's real drawing, and
// its whole-canvas read for a WebGL context with preserveDrawingBuffer:false comes back BLANK when read
// outside the page's own paint. Instead we sample each canvas with createImageBitmap INSIDE a
// requestAnimationFrame (createImageBitmap snapshots the pixels at call time, so a rAF read lands in the
// same frame the page drew - before the compositor discards a WebGL back-buffer). Encoded frames ride
// rrweb's own CanvasMutation event shape (clearRect + drawImage of an ImageBitmap/Blob) out through the
// SAME emit -> chrome.runtime bb-rec -> JSONL path, keyed by record.mirror.getId(canvas) so they line up
// with the snapshot on replay. Our replay player paints them; rrweb ignores them (UNSAFE_replayCanvas:false).

// rrweb enum values we reproduce so a frame is a valid canvasEventWithTime (and a hypothetical
// UNSAFE_replayCanvas:true would replay it unchanged). See @rrweb/types.
const EVENT_INCREMENTAL = 3; // EventType.IncrementalSnapshot
const EVENT_CUSTOM = 5; // EventType.Custom
const SOURCE_CANVAS_MUTATION = 9; // IncrementalSource.CanvasMutation
const CANVAS_CONTEXT_2D = 0; // CanvasContext["2D"] - we always replay via a 2D drawImage
export const CANVAS_NOTE_TAG = "bb-canvas-note"; // one-time diagnostics (tainted / blank / budget)

export interface CanvasCaptureOpts {
  fps: number; // frames/sec sampled per canvas (throttled off the rAF loop)
  quality: number; // WebP/JPEG quality 0..1
  maxDim: number; // longest-edge cap; larger canvases are downscaled before encode
  budgetBytes: number; // total encoded-byte budget for the whole recording; capture stops past it
  mime: string; // preferred encode type; falls back if the browser can't produce it
}

// Small, self-contained so it can run in every recorded frame (top + cross-origin child) without
// importing anything from the service-worker bundle.
type EmitFn = (event: any) => void;
type GetIdFn = (node: Node) => number;

export interface CanvasCaptureHandle {
  stop(): void;
}

const DEFAULTS: CanvasCaptureOpts = { fps: 4, quality: 0.6, maxDim: 1280, budgetBytes: 32 * 1024 * 1024, mime: "image/webp" };

export function startCanvasCapture(rawOpts: Partial<CanvasCaptureOpts>, emit: EmitFn, getId: GetIdFn): CanvasCaptureHandle {
  const opts: CanvasCaptureOpts = {
    fps: clamp(rawOpts.fps ?? DEFAULTS.fps, 0.5, 30),
    quality: clamp(rawOpts.quality ?? DEFAULTS.quality, 0.1, 1),
    maxDim: Math.max(64, Math.round(rawOpts.maxDim ?? DEFAULTS.maxDim)),
    budgetBytes: Math.max(1024 * 1024, Math.round(rawOpts.budgetBytes ?? DEFAULTS.budgetBytes)),
    mime: rawOpts.mime || DEFAULTS.mime,
  };

  const lastHash = new Map<number, number>(); // per-canvas rolling hash of the last EMITTED frame (skip unchanged)
  const noted = new Set<number>(); // canvas ids we've already emitted a one-time note for (tainted/blank)
  let sentBytes = 0;
  let budgetNoted = false;
  let stopped = false;
  let rafId = 0;
  let last = 0; // performance.now() of the last capture tick
  const interval = 1000 / opts.fps;

  // Reused encode surfaces. OffscreenCanvas.convertToBlob keeps encoding off the DOM; a tiny probe
  // canvas gives a cheap all-transparent test without reading back the full frame every tick.
  const enc: OffscreenCanvas | null = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : null;
  const probe: OffscreenCanvas | null = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(16, 16) : null;

  function tick(now: number): void {
    if (stopped) return;
    rafId = requestAnimationFrame(tick);
    if (last && now - last < interval) return;
    last = now;
    if (sentBytes >= opts.budgetBytes) {
      if (!budgetNoted) {
        budgetNoted = true;
        note(-1, "budget", `canvas byte budget (${Math.round(opts.budgetBytes / 1024 / 1024)}MB) exhausted; further frames dropped`);
      }
      return;
    }
    const canvases: HTMLCanvasElement[] = [];
    try {
      collectCanvases(document, canvases, 0);
    } catch {
      /* a same-origin document went away mid-walk */
    }
    // Snapshot every canvas SYNCHRONOUSLY here in the rAF (createImageBitmap copies at call time), then
    // encode off the hot path. A WebGL back-buffer is still valid this frame; awaiting first would race
    // the compositor and read blank.
    for (const canvas of canvases) {
      if (canvas.width === 0 || canvas.height === 0) continue;
      let bmp: Promise<ImageBitmap>;
      try {
        bmp = createImageBitmap(canvas);
      } catch {
        continue; // e.g. a detached canvas
      }
      const id = getId(canvas);
      if (id == null || id < 0) {
        // createImageBitmap already claimed the frame; release it to avoid a leak.
        void bmp.then((b) => b.close()).catch(() => {});
        continue;
      }
      void encodeAndEmit(id, canvas.width, canvas.height, bmp);
    }
  }

  async function encodeAndEmit(id: number, w: number, h: number, bmpPromise: Promise<ImageBitmap>): Promise<void> {
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await bmpPromise;
      if (stopped || !enc || !probe) return;
      // Downscale huge / high-DPI canvases so a full-res retina frame doesn't blow the byte budget.
      const scale = Math.min(1, opts.maxDim / Math.max(w, h));
      const dw = Math.max(1, Math.round(w * scale));
      const dh = Math.max(1, Math.round(h * scale));
      if (enc.width !== dw) enc.width = dw;
      if (enc.height !== dh) enc.height = dh;
      const ectx = enc.getContext("2d");
      if (!ectx) return;
      ectx.clearRect(0, 0, dw, dh);
      ectx.drawImage(bmp, 0, 0, dw, dh);

      // Blank test: a WebGL frame read outside the page's own paint (preserveDrawingBuffer:false), or a
      // canvas that simply hasn't drawn yet, comes back fully transparent. Skip it (and note once) rather
      // than emitting an empty frame that would paint a hole over the replay. getImageData on the tiny
      // probe also throws SecurityError for a cross-origin-tainted canvas - handled below.
      const pctx = probe.getContext("2d", { willReadFrequently: true });
      if (pctx) {
        pctx.clearRect(0, 0, 16, 16);
        pctx.drawImage(bmp, 0, 0, 16, 16);
        const px = pctx.getImageData(0, 0, 16, 16).data; // throws if tainted
        if (isTransparent(px)) {
          if (!noted.has(id)) {
            noted.add(id);
            note(id, "blank", "canvas read back blank (WebGL preserveDrawingBuffer:false or not yet drawn); skipping");
          }
          return;
        }
      }

      const blob = await enc.convertToBlob({ type: opts.mime, quality: opts.quality });
      if (stopped) return;
      const buf = new Uint8Array(await blob.arrayBuffer());
      const hash = fnv1a(buf);
      if (lastHash.get(id) === hash) return; // unchanged frame - don't re-ship identical pixels
      lastHash.set(id, hash);
      sentBytes += buf.length;
      emit(canvasFrameEvent(id, dw, dh, blob.type || opts.mime, toBase64(buf)));
    } catch (e) {
      // A cross-origin-tainted canvas throws SecurityError on read/encode. Note it once, then leave it
      // alone - never throw in-page (the rAF loop must keep running for the other canvases).
      if (!noted.has(id)) {
        noted.add(id);
        note(id, "tainted", "canvas pixels are unreadable (cross-origin-tainted); not captured");
      }
    } finally {
      if (bmp) try { bmp.close(); } catch { /* already closed */ }
    }
  }

  function note(id: number, reason: string, message: string): void {
    try {
      emit({ type: EVENT_CUSTOM, data: { tag: CANVAS_NOTE_TAG, payload: { id, reason, message } }, timestamp: Date.now() });
    } catch {
      /* recorder stopped */
    }
  }

  rafId = requestAnimationFrame(tick);
  return {
    stop() {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },
  };
}

// One recorded frame, shaped exactly like rrweb's own canvas snapshot mutation so ids line up with the
// DOM snapshot and a real rrweb replay could apply it (ours paints it itself).
function canvasFrameEvent(id: number, width: number, height: number, mime: string, base64: string): any {
  return {
    type: EVENT_INCREMENTAL,
    data: {
      source: SOURCE_CANVAS_MUTATION,
      id,
      type: CANVAS_CONTEXT_2D,
      commands: [
        { property: "clearRect", args: [0, 0, width, height] },
        {
          property: "drawImage",
          args: [{ rr_type: "ImageBitmap", args: [{ rr_type: "Blob", data: [{ rr_type: "ArrayBuffer", base64 }], type: mime }] }, 0, 0],
        },
      ],
    },
    timestamp: Date.now(),
  };
}

// Collect canvases from a document/shadow root, descending into open shadow roots and same-origin
// iframes (querySelectorAll alone misses both). Closed shadow roots and cross-origin frames are
// unreachable - they simply aren't captured (documented caveat). Depth-bounded against pathological trees.
function collectCanvases(root: Document | ShadowRoot, out: HTMLCanvasElement[], depth: number): void {
  if (depth > 8 || out.length > 256) return;
  const all = root.querySelectorAll("*");
  for (const el of Array.from(all)) {
    // Identify by tagName, not instanceof: a same-origin child frame's nodes derive from THAT frame's
    // realm, so `instanceof HTMLCanvasElement` (this frame's constructor) is false across the boundary
    // and every iframe canvas would be skipped. bbSnapshot uses nodeName elsewhere for the same reason.
    const tag = el.tagName;
    if (tag === "CANVAS") out.push(el as HTMLCanvasElement);
    else if (tag === "IFRAME") {
      let doc: Document | null = null;
      try {
        doc = (el as HTMLIFrameElement).contentDocument; // null / throws for cross-origin - that frame runs its own recorder
      } catch {
        doc = null;
      }
      if (doc) collectCanvases(doc, out, depth + 1);
    }
    const sr = (el as Element).shadowRoot; // open shadow roots only; closed returns null
    if (sr) collectCanvases(sr, out, depth + 1);
  }
}

// True when every sampled pixel is fully transparent (alpha 0) - the WebGL-blank / not-yet-drawn case.
function isTransparent(px: Uint8ClampedArray): boolean {
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return false;
  return true;
}

// FNV-1a over a strided sample of the bytes - cheap enough to run per frame, distinct enough to catch a
// real pixel change while ignoring nothing that matters at these frame sizes.
function fnv1a(buf: Uint8Array): number {
  let h = 0x811c9dc5;
  const stride = buf.length > 4096 ? Math.floor(buf.length / 4096) : 1;
  for (let i = 0; i < buf.length; i += stride) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) ^ buf.length;
}

function toBase64(buf: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000; // String.fromCharCode.apply chokes on very large arrays - chunk it
  for (let i = 0; i < buf.length; i += CHUNK) s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
  return btoa(s);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
