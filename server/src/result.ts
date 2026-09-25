// Pure result-shaping helpers, kept out of tools.ts so they can be unit-tested without a browser,
// a socket, or the MCP SDK. Two jobs: classify an error into a stable machine code, and truncate an
// oversized result WITHOUT producing invalid JSON an agent can't parse.

export type ErrorCode =
  | "TIMEOUT"
  | "NO_EXTENSION"
  | "TAB_NOT_FOUND"
  | "NOT_SCRIPTABLE"
  | "CSP_BLOCKED"
  | "RESULT_TOO_LARGE"
  | "UNKNOWN";

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "TIMEOUT",
  "NO_EXTENSION",
  "TAB_NOT_FOUND",
  "NOT_SCRIPTABLE",
  "CSP_BLOCKED",
  "RESULT_TOO_LARGE",
  "UNKNOWN",
]);

/**
 * Map an error to a stable code the agent can branch on, keeping the human message separate.
 * An explicit `err.code` (set by the hub from the extension's structured error) wins; otherwise the
 * message text is matched. The match order matters where phrases could overlap (e.g. CSP's "refused
 * to connect" vs. the not-connected message).
 */
export function classifyError(err: unknown): ErrorCode {
  const explicit = (err as any)?.code;
  if (typeof explicit === "string" && KNOWN_CODES.has(explicit)) return explicit as ErrorCode;
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg) return "UNKNOWN";
  if (/result too large|result_too_large/.test(msg)) return "RESULT_TOO_LARGE";
  if (/timed out|timeout/.test(msg)) return "TIMEOUT";
  if (/is not connected|not connected|disconnected before responding|no extension/.test(msg)) return "NO_EXTENSION";
  if (/no tab with id|no active tab|no tab found|tab .*not found/.test(msg)) return "TAB_NOT_FOUND";
  if (/cannot script this page|browser-internal|off-limits|not scriptable|cannot be scripted/.test(msg))
    return "NOT_SCRIPTABLE";
  if (/content security policy|\bcsp\b|refused to (connect|load|execute|frame)|blocked by/.test(msg))
    return "CSP_BLOCKED";
  return "UNKNOWN";
}

export interface Truncation {
  text: string;
  truncated: boolean;
}

const HINT = "narrow with limit/filter";

// Largest k in [0,n] for which build(k) fits maxChars, by binary search. Returns null when even the
// zero-item envelope is over budget (the caller then falls back to a prefix preview). `build` may
// mutate scratch state; the returned value is always a fresh build(lo), so the final state is correct.
function fitArray(build: (k: number) => string, n: number, maxChars: number): string | null {
  if (build(0).length > maxChars) return null;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

// Structure-aware trim: a top-level array, or the largest array-valued property of an object, has its
// trailing items dropped until the whole thing fits. Returns valid JSON, or null when there is no
// array to trim (the caller falls back to a prefix preview).
function truncateArrayPayload(value: unknown, maxChars: number): string | null {
  if (Array.isArray(value)) {
    return fitArray(
      (k) =>
        JSON.stringify(
          { truncated: true, returned: k, total: value.length, hint: HINT, items: value.slice(0, k) },
          null,
          2
        ),
      value.length,
      maxChars
    );
  }
  if (value && typeof value === "object") {
    let field: string | null = null;
    let size = -1;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const s = JSON.stringify(v).length;
        if (s > size) {
          size = s;
          field = k;
        }
      }
    }
    if (field == null) return null;
    const arr = (value as any)[field] as unknown[];
    const rest = { ...(value as Record<string, unknown>) };
    return fitArray(
      (k) => {
        rest[field!] = arr.slice(0, k);
        return JSON.stringify(
          { ...rest, truncated: true, returned: k, total: arr.length, truncatedField: field, hint: HINT },
          null,
          2
        );
      },
      arr.length,
      maxChars
    );
  }
  return null;
}

/**
 * Turn any tool value into text that fits `maxChars` and is ALWAYS parseable:
 *  - a short value passes through unchanged;
 *  - a large array (or object holding one) is trimmed item-by-item into a valid-JSON envelope with
 *    {truncated, returned, total, hint};
 *  - any other oversized JSON falls back to a valid-JSON wrapper around a prefix preview;
 *  - a plain oversized string (not JSON to begin with) gets a clean cut plus an explicit flag.
 */
export function truncateForText(value: unknown, maxChars: number): Truncation {
  if (typeof value === "string") {
    if (value.length <= maxChars) return { text: value, truncated: false };
    const keep = Math.max(0, maxChars - 60);
    return { text: value.slice(0, keep) + `\n…[truncated: ${keep} of ${value.length} chars]`, truncated: true };
  }
  const full = JSON.stringify(value, null, 2);
  if (full.length <= maxChars) return { text: full, truncated: false };

  const arrayCut = truncateArrayPayload(value, maxChars);
  if (arrayCut) return { text: arrayCut, truncated: true };

  const budget = Math.max(0, maxChars - 200);
  const text = JSON.stringify(
    {
      truncated: true,
      bytes: full.length,
      hint: HINT,
      note: "result too large; showing a prefix of the JSON",
      preview: full.slice(0, budget),
    },
    null,
    2
  );
  return { text, truncated: true };
}
