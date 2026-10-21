// Loading (or first-run creating) the shared secret. The value is NEVER logged anywhere - only the
// path of the file that holds it.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { DIR_MODE, FILE_MODE } from "./datadir.js";

export class TokenError extends Error {}

export interface LoadTokenOptions {
  dir: string;
  env?: NodeJS.ProcessEnv;
}

/** Shortest token we accept. A generated token is 32 hex chars; this only rejects obvious mistakes. */
export const MIN_TOKEN_LENGTH = 16;

/**
 * BRIDGE_TOKEN (env) wins; otherwise ~/.browser-bridge/token; otherwise a fresh random token is written
 * there (0600). An empty/whitespace/too-short token is REFUSED (TokenError) rather than accepted: an
 * empty bearer would make `Authorization: Bearer ` a valid credential.
 */
export function loadToken({ dir, env = process.env }: LoadTokenOptions): string {
  if (env.BRIDGE_TOKEN !== undefined) {
    const t = env.BRIDGE_TOKEN.trim();
    if (t.length < MIN_TOKEN_LENGTH) {
      throw new TokenError(
        `BRIDGE_TOKEN is set but ${t ? `shorter than ${MIN_TOKEN_LENGTH} characters` : "empty"} - refusing to start. ` +
          `Unset it to use ${join(dir, "token")}, or set a long random value.`
      );
    }
    return t;
  }
  const file = join(dir, "token");
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw new TokenError(`cannot read ${file}: ${e?.code ?? e?.message ?? e}`);
  }
  if (raw === null) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const token = randomBytes(16).toString("hex");
    writeFileSync(file, token + "\n", { mode: FILE_MODE, flag: "wx" });
    return token;
  }
  const t = raw.trim();
  if (t.length < MIN_TOKEN_LENGTH) {
    throw new TokenError(
      `${file} is ${t ? `shorter than ${MIN_TOKEN_LENGTH} characters` : "empty"} - refusing to start. ` +
        `Delete it to have a new token generated (then paste the new one into the extension options), ` +
        `or run scripts/rotate-token.mjs.`
    );
  }
  return t;
}
