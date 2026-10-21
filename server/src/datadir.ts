// The server's data home (~/.browser-bridge) holds the bearer token, the server log, captured network
// traffic (cookies, Authorization headers, response bodies), session recordings with cleartext form
// input, and watch digests. All of it must be readable by the owner only.
//
// Three layers:
//   1. process.umask(0o077) at startup (index.ts), so EVERY file/dir the server creates - including
//      ones under caller-chosen savePaths - is born 0600/0700 without each call site remembering a mode;
//   2. ensureDataDirs(): create the home + known subdirs with an explicit 0700;
//   3. tightenPermissions(): on startup, chmod what an older version (or another tool) left behind.
//      Async, best-effort, never throws: a permission fix must never stop the bridge from starting.
import { mkdirSync, chmodSync } from "fs";
import { readdir, lstat, chmod } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Subdirectories the server writes into. Only these are walked; anything else (e.g. a repo checkout
 *  someone keeps under ~/.browser-bridge) is left alone. */
export const KNOWN_SUBDIRS = ["playbooks", "recordings", "watch", "identities", "captures"] as const;

export function dataDir(home = homedir()): string {
  return join(home, ".browser-bridge");
}

/** Create the data home and the subdirs the server always uses, owner-only. Synchronous: it runs once
 *  before anything is written. Never throws. */
export function ensureDataDirs(dir = dataDir()): void {
  for (const d of [dir, join(dir, "playbooks"), join(dir, "recordings"), join(dir, "watch")]) {
    try {
      mkdirSync(d, { recursive: true, mode: DIR_MODE });
      chmodSync(d, DIR_MODE); // mkdir's mode is masked by umask and ignored for an existing dir
    } catch {
      /* best-effort */
    }
  }
}

export interface TightenReport {
  dirs: number;
  files: number;
  errors: number;
}

/**
 * chmod the data home + KNOWN_SUBDIRS to 0700 and the regular files directly inside them (and one level
 * deeper, e.g. a render's frame dir) to 0600. Symlinks are never followed or changed. Bounded depth, so
 * a huge tree costs one readdir per directory, not a full recursive walk.
 */
export async function tightenPermissions(dir = dataDir(), maxDepth = 2): Promise<TightenReport> {
  const report: TightenReport = { dirs: 0, files: 0, errors: 0 };

  const fixDir = async (d: string, depth: number): Promise<void> => {
    try {
      const st = await lstat(d);
      if (!st.isDirectory()) return;
      if ((st.mode & 0o777) !== DIR_MODE) {
        await chmod(d, DIR_MODE);
        report.dirs++;
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT") report.errors++;
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      report.errors++;
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = await lstat(p);
        if (st.isSymbolicLink()) continue;
        if (st.isFile()) {
          if ((st.mode & 0o777) !== FILE_MODE) {
            await chmod(p, FILE_MODE);
            report.files++;
          }
        } else if (st.isDirectory() && depth < maxDepth) {
          await fixDir(p, depth + 1);
        }
      } catch {
        report.errors++;
      }
    }
  };

  // The home itself: fix its own mode and its top-level FILES (token, server.log*, launchd.log), but
  // only descend into the subdirs we own.
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return report;
    if ((st.mode & 0o777) !== DIR_MODE) {
      await chmod(dir, DIR_MODE);
      report.dirs++;
    }
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      try {
        const s = await lstat(p);
        if (s.isFile() && (s.mode & 0o777) !== FILE_MODE) {
          await chmod(p, FILE_MODE);
          report.files++;
        }
      } catch {
        report.errors++;
      }
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") report.errors++;
    return report;
  }
  for (const sub of KNOWN_SUBDIRS) await fixDir(join(dir, sub), 1);
  return report;
}
