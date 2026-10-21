// Pure decision logic for download_resource's poll loop, kept out of tools.ts so it can be unit-tested
// without a browser. Each poll feeds the latest chrome.downloads item; the verdict says whether to keep
// waiting, finish, or fail fast with an actionable reason (instead of silently waiting out 10 minutes on
// a "dangerous file" prompt, a paused item, or a transfer that stopped moving).

export interface DownloadStatus {
  state?: string; // "in_progress" | "complete" | "interrupted"
  bytesReceived?: number;
  totalBytes?: number;
  danger?: string;
  paused?: boolean;
  error?: string;
}

export interface DownloadProgress {
  lastBytes: number;
  lastProgressAt: number;
}

export type DownloadVerdict =
  | { kind: "complete" }
  | { kind: "wait" }
  | { kind: "fail"; message: string; cancel: boolean };

// Danger values that mean "nothing is blocking": safe, the user accepted it, or policy/scans cleared it.
const OK_DANGER = new Set(["safe", "accepted", "deepScannedSafe", "deepScannedOpenedDangerous", "allowlistedByPolicy"]);
// Chrome is still scanning the finished bytes - legitimately no byte progress, keep waiting.
const SCANNING_DANGER = new Set(["asyncScanning", "asyncLocalPasswordScanning", "promptForScanning"]);

export const DEFAULT_STALL_MS = 30_000;

export function downloadVerdict(
  status: DownloadStatus,
  progress: DownloadProgress,
  opts: { now: number; cap?: number; stallMs?: number; downloadId?: number }
): DownloadVerdict {
  const id = opts.downloadId != null ? ` (downloadId ${opts.downloadId})` : "";
  if (status.state === "complete") return { kind: "complete" };
  if (status.state === "interrupted") {
    return { kind: "fail", message: `Download interrupted: ${status.error ?? "unknown reason"}`, cancel: false };
  }
  const received = status.bytesReceived ?? 0;
  const seen = (status.totalBytes ?? 0) > 0 ? status.totalBytes! : received;
  if (opts.cap && seen > opts.cap) {
    return { kind: "fail", message: `Download exceeded maxBytes (${opts.cap}); cancelled after ~${received} bytes.`, cancel: true };
  }
  const danger = status.danger;
  if (danger && !OK_DANGER.has(danger) && !SCANNING_DANGER.has(danger)) {
    return {
      kind: "fail",
      cancel: false,
      message:
        `Chrome flagged this download as potentially dangerous (danger: ${danger})${id} and is holding it until a ` +
        `human chooses Keep or Discard in the downloads bubble / chrome://downloads. It will not finish on its own.`,
    };
  }
  if (status.paused) {
    return {
      kind: "fail",
      cancel: false,
      message: `Download is paused${id} - resume it in chrome://downloads (it will not progress while paused).`,
    };
  }
  if (received > progress.lastBytes) {
    progress.lastBytes = received;
    progress.lastProgressAt = opts.now;
    return { kind: "wait" };
  }
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  if (danger && SCANNING_DANGER.has(danger)) return { kind: "wait" }; // scanning: no bytes expected
  if (stallMs > 0 && opts.now - progress.lastProgressAt > stallMs) {
    return {
      kind: "fail",
      cancel: false,
      message:
        `Download made no progress for ${Math.round(stallMs / 1000)}s${id} (${received} bytes received so far) - ` +
        `the server stopped sending or Chrome is waiting on a prompt. Check chrome://downloads, or raise stallTimeoutMs.`,
    };
  }
  return { kind: "wait" };
}
