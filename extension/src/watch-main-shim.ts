// MAIN-world page-error / SPA-navigation shim for watch mode.
//
// It has to run in the page's own JS world: an isolated-world listener does not receive page script
// errors (verified - CDP saw an uncaught throw, a rejection and a console.error while an isolated
// listener saw none), and history.pushState/replaceState fire nothing an isolated listener can see.
//
// It is used two ways:
//  1. From vendor/bb-watch-main.js (watch-main-entry.ts), a MAIN-world content script registered at
//     document_start while a watch is active. That runs BEFORE any page script, so it hands this
//     function pristine copies of the primitives the relay needs (`p`) - a page cannot intercept them.
//  2. As an inline executeScript `func` (background.ts injectWatchMain) for documents that were
//     already open when the watch started. Then `p` is absent and the primitives are read at call
//     time, after page scripts ran: best-effort, see docs/WATCH.md.
//
// MUST be fully self-contained (no references outside the function): in case 2 it is serialized and
// evaluated in the page.
//
// The relay never exposes the channel secret to page code: the detail is a JSON string assembled from
// primitives (JSON.stringify on a primitive never consults toJSON), the CustomEvent init object defines every
// member as an own property (no inherited getter is consulted), and dispatch goes through a saved Reflect.apply rather
// than the page-patchable Function.prototype.call.
//
// PASSIVE (always): error / unhandledrejection listeners observe an error AFTER it has unwound, so
// they add no frame to the page's own stack traces. WRAPPING (mode === "calls" only): replacing
// console.error/warn DOES sit in the page's call path - opt-in by name for that reason.
export interface WatchMainPristine {
  Ev: typeof CustomEvent;
  dispatch: (this: EventTarget, ev: Event) => boolean;
  apply: typeof Reflect.apply;
  stringify: typeof JSON.stringify;
  create: typeof Object.create;
  defineProperty: typeof Object.defineProperty;
  win: Window;
}

export function bbWatchMainShim(mode: string, nonce: string, p?: WatchMainPristine): boolean {
  if (typeof nonce !== "string" || nonce.length < 16) return false;
  const P: WatchMainPristine = p ?? {
    Ev: CustomEvent,
    dispatch: EventTarget.prototype.dispatchEvent,
    apply: Reflect.apply,
    stringify: JSON.stringify,
    create: Object.create,
    defineProperty: Object.defineProperty,
    win: window,
  };
  const w = P.win as any;
  // Install state lives under a key derived from the per-document secret (hashed, so the visible key
  // does not reveal it): a page can't pre-set it to switch capture off, as it could a fixed flag.
  // Non-configurable so it can't be deleted to force a double install.
  let h = 2166136261;
  for (let i = 0; i < nonce.length; i++) h = Math.imul(h ^ nonce.charCodeAt(i), 16777619);
  const key = "__bbWM_" + (h >>> 0).toString(36);
  let st = Object.prototype.hasOwnProperty.call(w, key) ? w[key] : null;
  if (!st || typeof st !== "object") {
    st = P.create(null);
    st.main = false;
    st.hist = false;
    st.wrapped = false;
    try {
      P.defineProperty(w, key, { value: st, enumerable: false, configurable: false, writable: false });
    } catch {
      return false; // key squatted: refuse rather than double-install
    }
  }
  const type = "bb-watch-main:" + nonce;
  const S = (v: unknown): string => {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return P.apply(P.stringify, null, [v]) as string;
    return "null";
  };
  // fields: primitives only. Built by hand so no object carrying the secret is ever handed to code
  // the page could have patched.
  const relay = (fields: [string, unknown][]) => {
    try {
      let s = '{"n":' + S(nonce);
      for (let i = 0; i < fields.length; i++) s += "," + S(fields[i][0]) + ":" + S(fields[i][1]);
      s += "}";
      // Every CustomEventInit member as an OWN property: dictionary conversion only reads these four,
      // so a page-defined getter on Object.prototype is never consulted (and never sees the detail).
      // (A null-prototype init would also avoid that, but its `detail` is then unreadable from the
      // isolated world - verified - so the relay silently delivers nothing.)
      const ev = new P.Ev(type, { bubbles: false, cancelable: false, composed: false, detail: s });
      P.apply(P.dispatch, w, [ev]);
    } catch {
      /* drop rather than throw inside the page */
    }
  };
  const fmt = (args: any[]): string => {
    let out = "";
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let piece: string;
      if (typeof a === "string") piece = a;
      else if (a instanceof Error) piece = String(a.stack || a.message);
      else {
        try {
          piece = String(JSON.stringify(a)); // page objects: their own toJSON is fine, nothing secret here
        } catch {
          piece = String(a);
        }
      }
      out += (i ? " " : "") + piece;
      if (out.length > 500) break;
    }
    return out.slice(0, 500);
  };
  const wrapConsole = () => {
    if (st.wrapped) return;
    st.wrapped = true;
    for (const level of ["error", "warn"]) {
      const orig = (console as any)[level]?.bind(console);
      if (!orig) continue;
      (console as any)[level] = (...args: any[]) => {
        try {
          relay([["kind", "console"], ["level", level], ["text", fmt(args)]]);
        } catch {
          /* never break the page's own logging */
        }
        return orig(...args);
      };
    }
  };
  // SPA route changes are only observable from the MAIN world. `replace` is carried through so the
  // fold can leave a search-as-you-type burst intact instead of splitting it per keystroke.
  const patchHistory = () => {
    if (st.hist) return;
    st.hist = true;
    for (const m of ["pushState", "replaceState"] as const) {
      const orig = (history as any)[m];
      if (typeof orig !== "function") continue;
      (history as any)[m] = function (this: History, ...args: any[]) {
        const r = orig.apply(this, args);
        try {
          relay([["kind", "nav"], ["replace", m === "replaceState"]]);
        } catch {
          /* never break the page's navigation */
        }
        return r;
      };
    }
  };
  if (!st.main) {
    st.main = true;
    w.addEventListener("error", (e: any) => {
      relay([
        ["kind", "console"],
        ["level", "error"],
        ["text", String(e?.message ?? "").slice(0, 500)],
        ["src", typeof e?.filename === "string" ? e.filename : ""],
        ["line", typeof e?.lineno === "number" ? e.lineno : 0],
      ]);
    });
    w.addEventListener("unhandledrejection", (e: any) => {
      relay([["kind", "console"], ["level", "error"], ["text", "Unhandled rejection: " + fmt([e?.reason])]]);
    });
  }
  patchHistory();
  if (mode === "calls") wrapConsole();
  return true;
}
