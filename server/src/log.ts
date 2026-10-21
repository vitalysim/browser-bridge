// Tiny stderr logger. launchd persists stderr to ~/.browser-bridge/server.log indefinitely, and before
// this every line was untimed, so a failure could not be placed in time or measured. Two jobs:
//   - log(): prefix any server line with an ISO timestamp (message otherwise unchanged);
//   - formatCallLine(): one compact line per tool call - name, tabId, duration, outcome, short error.
// Params are NEVER logged: they can carry secrets, cookies, file contents and typed passwords.

export type CallOutcome = "ok" | "error" | "notActionable";

export function log(message: string, now: Date = new Date()): void {
  console.error(`${now.toISOString()} ${message}`);
}

const MAX_DETAIL = 200;

/** Collapse to one line and cap at 200 chars, so one call is always exactly one log line. */
export function shortDetail(s: string, max = MAX_DETAIL): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export interface CallLogEntry {
  tool: string;
  tabId?: unknown;
  ms: number;
  outcome: CallOutcome;
  detail?: string;
}

export function formatCallLine(e: CallLogEntry, now: Date = new Date()): string {
  const parts = [now.toISOString(), "[call]", e.tool];
  // Only a numeric tabId is logged - never echo an arbitrary caller-supplied value.
  if (typeof e.tabId === "number" && Number.isFinite(e.tabId)) parts.push(`tab=${e.tabId}`);
  parts.push(`${Math.round(e.ms)}ms`, e.outcome);
  if (e.detail) parts.push(shortDetail(e.detail));
  return parts.join(" ");
}

export function logCall(e: CallLogEntry): void {
  console.error(formatCallLine(e));
}
