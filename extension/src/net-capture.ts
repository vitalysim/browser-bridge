// Pure network-capture helpers, kept out of background.ts so they can be unit-tested without a
// service worker: the bounded request ring (with a requestId index and redirect-hop handling), the
// response-body truncation rule, and a concurrency semaphore. No chrome/DOM references live here.

export interface NetEntry {
  requestId: string;
  method?: string;
  url?: string;
  type?: string;
  status?: number;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  timing?: any;
  finished?: boolean;
  failed?: string;
  // For a redirect hop: the Location it pointed at (from its redirectResponse). Distinguishes a hop
  // that was finalized by the NEXT requestWillBeSent from a request still awaiting its response.
  redirectLocation?: string;
  ts?: number;
}

// A bounded ring of captured requests with O(1) requestId lookup.
//
// Two properties the old plain-array + Array.find/Array.shift approach got wrong on a busy page:
//   - lookup: find/shift were O(n) and maxEntries can be 5000, so every CDP event was O(n) and a
//     load was O(n^2). The index makes get() O(1); a head pointer makes eviction O(1) amortized.
//   - redirects: CDP re-fires Network.requestWillBeSent with the SAME requestId per hop, so one
//     requestId maps to several entries. The index resolves to the LATEST hop (what responseReceived
//     / loadingFinished / loadingFailed must attach to), while earlier hops stay as their own
//     finalized entries. Array.find returned the FIRST hop, so the final status landed on hop 1 and
//     the intermediate hops never got one.
export class NetRing {
  // Backing store; live entries are buf[head..]. Never Array.shift (O(n)); advance head instead and
  // compact the dead prefix in amortized O(1).
  private buf: NetEntry[] = [];
  private head = 0;
  private index = new Map<string, NetEntry>(); // requestId -> latest live hop
  max: number;

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  get size(): number {
    return this.buf.length - this.head;
  }

  // Append a new entry (or a fresh redirect hop). Evicts the oldest live entry when at cap and
  // returns the requestId that thereby became fully gone from the ring (so the caller can drop its
  // side-data), or undefined. A requestId with a later live hop is NOT reported as gone.
  push(e: NetEntry): string | undefined {
    let evicted: string | undefined;
    if (this.size >= this.max) evicted = this.evictOldest();
    this.buf.push(e);
    this.index.set(e.requestId, e); // becomes the latest hop for this requestId
    return evicted;
  }

  private evictOldest(): string | undefined {
    const old = this.buf[this.head];
    this.head++;
    // Reclaim the dead prefix once it dominates, so buf can't grow without bound.
    if (this.head > 32 && this.head * 2 > this.buf.length) {
      this.buf = this.buf.slice(this.head);
      this.head = 0;
    }
    if (!old) return undefined;
    // Only forget the index / report the requestId as gone when THIS entry is still the one it points
    // at. A newer redirect hop that reused the id keeps both alive.
    if (this.index.get(old.requestId) === old) {
      this.index.delete(old.requestId);
      return old.requestId;
    }
    return undefined;
  }

  // Latest hop for a requestId, or undefined. O(1).
  get(requestId: string): NetEntry | undefined {
    return this.index.get(requestId);
  }

  // Live entries, oldest -> newest. A fresh array (callers filter/slice it freely).
  list(): NetEntry[] {
    return this.buf.slice(this.head);
  }
}

// Finalize the hop that a redirect just completed: stamp its status/headers/timing and the Location
// it redirected to. `fallbackLocation` is the next hop's URL, used when the response omits Location.
export function applyRedirectResponse(prev: NetEntry | undefined, redirectResponse: any, fallbackLocation?: string): void {
  if (!prev || !redirectResponse) return;
  prev.status = redirectResponse.status;
  prev.mimeType = redirectResponse.mimeType;
  prev.responseHeaders = redirectResponse.headers;
  prev.timing = redirectResponse.timing;
  prev.finished = true;
  const h = redirectResponse.headers || {};
  prev.redirectLocation = h.location ?? h.Location ?? fallbackLocation;
}

export interface BodyResult {
  body: string;
  base64: boolean;
  truncated?: boolean;
  originalLength?: number; // original char length, present only when truncated
}

// Cap a captured body to `cap` chars, reporting truncation as structured fields instead of appending
// a marker string. A base64 body is cut to a multiple of 4 chars so it stays decodable (the old code
// appended "…[truncated]", corrupting the base64).
export function capBody(raw: string, base64: boolean, cap = 512 * 1024): BodyResult {
  const s = typeof raw === "string" ? raw : "";
  if (s.length <= cap) return { body: s, base64 };
  const keep = base64 ? Math.floor(cap / 4) * 4 : cap;
  return { body: s.slice(0, keep), base64, truncated: true, originalLength: s.length };
}

// A tiny async concurrency limiter: run() waits for a free slot, so at most `max` fns run at once.
// Bounds eager Network.getResponseBody fetches on an asset-heavy page (each buffers the whole body in
// the worker); without it every loadingFinished fires a fetch at once and spikes worker memory.
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private max: number) {
    this.max = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot straight to a waiter (active count unchanged)
    else this.active--;
  }
}
