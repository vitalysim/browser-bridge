// Opt-in retention for the two dirs that grow without bound: recordings/ (session replays, tens of MB
// each) and watch/ (watch digests + network JSONL). OFF by default - nothing is ever deleted unless the
// user sets BRIDGE_RETENTION_DAYS=<N>. Then, at startup and once a day, regular files (and render frame
// dirs) whose mtime is older than N days are removed. Only the direct children of those two dirs are
// considered; playbooks/, the token and the logs are never touched.
import { readdir, lstat, rm } from "fs/promises";
import { join } from "path";

export const RETENTION_DIRS = ["recordings", "watch"] as const;
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Parse BRIDGE_RETENTION_DAYS. Unset/empty/0/garbage -> null (retention off). */
export function parseRetentionDays(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export interface PruneResult {
  removed: string[];
  bytes: number;
  errors: number;
}

/**
 * Delete entries in `dataDir/{recordings,watch}` last modified more than `days` ago. Files that are
 * still being written have a fresh mtime and are therefore never eligible. Never throws.
 */
export async function pruneOld(dataDir: string, days: number, now = Date.now(), dirs: readonly string[] = RETENTION_DIRS): Promise<PruneResult> {
  const out: PruneResult = { removed: [], bytes: 0, errors: 0 };
  if (!(days > 0)) return out;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  for (const sub of dirs) {
    const dir = join(dataDir, sub);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // dir does not exist yet
    }
    for (const name of names) {
      const p = join(dir, name);
      try {
        const st = await lstat(p);
        if (st.mtimeMs >= cutoff) continue;
        if (st.isFile() || st.isSymbolicLink()) {
          await rm(p, { force: true });
          out.bytes += st.isFile() ? st.size : 0;
          out.removed.push(p);
        } else if (st.isDirectory()) {
          await rm(p, { recursive: true, force: true });
          out.removed.push(p);
        }
      } catch {
        out.errors++;
      }
    }
  }
  return out;
}

/** Run pruneOld now and every RETENTION_INTERVAL_MS (unref'd). Returns a stop function. */
export function scheduleRetention(dataDir: string, days: number, log: (m: string) => void): () => void {
  const run = () =>
    void pruneOld(dataDir, days).then((r) => {
      if (r.removed.length || r.errors)
        log(`[retention] removed ${r.removed.length} item(s) older than ${days}d from recordings/ + watch/ (${(r.bytes / 1048576).toFixed(1)} MB)${r.errors ? `, ${r.errors} error(s)` : ""}`);
    });
  run();
  const t = setInterval(run, RETENTION_INTERVAL_MS);
  t.unref();
  return () => clearInterval(t);
}
