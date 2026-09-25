// Pure capture-export helpers, split out of tools.ts so they can be unit-tested without the MCP
// server or a live extension: HAR 1.2 assembly (with body-size accounting + an optional inline cap)
// and session-recording event parsing (string and streaming). No sockets, no browser.
import { createReadStream } from "fs";
import { createInterface } from "readline";

// Case-tolerant header lookup (CDP hands back lowercased names; ad-hoc rows may not).
const hget = (h: Record<string, string> | undefined, k: string): string | undefined =>
  h ? h[k] ?? h[k.toLowerCase()] ?? h[k.toUpperCase()] : undefined;

function harHeaders(obj: Record<string, string> | undefined): { name: string; value: string }[] {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}

// Build the HAR response `content`, honoring both capture-time truncation (the extension records
// {responseBodyTruncated, responseBodyOriginalLength}) and an optional export-time byte cap. `size`
// stays the REAL body size when known; `text` holds however much we inline. Returns whether the cap
// bit, so export_har can surface what it shortened rather than silently dropping bytes.
function harContent(r: any, maxBodyBytes?: number): { content: any; capped: boolean } {
  const mimeType = r.mimeType || "";
  const base64 = !!r.responseBodyBase64;
  let text: string | undefined = r.responseBody;
  // Real (pre-truncation) size when the capture recorded it, else the length we hold.
  const size = typeof r.responseBodyOriginalLength === "number" ? r.responseBodyOriginalLength : text ? text.length : 0;
  let capped = false;
  if (text != null && typeof maxBodyBytes === "number" && maxBodyBytes >= 0 && text.length > maxBodyBytes) {
    // Keep a base64 body decodable by cutting to a multiple of 4.
    text = base64 ? text.slice(0, Math.floor(maxBodyBytes / 4) * 4) : text.slice(0, maxBodyBytes);
    capped = true;
  }
  const content: any = { size, mimeType };
  if (text != null) {
    content.text = text;
    if (base64) content.encoding = "base64";
  }
  if (capped || r.responseBodyTruncated) {
    content.comment = `body truncated: original ${size} chars, inlined ${text ? text.length : 0}`;
  }
  return { content, capped };
}

// One HAR entry from a captured request row (net_get_requests shape). Returns {entry, capped} so the
// caller can tally how many bodies the export-time cap shortened.
export function harEntry(r: any, nowIso: string, maxBodyBytes?: number): { entry: any; capped: boolean } {
  let query: { name: string; value: string }[] = [];
  try {
    query = [...new URL(r.url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    /* relative/invalid url */
  }
  const reqHeaders = r.requestHeaders || {};
  const ct = hget(reqHeaders, "content-type") || "application/octet-stream";
  const { content, capped } = harContent(r, maxBodyBytes);
  const entry: any = {
    // Real request-start time when the capture row carries one (it does - background.ts
    // captureNetRow). Falling back to the export time is what every entry used to get, which made an
    // imported HAR's waterfall meaningless.
    startedDateTime: typeof r.ts === "number" ? new Date(r.ts).toISOString() : nowIso,
    time: 0,
    request: {
      method: r.method || "GET",
      url: r.url || "",
      httpVersion: "HTTP/1.1",
      headers: harHeaders(reqHeaders),
      queryString: query,
      cookies: [],
      headersSize: -1,
      bodySize: r.requestBody ? r.requestBody.length : 0,
    },
    response: {
      status: r.status || 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: harHeaders(r.responseHeaders),
      cookies: [],
      content,
      // A redirect hop carries its Location; fall back to the response header.
      redirectURL: r.redirectLocation || hget(r.responseHeaders || {}, "location") || "",
      headersSize: -1,
      bodySize: content.size || -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
  if (r.requestBody) entry.request.postData = { mimeType: ct, text: r.requestBody };
  return { entry, capped };
}

// Assemble the full HAR document and report how many bodies the inline cap shortened.
export function buildHar(
  rows: any[],
  creator: { name: string; version: string },
  nowIso: string,
  opts?: { maxBodyBytes?: number }
): { har: any; bodiesCapped: number } {
  let bodiesCapped = 0;
  const entries = rows.map((r) => {
    const { entry, capped } = harEntry(r, nowIso, opts?.maxBodyBytes);
    if (capped) bodiesCapped++;
    return entry;
  });
  return { har: { log: { version: "1.2", creator, entries } }, bodiesCapped };
}

// ---- session recording (rrweb) event parsing ----
// A recording is JSON-Lines of rows {kind:"rrweb", event}; we want the events, timestamp-sorted.

// Fold one JSONL line into the accumulator (ignores blanks, non-rrweb rows, and a torn last line).
export function foldSessionLine(events: any[], line: string): void {
  if (!line.trim()) return;
  try {
    const row = JSON.parse(line);
    if (row && row.kind === "rrweb" && row.event) events.push(row.event);
  } catch {
    /* skip a torn line */
  }
}

export function parseSessionEvents(jsonl: string): any[] {
  const events: any[] = [];
  for (const line of jsonl.split("\n")) foldSessionLine(events, line);
  events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return events;
}

// Same result as parseSessionEvents, but reads the file a line at a time instead of slurping the
// whole JSONL into a string and split()ing it - a canvas/long recording can be hundreds of MB.
export async function parseSessionEventsStream(path: string): Promise<any[]> {
  const events: any[] = [];
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) foldSessionLine(events, line);
  events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return events;
}
