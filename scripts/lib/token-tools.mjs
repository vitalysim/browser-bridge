// Helpers for scripts/rotate-token.mjs and scripts/scrub-log.mjs. Everything takes explicit paths so
// it can be tested on fixtures (server/test/token-tools.test.ts). No function here ever prints or
// returns a token value in a report.
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, chmodSync, createReadStream, createWriteStream, readdirSync, unlinkSync, openSync, closeSync, realpathSync } from "fs";
import { createInterface } from "readline";
import { join, dirname, basename } from "path";

export function newToken() {
  return randomBytes(16).toString("hex");
}

export function readTokenFile(path) {
  try {
    const t = readFileSync(path, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Write `content` to `path` atomically (temp file in the same dir + rename), owner-only. If `path` is a
 * symlink (dotfiles managers), the link's TARGET is replaced, so the symlink itself survives.
 */
export function atomicWrite(path, content, mode = 0o600) {
  let target = path;
  try {
    target = realpathSync(path);
  } catch {
    /* doesn't exist yet: write it where asked */
  }
  path = target;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Rotate the token in `dataDir`: the current one is kept as token.prev (0600) for rollback, the new
 * one is written atomically to token (0600). Returns {oldToken, newToken} for the caller to use (never
 * to print).
 */
export function rotateTokenFile(dataDir, token = newToken()) {
  const file = join(dataDir, "token");
  const oldToken = readTokenFile(file);
  if (oldToken) atomicWrite(join(dataDir, "token.prev"), oldToken + "\n");
  atomicWrite(file, token + "\n");
  return { oldToken, newToken: token };
}

const isBridgeEntry = (name) => /browser[-_ ]?bridge/i.test(name);

/**
 * Find browser-bridge MCP entries in a parsed ~/.claude.json (top-level `mcpServers` and every
 * `projects[path].mcpServers`) whose Authorization header is literally `Bearer <oldToken>`.
 * Mutates `json` when `newToken` is given. Returns a report WITHOUT token values.
 */
export function rewriteClaudeConfig(json, oldToken, newToken) {
  const changed = [];
  const envBased = [];
  const visit = (servers, where) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== "object" || !isBridgeEntry(name)) continue;
      const headers = cfg.headers;
      if (!headers || typeof headers !== "object") continue;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== "authorization") continue;
        const v = headers[key];
        if (typeof v !== "string") continue;
        if (oldToken && v === `Bearer ${oldToken}`) {
          changed.push(`${where}.mcpServers["${name}"].headers.${key}`);
          if (newToken) headers[key] = `Bearer ${newToken}`;
        } else if (/\$\{?[A-Z_][A-Z0-9_]*\}?/.test(v)) {
          envBased.push(`${where}.mcpServers["${name}"] (uses an environment variable)`);
        }
      }
    }
  };
  visit(json?.mcpServers, "(user)");
  for (const [path, proj] of Object.entries(json?.projects ?? {})) visit(proj?.mcpServers, `projects["${path}"]`);
  return { changed, envBased };
}

function detectIndent(text) {
  const m = /^\{\s*\n([ \t]+)"/.exec(text);
  return m ? m[1] : 2;
}

/**
 * Apply rewriteClaudeConfig to a file. With dryRun, nothing is written. Otherwise a `.bak` copy of the
 * original is written first (0600), then the file is replaced atomically keeping its mode.
 */
export function updateClaudeConfigFile(path, oldToken, newToken, { dryRun = false } = {}) {
  if (!existsSync(path)) return { path, exists: false, changed: [], envBased: [] };
  const text = readFileSync(path, "utf8");
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { path, exists: true, error: `not valid JSON (${e.message}) - left untouched`, changed: [], envBased: [] };
  }
  const report = rewriteClaudeConfig(json, oldToken, dryRun ? null : newToken);
  if (!dryRun && report.changed.length) {
    // Running Claude Code processes rewrite this file too. Re-read it right before writing and apply the
    // same edit to the fresh copy, so a concurrent change made since the first read is not lost.
    let fresh = text;
    let freshJson = json;
    try {
      fresh = readFileSync(path, "utf8");
      if (fresh !== text) {
        freshJson = JSON.parse(fresh);
        rewriteClaudeConfig(freshJson, oldToken, newToken);
      }
    } catch {
      fresh = text;
      freshJson = json;
    }
    const mode = statSync(path).mode & 0o777;
    atomicWrite(`${path}.bak`, fresh, 0o600);
    atomicWrite(path, JSON.stringify(freshJson, null, detectIndent(fresh)) + (fresh.endsWith("\n") ? "\n" : ""), mode || 0o600);
  }
  return { path, exists: true, ...report, backup: !dryRun && report.changed.length ? `${path}.bak` : undefined };
}

/**
 * Text configs that hold the token as a literal `Bearer <token>` header (e.g. ~/.codex/config.toml's
 * `http_headers = { "Authorization" = "Bearer …" }`, which Codex re-reads on every launch, unlike an env
 * var captured by a long-lived shell). Replaces every `Bearer <old>` with `Bearer <new>`; never prints
 * either value. Writes a 0600 .bak copy first and keeps the file's mode (and a symlink stays a symlink).
 */
export function updateTextConfigFile(path, oldToken, newToken, { dryRun = false } = {}) {
  if (!existsSync(path)) return { path, exists: false, replaced: 0 };
  if (!oldToken) return { path, exists: true, replaced: 0 };
  const text = readFileSync(path, "utf8");
  const needle = `Bearer ${oldToken}`;
  const replaced = text.split(needle).length - 1;
  if (!dryRun && replaced) {
    const fresh = readFileSync(path, "utf8"); // narrow the race with a running client rewriting it
    const mode = statSync(path).mode & 0o777;
    atomicWrite(`${path}.bak`, fresh, 0o600);
    atomicWrite(path, fresh.split(needle).join(`Bearer ${newToken}`), mode || 0o600);
  }
  return { path, exists: true, replaced, backup: !dryRun && replaced ? `${path}.bak` : undefined };
}

/** server.log, server.log.1 …, launchd.log in `dataDir`. */
export function logFiles(dataDir) {
  let names = [];
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^server\.log(\.\d+)?$/.test(n) || /^launchd\.log$/.test(n))
    .sort()
    .map((n) => join(dataDir, n));
}

/**
 * Remove every line containing any of `secrets` from `path`, in place (streamed to a temp file, then
 * renamed over the original, 0600). With dryRun only counts. Returns {lines, removed}.
 */
export async function scrubFile(path, secrets, { dryRun = false } = {}) {
  const needles = secrets.filter((s) => typeof s === "string" && s.length >= 8);
  if (!needles.length) throw new Error("no usable secret to scrub for");
  const tmp = join(dirname(path), `.${basename(path)}.scrub.${process.pid}.tmp`);
  const out = dryRun ? null : createWriteStream(tmp, { mode: 0o600, flags: "wx" });
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lines = 0;
  let removed = 0;
  try {
    for await (const line of rl) {
      lines++;
      if (needles.some((n) => line.includes(n))) {
        removed++;
        continue;
      }
      if (out && !out.write(line + "\n")) await new Promise((r) => out.once("drain", r));
    }
  } catch (e) {
    if (out) {
      out.destroy();
      try {
        unlinkSync(tmp);
      } catch {}
    }
    throw e;
  }
  if (out) {
    await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
    if (removed) {
      chmodSync(tmp, 0o600); // logs are owner-only regardless of what the original had
      renameSync(tmp, path);
    } else unlinkSync(tmp);
  }
  return { path, lines, removed };
}
