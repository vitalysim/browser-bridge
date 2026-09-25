// Pure parsing of the canvas image frames the recorder streams into a session events file. The
// extension emits them as rrweb CanvasMutation events (source 9): a clearRect + a drawImage whose first
// arg is a serialized ImageBitmap -> Blob -> ArrayBuffer(base64). Our replay player paints those frames
// onto the replayed canvas itself (rrweb ignores them, UNSAFE_replayCanvas stays false). This module
// gives the server-side test - and any tooling - a browser-free way to pull the frames back out and
// tell captured (non-blank) frames from empty ones. Kept dependency-free and side-effect-free.

// rrweb enum values reproduced by the recorder (see extension/src/canvas-capture.ts and @rrweb/types).
export const EVENT_INCREMENTAL = 3; // EventType.IncrementalSnapshot
export const EVENT_CUSTOM = 5; // EventType.Custom
export const SOURCE_CANVAS_MUTATION = 9; // IncrementalSource.CanvasMutation
export const CANVAS_NOTE_TAG = "bb-canvas-note";

export interface CanvasFrame {
  id: number; // rrweb node id - matches the snapshot mirror, so it lines up with the replayed canvas
  timestamp: number;
  mime: string;
  base64: string;
  byteLength: number; // decoded size of the encoded image (WebP/JPEG/PNG bytes)
}

export interface CanvasNote {
  id: number;
  reason: string; // "tainted" | "blank" | "budget"
  message: string;
  timestamp: number;
}

/** Pull the {mime, base64} image out of a CanvasMutation drawImage(ImageBitmap(Blob(ArrayBuffer))). */
function imageFromCommands(commands: any[]): { mime: string; base64: string } | null {
  if (!Array.isArray(commands)) return null;
  for (const c of commands) {
    if (!c || c.property !== "drawImage" || !Array.isArray(c.args)) continue;
    const bitmap = c.args[0];
    if (!bitmap || bitmap.rr_type !== "ImageBitmap" || !Array.isArray(bitmap.args)) continue;
    const blob = bitmap.args[0];
    if (!blob || blob.rr_type !== "Blob" || !Array.isArray(blob.data)) continue;
    const ab = blob.data[0];
    if (!ab || ab.rr_type !== "ArrayBuffer" || typeof ab.base64 !== "string") continue;
    return { mime: typeof blob.type === "string" ? blob.type : "", base64: ab.base64 };
  }
  return null;
}

/** A single event -> CanvasFrame, or null if it isn't a canvas image frame. */
export function frameFromEvent(e: any): CanvasFrame | null {
  if (!e || e.type !== EVENT_INCREMENTAL || !e.data || e.data.source !== SOURCE_CANVAS_MUTATION) return null;
  if (typeof e.data.id !== "number") return null;
  const img = imageFromCommands(e.data.commands);
  if (!img) return null;
  return {
    id: e.data.id,
    timestamp: e.timestamp || 0,
    mime: img.mime,
    base64: img.base64,
    byteLength: base64ByteLength(img.base64),
  };
}

/** All canvas image frames in the stream, in event order. */
export function extractCanvasFrames(events: any[]): CanvasFrame[] {
  const out: CanvasFrame[] = [];
  for (const e of events) {
    const f = frameFromEvent(e);
    if (f) out.push(f);
  }
  return out;
}

/** Per-canvas frames, each list sorted by timestamp - the index a player seeks against. */
export function indexCanvasFramesById(events: any[]): Map<number, CanvasFrame[]> {
  const byId = new Map<number, CanvasFrame[]>();
  for (const f of extractCanvasFrames(events)) {
    let list = byId.get(f.id);
    if (!list) byId.set(f.id, (list = []));
    list.push(f);
  }
  for (const list of byId.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  return byId;
}

/** The one-time diagnostic notes the recorder emits for canvases it had to skip. */
export function canvasNotes(events: any[]): CanvasNote[] {
  const out: CanvasNote[] = [];
  for (const e of events) {
    if (!e || e.type !== EVENT_CUSTOM || !e.data || e.data.tag !== CANVAS_NOTE_TAG) continue;
    const p = e.data.payload || {};
    out.push({ id: typeof p.id === "number" ? p.id : -1, reason: String(p.reason || ""), message: String(p.message || ""), timestamp: e.timestamp || 0 });
  }
  return out;
}

/** Exact decoded byte length of a base64 string, without allocating the bytes. */
export function base64ByteLength(b64: string): number {
  if (!b64) return 0;
  const len = b64.length;
  let pad = 0;
  if (b64.charCodeAt(len - 1) === 61) pad++; // '='
  if (b64.charCodeAt(len - 2) === 61) pad++;
  return Math.max(0, (len * 3) / 4 - pad) | 0;
}

// A captured frame is "non-blank" by construction - the recorder skips fully-transparent reads and only
// ships a frame whose pixels changed. This floor is a coarse backstop: a real WebP/JPEG/PNG of actual
// content clears it easily, while an accidental empty encode would not.
export function isLikelyBlankFrame(frame: CanvasFrame, minBytes = 120): boolean {
  return frame.byteLength < minBytes;
}
