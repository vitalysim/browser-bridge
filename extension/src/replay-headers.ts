// Pure, chrome-free header builder for replay_request / authz_matrix (runs in the service worker).
// Kept out of background.ts so it is unit-tested from Node (server/test/replay-headers.test.ts).
// Nothing here may touch `chrome`, `window` or `document`.

// Headers a fetch() caller can't (or mustn't) set: forbidden request headers, hop-by-hop headers,
// HTTP/2 pseudo-headers from CDP captures, and Origin/Referer (the browser derives Origin; Referer is
// passed as fetch's `referrer` instead).
const DROP = /^(:.*|cookie2?|host|content-length|connection|keep-alive|proxy-.*|sec-.*|transfer-encoding|upgrade|te|trailer|expect|date|via|origin|referer|accept-charset|accept-encoding|access-control-request-.*)$/i;

export function isReplayableHeader(name: string): boolean {
  return !!name && !DROP.test(name.trim());
}

export interface ReplayHeaderOpts {
  hasBody: boolean;
  /** "anon" (no credentials), a named identity, or null/undefined for the tab's own session. */
  identity?: string | null;
  /** The named identity's captured bearer (full Authorization value), if any. */
  bearer?: string | null;
}

/**
 * Build the replay's request headers: every captured header fetch() can set, then explicit overrides
 * (case-insensitive; a null/empty override removes the header), then identity. Under an identity
 * ('anon' or named) the base request's Authorization is NOT forwarded - it belongs to the session that
 * made the request - so authz checks really test the other identity; a named identity's bearer
 * replaces it, and an explicit override Authorization is kept. Content-Type is dropped without a body.
 */
export function buildReplayHeaders(
  base: Record<string, unknown> | null | undefined,
  overrides: Record<string, unknown> | null | undefined,
  opts: ReplayHeaderOpts
): { headers: Record<string, string>; referrer?: string } {
  const headers: Record<string, string> = {};
  let referrer: string | undefined;
  for (const [k, v] of Object.entries(base || {})) {
    const key = k.trim().toLowerCase();
    if (v == null) continue;
    if (key === "referer") {
      referrer = String(v);
      continue;
    }
    if (!isReplayableHeader(key)) continue;
    if (key === "content-type" && !opts.hasBody) continue;
    if (key === "authorization" && opts.identity) continue;
    headers[key] = String(v);
  }
  for (const [k, v] of Object.entries(overrides || {})) {
    const key = k.trim().toLowerCase();
    if (key === "referer") {
      referrer = v == null || v === "" ? undefined : String(v);
      continue;
    }
    if (!isReplayableHeader(key)) continue;
    if (v == null || v === "") delete headers[key];
    else headers[key] = String(v);
  }
  if (opts.identity && opts.identity !== "anon" && opts.bearer) headers["authorization"] = opts.bearer;
  return referrer ? { headers, referrer } : { headers };
}
