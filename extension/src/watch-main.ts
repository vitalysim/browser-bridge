// Watch-mode MAIN-world shim.
//
// Two things live only in the page's own JS world and are invisible from an isolated content script:
// the page's `console` object, and its calls to history.pushState/replaceState. This script patches
// both and relays over a CustomEvent to watch-entry.ts (ISOLATED), which owns the buffering and the
// service-worker channel.
//
// Registered only when watch_start is called with console:true, and it is the one part of watch mode
// that modifies page globals — kept as small and as reversible as possible for that reason.

(() => {
  const w = window as any;
  if (w.__bbWatchMain) return;
  w.__bbWatchMain = 1;

  // detail is a STRING: a structured-clone object created here is not reliably readable from the
  // isolated world, where it silently arrives as undefined.
  const relay = (obj: any) => {
    try {
      window.dispatchEvent(new CustomEvent("bb-watch-main", { detail: JSON.stringify(obj) }));
    } catch {
      /* detail not serializable — drop this one rather than throwing inside the page's own call */
    }
  };

  const fmt = (args: any[]): string =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ")
      .slice(0, 500);

  // ---- console ----
  for (const level of ["error", "warn"] as const) {
    const orig = console[level]?.bind(console);
    if (!orig) continue;
    console[level] = (...args: any[]) => {
      try {
        relay({ kind: "console", level, text: fmt(args) });
      } catch {
        /* never let instrumentation break the page's own logging */
      }
      return orig(...args);
    };
  }

  window.addEventListener("error", (e) => {
    relay({ kind: "console", level: "error", text: String(e.message ?? "").slice(0, 500), src: e.filename, line: e.lineno });
  });

  window.addEventListener("unhandledrejection", (e: any) => {
    const r = e?.reason;
    relay({ kind: "console", level: "error", text: "Unhandled rejection: " + fmt([r]) });
  });

  // ---- SPA navigation ----
  // The whole reason watch mode sees SPA routes instantly: there is no new document, so nothing else
  // fires. popstate/hashchange (handled in the isolated world) only cover back/forward and fragments.
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = history[m];
    if (typeof orig !== "function") continue;
    history[m] = function (this: History, ...args: any[]) {
      const out = (orig as any).apply(this, args);
      try {
        relay({ kind: "nav" });
      } catch {
        /* ignore */
      }
      return out;
    } as any;
  }
})();
