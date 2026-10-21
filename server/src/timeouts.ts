// Hub-timeout budgets for tools whose extension-side work scales with the input. Pure so they can be
// unit-tested. A hub timeout far above what the extension can legitimately need just makes a wedged
// call look like a hang to the agent.

/** Screenshot: the extension bounds each capture step (~10s) and falls back to CDP, so 30s is ample. */
export const SCREENSHOT_HUB_TIMEOUT_MS = 30_000;

/**
 * `input` (trusted CDP input). Every action is a handful of CDP commands except `type`, which sends two
 * key events per character plus an 8ms gap - so long text legitimately needs more than the base budget.
 */
export function inputHubTimeout(args: { action?: string; text?: string }): number {
  const base = 45_000;
  if (args.action === "type" && typeof args.text === "string") {
    return base + Array.from(args.text).length * 25;
  }
  return base;
}
