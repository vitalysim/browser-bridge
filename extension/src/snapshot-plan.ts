// Pure (DOM-free) planning helpers for snapshot / ax_snapshot / selector targeting. They run in the
// service worker, never in the page, so they may be imported normally. Kept pure and dependency-free
// so server/test can unit-test them directly (no browser needed).

/** Hard ceiling on refs per snapshot (all frames together). Refs stay far below DEEP_REF_BASE. */
export const SNAPSHOT_MAX_LIMIT = 2000;
export const SNAPSHOT_DEFAULT_LIMIT = 400;

export function clampLimit(limit: unknown): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : SNAPSHOT_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SNAPSHOT_MAX_LIMIT, n));
}

/**
 * Split a total ref budget across frames. counts[0] is the TOP frame; the rest are child frames in
 * document order. Child frames get a reserved share (together at most half the budget) so a big top
 * page can't starve them, the top frame gets what's left, and any budget a frame can't use is then
 * water-filled to frames that still have demand. Never allocates more than a frame's count, and the
 * sum never exceeds `limit`.
 */
export function allocateFrameBudgets(counts: number[], limit: number): number[] {
  const n = counts.length;
  const want = counts.map((c) => Math.max(0, Math.floor(c || 0)));
  const a = new Array<number>(n).fill(0);
  if (n === 0 || limit <= 0) return a;
  const kids = n - 1;
  if (kids > 0) {
    const kidPool = Math.floor(limit / 2);
    const per = Math.max(1, Math.floor(kidPool / kids));
    let used = 0;
    for (let i = 1; i < n && used < kidPool; i++) {
      const g = Math.min(want[i], per, kidPool - used);
      a[i] = g;
      used += g;
    }
  }
  const sum = () => a.reduce((s, x) => s + x, 0);
  a[0] = Math.min(want[0], Math.max(0, limit - sum()));
  let rem = limit - sum();
  // Water-fill the remainder (top frame first in each round, so leftovers favour the page itself).
  while (rem > 0) {
    const needy: number[] = [];
    for (let i = 0; i < n; i++) if (a[i] < want[i]) needy.push(i);
    if (!needy.length) break;
    const share = Math.max(1, Math.floor(rem / needy.length));
    for (const i of needy) {
      const g = Math.min(share, want[i] - a[i], rem);
      a[i] += g;
      rem -= g;
      if (rem <= 0) break;
    }
  }
  return a;
}

/** Cumulative ref offsets for per-frame budgets: frame i's refs are offset[i]+1 .. offset[i]+budget[i]. */
export function frameOffsets(budgets: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const b of budgets) {
    out.push(acc);
    acc += b;
  }
  return out;
}

export interface RefRoute {
  frameId: number;
  lo: number;
  hi: number;
}

/** Which frame owns `ref` in the current snapshot (null = the ref isn't from the current snapshot). */
export function routeRef(routes: RefRoute[], ref: number): number | null {
  for (const r of routes) if (ref >= r.lo && ref <= r.hi) return r.frameId;
  return null;
}

/**
 * The ax walker marks every interactive node with `pi` (its priority rank among the frame's
 * interactive nodes). Turn ranks < keep into refs (offset + pi + 1) and strip every `pi`.
 * Returns how many refs were assigned. Mutates the tree in place.
 */
export function assignAxRefs(nodes: any[] | null | undefined, offset: number, keep: number): number {
  let assigned = 0;
  const visit = (list: any[]) => {
    for (const n of list) {
      if (n && typeof n.pi === "number") {
        if (n.pi < keep) {
          n.ref = offset + n.pi + 1;
          assigned++;
        }
        delete n.pi;
      }
      if (n && Array.isArray(n.children)) visit(n.children);
    }
  };
  if (nodes) visit(nodes);
  return assigned;
}

export interface LocateMatch {
  frameId: number;
  index: number; // position among this frame's matches, in deep (shadow-aware) document order
  visible: boolean;
  inViewport: boolean;
}

/**
 * Choose ONE element for a selector that may match in several frames / several times per frame.
 * Preference: visible over hidden, then the top frame, then in-viewport, then frame order, then
 * document order. `matches` must be in frame order (top frame first).
 */
export function pickSelectorTarget(matches: LocateMatch[]): { chosen: LocateMatch | null; count: number; frames: number; note?: string } {
  if (!matches.length) return { chosen: null, count: 0, frames: 0 };
  const order = new Map<number, number>();
  for (const m of matches) if (!order.has(m.frameId)) order.set(m.frameId, order.size);
  const ranked = matches.slice().sort((x, y) => {
    if (x.visible !== y.visible) return x.visible ? -1 : 1;
    const xt = x.frameId === 0, yt = y.frameId === 0;
    if (xt !== yt) return xt ? -1 : 1;
    if (x.inViewport !== y.inViewport) return x.inViewport ? -1 : 1;
    const fo = order.get(x.frameId)! - order.get(y.frameId)!;
    if (fo) return fo;
    return x.index - y.index;
  });
  const chosen = ranked[0];
  const count = matches.length;
  const frames = order.size;
  let note: string | undefined;
  if (count > 1) {
    const where = chosen.frameId === 0 ? "the top frame" : `frame ${chosen.frameId}`;
    const vis = chosen.visible ? (chosen.inViewport ? "visible, in viewport" : "visible, offscreen") : "hidden";
    note =
      `selector matched ${count} elements` +
      (frames > 1 ? ` across ${frames} frames` : "") +
      `; acted on match #${chosen.index} in ${where} (${vis}). Use a more specific selector or a snapshot ref to target another.`;
  }
  return { chosen, count, frames, note };
}
