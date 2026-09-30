// Which MCP sessions are safe to drop. A client that exits without sending DELETE (killed CLI,
// crashed agent, short-lived subagent) never triggers transport.onclose, so its session - including a
// full copy of every registered tool, ~1.2MB of heap - would live for the whole process. Kept pure
// and separate from index.ts so the selection rules are unit-testable.

export interface SessionState {
  lastSeen: number; // ms epoch of the last request that touched this session
  inflight: number; // requests currently being handled; never reap these
}

export const SESSION_IDLE_MS = 60 * 60 * 1000; // 1h: longer than any human pause between turns
export const SESSION_MAX = 64; // backstop if something opens sessions faster than the TTL reaps them

/**
 * Session ids to close, given the current map. Idle-past-TTL first; then, if still over `max`,
 * the least-recently-seen idle sessions until the count fits. A session with work in flight is
 * never returned (a watch_read long-poll can legitimately sit open for ~25s).
 */
export function sessionsToReap(
  sessions: Map<string, SessionState>,
  now: number,
  idleMs: number = SESSION_IDLE_MS,
  max: number = SESSION_MAX
): string[] {
  const idle = [...sessions.entries()].filter(([, s]) => s.inflight === 0);
  const expired = idle.filter(([, s]) => now - s.lastSeen > idleMs).map(([id]) => id);
  const doomed = new Set(expired);
  if (sessions.size - doomed.size > max) {
    const overflow = idle
      .filter(([id]) => !doomed.has(id))
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      .slice(0, sessions.size - doomed.size - max)
      .map(([id]) => id);
    for (const id of overflow) doomed.add(id);
  }
  return [...doomed];
}
