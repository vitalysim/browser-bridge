// Single injected find-and-act helper. Serialized and run IN THE PAGE (ISOLATED world), so it must
// be FULLY self-contained: no references to module-scope helpers (esbuild would leave dangling
// names). Failure is signalled by RETURNING { error } / { notFound } / { staleRef } - never by
// throwing, because Chrome swallows exceptions thrown inside executeScript and resolves with null.
//
// This is the ONE copy of the deep-find + ref-resolution logic that click/fill/hover/type,
// file_upload, paste_image and the trusted-paste locate all share, so the callers can't drift.
// `op` selects the action; `p` bundles its args (nulls, never undefined - executeScript rejects
// undefined in the args array).
//
// It is async: executeScript awaits the returned promise (used to let a scroll settle before
// measuring). Anything that runs PAGE handlers which might block (alert/confirm in a click handler)
// is deferred with setTimeout(0) so the injected function has already returned by then.
//
// Pure (DOM-free) helpers live in the `L` object at the top; `bbAct("__logic", {})` returns it so
// Node tests can exercise them (server/test/interaction.test.ts). Never called that way in a page.

export interface BbActParams {
  ref?: number | null;
  sel?: string | null;
  value?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  b64?: string | null;
  method?: string | null;
  // op "key": the normalized key press (from act-logic.ts parseKeyCombo)
  keyInit?: { key: string; code: string; vk: number; shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } | null;
  // With sel: act on the nth match (0-based) in deep document order - element, then its open shadow
  // root, then onward (the same order background.ts bbLocateAll indexes). Set by actAllFrames after
  // it picked one match across frames.
  nth?: number | null;
}

export interface RefFingerprint {
  tag: string;
  role: string;
  name: string;
}

export async function bbAct(op: string, p: BbActParams): Promise<any> {
  // ================= pure helpers (no DOM; unit-tested via op "__logic") =================
  const norm = (s: any): string => String(s ?? "").replace(/\s+/g, " ").trim();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const L = {
    norm,
    // "true/false/on/off/checked/unchecked/yes/no/1/0" → boolean, else null
    parseBool(v: any): boolean | null {
      const s = norm(v).toLowerCase();
      if (["true", "on", "checked", "check", "yes", "y", "1", "selected"].includes(s)) return true;
      if (["false", "off", "unchecked", "uncheck", "no", "n", "0", "", "unselected"].includes(s)) return false;
      return null;
    },
    // multi-select value: a JSON array string, else a comma list
    splitMulti(v: any): string[] {
      const s = String(v ?? "").trim();
      if (s.startsWith("[")) {
        try {
          const a = JSON.parse(s);
          if (Array.isArray(a)) return a.map((x) => String(x));
        } catch {}
      }
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    },
    // option match: exact value, then exact text, then case-insensitive trimmed text, then ci value
    matchOption(opts: { value: string; text: string }[], want: string): number {
      let i = opts.findIndex((o) => o.value === want);
      if (i >= 0) return i;
      const w = norm(want);
      i = opts.findIndex((o) => norm(o.text) === w);
      if (i >= 0) return i;
      const lw = w.toLowerCase();
      i = opts.findIndex((o) => norm(o.text).toLowerCase() === lw);
      if (i >= 0) return i;
      return opts.findIndex((o) => norm(o.value).toLowerCase() === lw);
    },
    // Normalize a value for <input type=date|datetime-local|time|month|week>: ISO passes through,
    // anything else is parsed (Date / 12h clock) and formatted to the input's wire format.
    // "" clears. null = unparseable.
    normDate(type: string, raw: any): string | null {
      const s = String(raw ?? "").trim();
      if (!s) return "";
      const iso: Record<string, RegExp> = {
        date: /^\d{4}-\d{2}-\d{2}$/,
        "datetime-local": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/,
        time: /^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/,
        month: /^\d{4}-\d{2}$/,
        week: /^\d{4}-W\d{2}$/,
      };
      if (iso[type]?.test(s)) return s;
      if (type === "datetime-local" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
        return L.normDate(type, s.replace(" ", "T"));
      }
      if (type === "week" && /^\d{4}-w\d{2}$/i.test(s)) return s.toUpperCase();
      // an ISO-ish prefix (e.g. a full timestamp given to a date field) - take the prefix as written,
      // rather than round-tripping through Date and possibly shifting the day across time zones
      const pre = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
      if (pre && type === "date") return `${pre[1]}-${pre[2]}-${pre[3]}`;
      if (pre && type === "month") return `${pre[1]}-${pre[2]}`;
      if (pre && type === "datetime-local" && pre[4]) return `${pre[1]}-${pre[2]}-${pre[3]}T${pre[4]}:${pre[5]}`;
      if (type === "time") {
        const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap])\.?\s*m?\.?$/i.exec(s) || /^(\d{1,2}):(\d{2})(?::(\d{2}))?()$/.exec(s);
        if (m) {
          let h = Number(m[1]);
          const mi = Number(m[2] ?? 0);
          const se = m[3] != null && m[3] !== "" ? Number(m[3]) : null;
          const ap = (m[4] || "").toLowerCase();
          if (ap === "p" && h < 12) h += 12;
          if (ap === "a" && h === 12) h = 0;
          if (h > 23 || mi > 59 || (se != null && se > 59)) return null;
          return `${pad(h)}:${pad(mi)}` + (se != null ? `:${pad(se)}` : "");
        }
      }
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;
      const Y = pad(d.getFullYear(), 4), M = pad(d.getMonth() + 1), D = pad(d.getDate());
      const hh = pad(d.getHours()), mm = pad(d.getMinutes());
      if (type === "date") return `${Y}-${M}-${D}`;
      if (type === "month") return `${Y}-${M}`;
      if (type === "datetime-local") return `${Y}-${M}-${D}T${hh}:${mm}`;
      if (type === "time") return `${hh}:${mm}`;
      if (type === "week") {
        const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        const day = t.getUTCDay() || 7;
        t.setUTCDate(t.getUTCDate() + 4 - day);
        const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
        const wk = Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
        return `${pad(t.getUTCFullYear(), 4)}-W${pad(wk)}`;
      }
      return null;
    },
    // Did a programmatic value stick? Tolerates browser normalisation (number formatting, colour
    // case, trailing :00 seconds) and input masks that only add punctuation ("5551234" → "555-1234").
    valueSticks(type: string, wanted: string, actual: string): { ok: boolean; note?: string } {
      if (actual === wanted) return { ok: true };
      const nl = (s: string) => s.replace(/\r\n?/g, "\n");
      if (nl(actual) === nl(wanted)) return { ok: true };
      if (wanted !== "" && actual === "") return { ok: false };
      if ((type === "number" || type === "range") && wanted.trim() !== "" && Number(actual) === Number(wanted)) return { ok: true };
      if (type === "color" && actual.toLowerCase() === wanted.toLowerCase()) return { ok: true };
      const secs = (s: string) => s.replace(/:00(\.0+)?$/, "");
      if ((type === "time" || type === "datetime-local") && secs(actual) === secs(wanted)) return { ok: true };
      if (actual.trim() === wanted.trim() && type !== "textarea") return { ok: true };
      const an = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
      if (an(wanted) !== "" && an(actual) === an(wanted)) return { ok: true, note: `field formatted the value as "${actual}"` };
      return { ok: false };
    },
    fpEqual(a: RefFingerprint, b: RefFingerprint): boolean {
      return a.tag === b.tag && a.role === b.role && a.name === b.name;
    },
    describeFp(f: RefFingerprint | null): string {
      if (!f) return "<detached>";
      return `<${f.tag}${f.role ? ` role=${f.role}` : ""} "${f.name.length > 40 ? f.name.slice(0, 40) + "…" : f.name}">`;
    },
    // The realistic pointer/mouse sequence a real click produces, in order. kind "focus" marks where
    // the browser moves focus (mousedown's default action).
    mouseSequence(hoverOnly: boolean): { type: string; kind: "pointer" | "mouse" | "focus"; bubbles: boolean; buttons: number }[] {
      const seq: { type: string; kind: "pointer" | "mouse" | "focus"; bubbles: boolean; buttons: number }[] = [
        { type: "pointerover", kind: "pointer", bubbles: true, buttons: 0 },
        { type: "pointerenter", kind: "pointer", bubbles: false, buttons: 0 },
        { type: "mouseover", kind: "mouse", bubbles: true, buttons: 0 },
        { type: "mouseenter", kind: "mouse", bubbles: false, buttons: 0 },
        { type: "pointermove", kind: "pointer", bubbles: true, buttons: 0 },
        { type: "mousemove", kind: "mouse", bubbles: true, buttons: 0 },
      ];
      if (hoverOnly) return seq;
      seq.push(
        { type: "pointerdown", kind: "pointer", bubbles: true, buttons: 1 },
        { type: "mousedown", kind: "mouse", bubbles: true, buttons: 1 },
        { type: "focus", kind: "focus", bubbles: false, buttons: 1 },
        { type: "pointerup", kind: "pointer", bubbles: true, buttons: 0 },
        { type: "mouseup", kind: "mouse", bubbles: true, buttons: 0 },
        { type: "click", kind: "mouse", bubbles: true, buttons: 0 }
      );
      return seq;
    },
    // Sequential focus order: positive tabIndex ascending (stable), then tabIndex 0 in DOM order.
    tabOrder(tabIndexes: number[]): number[] {
      const pos = tabIndexes.map((t, i) => [t, i]).filter(([t]) => t > 0).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i);
      const zero = tabIndexes.map((t, i) => [t, i]).filter(([t]) => t === 0).map(([, i]) => i);
      return [...pos, ...zero];
    },
    nextTab(len: number, cur: number, back: boolean): number {
      if (len <= 0) return -1;
      if (cur < 0) return back ? len - 1 : 0;
      return (cur + (back ? -1 : 1) + len) % len;
    },
    // input types where Enter performs implicit form submission
    implicitSubmitType(t: string): boolean {
      return ["text", "search", "email", "url", "tel", "password", "number", "date", "month", "week", "time", "datetime-local"].includes(t);
    },
  };
  if (op === "__logic") return L;

  try {
    return await run();
  } catch (e) {
    return { error: `${op} failed in page: ${e instanceof Error ? e.message : String(e)}` };
  }

  async function run(): Promise<any> {
    // ================= DOM helpers =================
    // Shadow-piercing deep walk - only used when the cheap querySelector misses (selector path) or a
    // ref needs re-resolution.
    const deepEach = (visit: (e: Element) => boolean | void): void => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        let els: NodeListOf<Element>;
        try {
          els = root.querySelectorAll("*");
        } catch {
          continue;
        }
        for (const el of Array.from(els)) {
          try {
            if (visit(el) === true) return;
          } catch {}
          const sr = (el as HTMLElement).shadowRoot;
          if (sr) stack.push(sr);
        }
      }
    };
    const deepFind = (pred: (e: Element) => boolean): HTMLElement | null => {
      let found: HTMLElement | null = null;
      deepEach((e) => {
        if (pred(e)) {
          found = e as HTMLElement;
          return true;
        }
      });
      return found;
    };

    // Ref fingerprint {tag, role, name}. KEEP IN SYNC with the inline copies in bbSnapshot
    // (background.ts) and bbAxSnapshot (ax.ts), which write window.__bbRefMeta at snapshot time.
    const fpOf = (e: Element): RefFingerprint => {
      const t = e.tagName;
      const it = t === "INPUT" ? ((e as HTMLInputElement).type || "").toLowerCase() : "";
      let s: string;
      if (t === "INPUT" && (it === "submit" || it === "button" || it === "reset")) s = (e as HTMLInputElement).value || e.getAttribute("aria-label") || "";
      else if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT")
        s = e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.getAttribute("name") || e.id || e.getAttribute("title") || "";
      else s = e.getAttribute("aria-label") || (e as HTMLElement).innerText || e.textContent || e.getAttribute("title") || "";
      return { tag: t.toLowerCase(), role: e.getAttribute("role") || "", name: s.replace(/\s+/g, " ").trim().slice(0, 80) };
    };

    // Composed-tree parent (slot-aware, crosses shadow boundaries).
    const cparent = (n: Node): Node | null => {
      const slot = (n as Element).assignedSlot;
      if (slot) return slot;
      const pn = n.parentNode;
      if (pn && pn.nodeType === 11 && (pn as ShadowRoot).host) return (pn as ShadowRoot).host;
      return pn;
    };
    const ccontains = (anc: Node, node: Node | null): boolean => {
      for (let n: Node | null = node, i = 0; n && i < 10000; n = cparent(n), i++) if (n === anc) return true;
      return false;
    };
    // Hit test that descends into open shadow roots (document.elementFromPoint stops at the host).
    const hitAt = (x: number, y: number): Element | null => {
      let t: Element | null = document.elementFromPoint(x, y);
      for (let i = 0; i < 32 && t && (t as HTMLElement).shadowRoot; i++) {
        const inner = (t as HTMLElement).shadowRoot!.elementFromPoint(x, y);
        if (!inner || inner === t) break;
        t = inner;
      }
      return t;
    };
    const describeEl = (t: Element) =>
      t.tagName.toLowerCase() +
      (t.id ? "#" + t.id : typeof (t as HTMLElement).className === "string" && (t as HTMLElement).className.trim() ? "." + (t as HTMLElement).className.trim().split(/\s+/)[0] : "");
    // Is the point owned by `el`? Descendants (label text, svg icons, spans) and ancestors count, as
    // does a <label> wired to el (custom checkbox skins put the label over a hidden input).
    const hitOk = (top: Element | null, el: Element): boolean => {
      if (!top || top === el) return true;
      if (ccontains(el, top) || ccontains(top, el)) return true;
      for (let n: Node | null = top, i = 0; n && i < 50; n = cparent(n), i++) {
        if ((n as Element).tagName === "LABEL") {
          const c = (n as HTMLLabelElement).control;
          if (c && (c === el || ccontains(el, c) || ccontains(c, el))) return true;
        }
      }
      return false;
    };

    const nextFrame = () =>
      new Promise<void>((res) => {
        let done = false;
        const f = () => {
          if (!done) {
            done = true;
            res();
          }
        };
        try {
          requestAnimationFrame(f);
        } catch {}
        setTimeout(f, 34); // rAF doesn't fire in hidden tabs
      });
    // Bring el into view WITHOUT smooth scrolling (sites with scroll-behavior:smooth otherwise get
    // measured mid-animation), then wait until its rect is stable across two frames (≤300ms).
    const settle = async (e: HTMLElement): Promise<DOMRect> => {
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const r0 = e.getBoundingClientRect();
      const inView = r0.top >= 0 && r0.left >= 0 && r0.bottom <= vh && r0.right <= vw;
      if (!inView) {
        try {
          e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
        } catch {
          e.scrollIntoView({ block: "center", inline: "center" });
        }
      }
      const same = (a: DOMRect, b: DOMRect) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
      const t0 = Date.now();
      let prev = e.getBoundingClientRect();
      let stable = 0;
      while (Date.now() - t0 < 300) {
        await nextFrame();
        const cur = e.getBoundingClientRect();
        stable = same(cur, prev) ? stable + 1 : 0;
        prev = cur;
        if (stable >= 2 || (inView && stable >= 1)) break;
      }
      return prev;
    };

    // ---- op "key": synthetic key press on this frame's focused element (no target lookup) ----
    if (op === "key") {
      const k = p.keyInit;
      if (!k || !k.key) return { error: "press_key needs a key" };
      let a: Element | null = document.activeElement;
      while (a && (a as HTMLElement).shadowRoot && (a as HTMLElement).shadowRoot!.activeElement) a = (a as HTMLElement).shadowRoot!.activeElement;
      const target = (a as HTMLElement) || document.body || document.documentElement;
      const tag = target.tagName.toLowerCase();
      const init: any = {
        key: k.key,
        code: k.code,
        keyCode: k.vk,
        which: k.vk,
        shiftKey: k.shift,
        ctrlKey: k.ctrl,
        altKey: k.alt,
        metaKey: k.meta,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      };
      const moveFocus = (back: boolean) => {
        const SEL = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';
        const list: HTMLElement[] = [];
        const walk = (root: Document | ShadowRoot) => {
          let els: NodeListOf<Element>;
          try {
            els = root.querySelectorAll("*");
          } catch {
            return;
          }
          for (const e of Array.from(els)) {
            const h = e as HTMLElement;
            try {
              if (
                h.matches(SEL) &&
                h.tabIndex >= 0 &&
                !h.matches(":disabled") &&
                !(h instanceof HTMLInputElement && h.type === "hidden") &&
                !h.closest("[inert]") &&
                (!(h as any).checkVisibility || (h as any).checkVisibility({ visibilityProperty: true }))
              ) {
                // a radio group is one tab stop: only its checked radio (or first, if none checked)
                if (h instanceof HTMLInputElement && h.type === "radio" && h.name) {
                  const scope = h.form || h.getRootNode();
                  const grp = Array.from((scope as ParentNode).querySelectorAll(`input[type=radio]`)).filter((r) => (r as HTMLInputElement).name === h.name) as HTMLInputElement[];
                  const chk = grp.find((r) => r.checked);
                  if (chk ? chk !== h : grp[0] !== h) continue;
                }
                list.push(h);
              }
            } catch {}
            if (h.shadowRoot) walk(h.shadowRoot);
          }
        };
        walk(document);
        const order = L.tabOrder(list.map((h) => h.tabIndex));
        const cur = order.findIndex((i) => list[i] === target);
        const nx = L.nextTab(order.length, cur, back);
        if (nx < 0) return null;
        const dest = list[order[nx]];
        try {
          dest.focus();
          if (dest instanceof HTMLInputElement && /^(text|search|email|url|tel|password|number)$/.test(dest.type)) dest.select();
        } catch {}
        return describeEl(dest);
      };
      // Deferred: the injected function returns BEFORE page key handlers run, so a handler that opens
      // alert()/confirm() (or a submit that navigates) can't wedge executeScript.
      setTimeout(() => {
        try {
          const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
          const printable = k.key.length === 1 && !k.ctrl && !k.meta;
          if (down && (printable || k.key === "Enter")) {
            target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: k.key === "Enter" ? 13 : k.key.charCodeAt(0) }));
          }
          if (down && !k.ctrl && !k.meta && !k.alt) {
            if (k.key === "Tab") moveFocus(k.shift);
            else if (k.key === "Enter") {
              const t = target as any;
              const itype = t instanceof HTMLInputElement ? (t.type || "text").toLowerCase() : "";
              if (t instanceof HTMLInputElement && t.form && L.implicitSubmitType(itype)) {
                try {
                  t.form.requestSubmit();
                } catch {}
              } else if (
                t instanceof HTMLButtonElement ||
                (t instanceof HTMLAnchorElement && t.href) ||
                (t instanceof HTMLInputElement && /^(submit|button|reset|image)$/.test(itype))
              ) {
                t.click();
              }
            }
          }
          target.dispatchEvent(new KeyboardEvent("keyup", init));
          if (down && k.key === " " && !k.ctrl && !k.meta) {
            const t = target as any;
            if (t instanceof HTMLButtonElement || (t instanceof HTMLInputElement && /^(checkbox|radio|submit|button|reset)$/.test(t.type))) t.click();
          }
        } catch {}
      }, 0);
      return { pressed: k.key, target: tag, dispatched: "deferred" };
    }

    // ================= resolve the target =================
    // A ref hits the ISOLATED-world registry (window.__bbRefs) that bbSnapshot / bbAxSnapshot build -
    // a Map lookup, no DOM walk - then is verified against the fingerprint stored at snapshot time
    // (window.__bbRefMeta), so an index-keyed list re-sort or a recycled virtual-list row can't make
    // the ref silently act on different content. A selector tries the cheap light-DOM querySelector
    // FIRST and only falls back to the shadow-piercing walk on a miss.
    let el: HTMLElement | null = null;
    let reResolved = false;
    if (p.ref != null) {
      const reg = (window as any).__bbRefs as Map<number, Element> | undefined;
      const meta = (window as any).__bbRefMeta as Map<number, RefFingerprint> | undefined;
      const hit = reg && reg.get(p.ref);
      if (!hit) return { notFound: true };
      const fp = meta && meta.get(p.ref);
      if (!fp) {
        if (!(hit as Element).isConnected) return { staleRef: true };
        el = hit as HTMLElement;
      } else {
        const nowFp = hit.isConnected ? fpOf(hit) : null;
        if (nowFp && L.fpEqual(nowFp, fp)) el = hit as HTMLElement;
        else {
          // changed or detached: re-resolve by the same tag+role+name, unique match only
          const cands: Element[] = [];
          deepEach((e) => {
            if (e.tagName.toLowerCase() !== fp.tag || (e.getAttribute("role") || "") !== fp.role) return;
            if (!L.fpEqual(fpOf(e), fp)) return;
            cands.push(e);
            if (cands.length > 1) return true;
          });
          if (cands.length === 1) {
            el = cands[0] as HTMLElement;
            reResolved = true;
            reg!.set(p.ref, el);
          } else {
            return {
              staleRef: true,
              ref: p.ref,
              was: L.describeFp(fp),
              now: L.describeFp(nowFp),
              ambiguous: cands.length > 1 || undefined,
            };
          }
        }
      }
    } else if (p.sel != null && p.nth != null) {
      let k = 0;
      const walkNth = (root: Document | ShadowRoot): HTMLElement | null => {
        let els: NodeListOf<Element>;
        try {
          els = root.querySelectorAll("*");
        } catch {
          return null;
        }
        for (let i = 0; i < els.length; i++) {
          const e = els[i];
          let m = false;
          try {
            m = e.matches(p.sel!);
          } catch {}
          if (m && k++ === p.nth) return e as HTMLElement;
          const sr = (e as HTMLElement).shadowRoot;
          if (sr) {
            const f = walkNth(sr);
            if (f) return f;
          }
        }
        return null;
      };
      el = walkNth(document);
      if (!el) return { notFound: true };
    } else if (p.sel != null) {
      try {
        el = document.querySelector(p.sel) as HTMLElement | null;
      } catch {
        el = null;
      }
      if (!el) {
        el = deepFind((e) => {
          try {
            return (e as HTMLElement).matches(p.sel!);
          } catch {
            return false;
          }
        });
      }
      if (!el) return { notFound: true };
    } else {
      return { error: "Provide either ref or selector" };
    }
    const target: HTMLElement = el;
    const tag = target.tagName.toLowerCase();
    const extra: any = reResolved ? { reResolved: true } : {};

    // ---- locate: scroll into view, return viewport-center coords (for the trusted CDP paths) ----
    // ox/oy = this frame's offset in the top-level viewport when every ancestor frame is same-origin;
    // crossOrigin:true means the caller must map the offset itself (CDP).
    if (op === "locate") {
      const r = await settle(target);
      try {
        target.focus({ preventScroll: true });
      } catch {}
      let ox = 0, oy = 0, crossOrigin = false;
      try {
        let w: Window = window;
        for (let i = 0; i < 20 && w !== w.top; i++) {
          const fe = w.frameElement as HTMLElement | null;
          if (!fe) {
            crossOrigin = true;
            break;
          }
          const fr = fe.getBoundingClientRect();
          let pl = 0, pt = 0;
          try {
            const pcs = (fe.ownerDocument.defaultView || window).getComputedStyle(fe);
            pl = parseFloat(pcs.paddingLeft) || 0;
            pt = parseFloat(pcs.paddingTop) || 0;
          } catch {}
          ox += fr.left + fe.clientLeft + pl;
          oy += fr.top + fe.clientTop + pt;
          w = w.parent;
        }
      } catch {
        crossOrigin = true;
      }
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, ox, oy, crossOrigin, isTop: window === window.top, tag, ...extra };
    }

    // ---- upload: set an <input type=file>'s files from base64 ----
    if (op === "upload") {
      if (!(target instanceof HTMLInputElement) || target.type !== "file") return { error: "Target is not an <input type=file>" };
      let bytes: Uint8Array;
      try {
        const bin = atob(p.b64 || "");
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return { error: "Invalid base64 content" };
      }
      const file = new File([bytes as BlobPart], p.filename || "upload", { type: p.mimeType || "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);
      (target as HTMLInputElement).files = dt.files;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return { uploaded: p.filename, size: bytes.length, ...extra };
    }

    // ---- pasteImage: paste/drop an image into a rich text / contenteditable field ----
    if (op === "pasteImage") {
      let bytes: Uint8Array;
      try {
        const bin = atob(p.b64 || "");
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return { error: "Invalid base64 content" };
      }
      const type = p.mimeType || "image/png";
      const ext = (type.split("/")[1] || "png").split("+")[0];
      const file = new File([bytes as BlobPart], `image.${ext}`, { type });
      const makeDT = () => {
        const dt = new DataTransfer();
        dt.items.add(file);
        return dt;
      };
      const method = p.method || "paste";
      target.focus();
      const did: string[] = [];
      if (method === "paste" || method === "both") {
        const dt = makeDT();
        let ev: ClipboardEvent;
        try {
          ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        } catch {
          ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
        }
        if (!ev.clipboardData) {
          try {
            Object.defineProperty(ev, "clipboardData", { value: dt });
          } catch {}
        }
        target.dispatchEvent(ev);
        did.push("paste");
      }
      if (method === "drop" || method === "both") {
        const r = target.getBoundingClientRect();
        const base: any = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        for (const t of ["dragenter", "dragover", "drop"]) {
          const dt = makeDT();
          let de: DragEvent;
          try {
            de = new DragEvent(t, { ...base, dataTransfer: dt });
          } catch {
            de = new Event(t, base) as DragEvent;
            try {
              Object.defineProperty(de, "dataTransfer", { value: dt });
            } catch {}
          }
          target.dispatchEvent(de);
        }
        did.push("drop");
      }
      return { pasted: true, method: did.join("+") || method, tag, size: bytes.length, ...extra };
    }

    // ================= interact: click / hover / fill / type =================
    const setNativeValue = (t: HTMLElement, v: string): boolean => {
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
        // the PROTOTYPE setter bypasses React's/Vue's instance-level value tracker so their
        // onChange sees the change
        const proto = t instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(t, v);
        else (t as any).value = v;
      } else if (t instanceof HTMLSelectElement) {
        (t as HTMLSelectElement).value = v;
      } else if (t.isContentEditable) {
        t.textContent = v;
      } else {
        return false;
      }
      return true;
    };

    // actionability preflight (returns {notActionable, reason} so the caller can retry/report)
    const cs = getComputedStyle(target);
    const rect0 = target.getBoundingClientRect();
    const visible =
      (!!rect0.width || !!rect0.height) &&
      cs.visibility !== "hidden" &&
      cs.display !== "none" &&
      ((target as any).checkVisibility ? (target as any).checkVisibility() : true);
    // disabled: own `disabled`, form controls disabled by an ancestor <fieldset disabled> (:disabled
    // covers that, minus the first-<legend> exemption), or aria-disabled on self / any ancestor
    // (crossing shadow boundaries).
    let disabled = !!(target as any).disabled;
    if (!disabled) {
      try {
        disabled = target.matches(":disabled");
      } catch {}
    }
    if (!disabled) {
      for (let n: Node | null = target, i = 0; n && i < 500; n = cparent(n), i++) {
        if ((n as Element).getAttribute && (n as Element).getAttribute("aria-disabled") === "true") {
          disabled = true;
          break;
        }
      }
    }
    if (!visible) return { notActionable: true, reason: "hidden", tag, ...extra };
    if (disabled && op !== "hover") return { notActionable: true, reason: "disabled", tag, ...extra };

    if (op === "click" || op === "hover") {
      const r = await settle(target);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = hitAt(cx, cy);
      const covered = !hitOk(top, target);
      if (covered && op === "click") {
        return { notActionable: true, reason: "covered", coveredBy: describeEl(top!), tag, ...extra };
      }
      // Real browsers target the topmost element at the point (an inner span/svg), which bubbles to el.
      const evTarget: Element = top && top !== target && ccontains(target, top) ? top : target;
      const screenX = Math.round((window.screenX || 0) + cx), screenY = Math.round((window.screenY || 0) + cy);
      const mk = (step: { type: string; kind: string; bubbles: boolean; buttons: number }): Event => {
        const init: any = {
          bubbles: step.bubbles,
          cancelable: step.bubbles,
          composed: true,
          clientX: cx,
          clientY: cy,
          screenX,
          screenY,
          button: 0,
          buttons: step.buttons,
          view: window,
          detail: step.type === "mousedown" || step.type === "mouseup" || step.type === "click" ? 1 : 0,
        };
        if (step.kind === "pointer") {
          return new PointerEvent(step.type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: step.buttons ? 0.5 : 0 });
        }
        return new MouseEvent(step.type, init);
      };
      if (op === "hover") {
        for (const step of L.mouseSequence(true)) evTarget.dispatchEvent(mk(step));
        return { hovered: true, tag, ...(covered ? { covered: true, coveredBy: describeEl(top!) } : {}), ...extra };
      }
      // mousedown's default action: focus the nearest focusable composed ancestor of the hit
      const focusFrom = (start: Element) => {
        const F = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';
        for (let n: Node | null = start, i = 0; n && i < 500; n = cparent(n), i++) {
          const h = n as HTMLElement;
          try {
            if (h.matches && h.matches(F) && !h.matches(":disabled")) {
              if (document.activeElement !== h) h.focus({ preventScroll: true });
              return;
            }
          } catch {}
        }
      };
      const label = (target.innerText || (target as HTMLInputElement).value || "").trim().slice(0, 80);
      // Deferred to a macrotask so this injected function RETURNS before any page handler runs: a
      // handler that calls alert()/confirm() would otherwise block executeScript indefinitely.
      setTimeout(() => {
        try {
          let pdPrevented = false, mdPrevented = false;
          for (const step of L.mouseSequence(false)) {
            if (step.kind === "focus") {
              if (!pdPrevented && !mdPrevented) focusFrom(evTarget.isConnected ? evTarget : target);
              continue;
            }
            // a canceled pointerdown suppresses the compatibility mousedown/mouseup (click still fires)
            if (pdPrevented && (step.type === "mousedown" || step.type === "mouseup")) continue;
            // if a handler removed the inner hit node, keep going on el (the native-click fallback)
            const t = evTarget.isConnected ? evTarget : target.isConnected ? target : null;
            if (!t) break;
            const ok = t.dispatchEvent(mk(step));
            if (step.type === "pointerdown" && !ok) pdPrevented = true;
            if (step.type === "mousedown" && !ok) mdPrevented = true;
          }
        } catch {}
      }, 0);
      return { clicked: true, via: "synthetic", dispatched: "deferred", tag, label, ...extra };
    }

    if (op === "fill") {
      const v = p.value ?? "";
      try {
        target.focus({ preventScroll: true });
      } catch {}
      const fire = (t: Element) => {
        t.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        t.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const tick = () => new Promise((r) => setTimeout(r, 0)); // let controlled components re-render

      // ---- <select>: match by value, then exact text, then case-insensitive text; multi supported ----
      if (target instanceof HTMLSelectElement) {
        const opts = Array.from(target.options).map((o) => ({ value: o.value, text: o.text }));
        const wants = target.multiple ? (L.matchOption(opts, v) >= 0 ? [v] : L.splitMulti(v)) : [v];
        const idx: number[] = [];
        for (const w of wants) {
          const i = L.matchOption(opts, w);
          if (i < 0) {
            if (!target.multiple && w === "") {
              idx.length = 0;
              break;
            }
            const list = opts.slice(0, 20).map((o) => (o.text.trim() || o.value) + (o.value && o.value !== o.text.trim() ? ` (${o.value})` : "")).join(" | ");
            return { filled: false, error: `no <option> matches "${w}" in <select>${opts.length ? `; options: ${list}${opts.length > 20 ? " | …" : ""}` : " (it has no options)"}` };
          }
          idx.push(i);
        }
        if (target.multiple) Array.from(target.options).forEach((o, i) => (o.selected = idx.includes(i)));
        else target.selectedIndex = idx.length ? idx[0] : -1;
        fire(target);
        await tick();
        const got = Array.from(target.selectedOptions).map((o) => o.index).sort((a, b) => a - b);
        const exp = [...idx].sort((a, b) => a - b);
        if (got.join(",") !== exp.join(",")) {
          const shows = Array.from(target.selectedOptions).map((o) => o.text.trim()).join(", ");
          return { filled: false, error: `value did not stick: wanted ${JSON.stringify(v)}, field shows ${JSON.stringify(shows)}` };
        }
        return { filled: true, tag, selected: idx.map((i) => opts[i].text.trim() || opts[i].value), ...extra };
      }

      if (target instanceof HTMLInputElement) {
        const type = (target.type || "text").toLowerCase();
        if (type === "file") return { error: "fill can't set an <input type=file> - use file_upload" };

        // ---- checkbox / radio: interpret the value as a boolean, toggle with a real click ----
        if (type === "checkbox" || type === "radio") {
          let box: HTMLInputElement = target;
          let want = L.parseBool(v);
          if (want === null && type === "radio" && target.name) {
            // a radio filled with a value/label picks that radio from its group
            const scope = (target.form || target.getRootNode()) as ParentNode;
            const grp = Array.from(scope.querySelectorAll("input[type=radio]")).filter((r) => (r as HTMLInputElement).name === target.name) as HTMLInputElement[];
            const i = L.matchOption(
              grp.map((r) => ({ value: r.value, text: (r.labels && r.labels[0] ? r.labels[0].innerText : "") || r.getAttribute("aria-label") || "" })),
              v
            );
            if (i < 0) return { filled: false, error: `no radio in group "${target.name}" matches "${v}"` };
            box = grp[i];
            want = true;
          }
          if (want === null) return { filled: false, error: `fill on a ${type} takes true/false (or on/off, yes/no, checked/unchecked), got ${JSON.stringify(v)}` };
          if (box.checked !== want) {
            if (type === "radio" && !want) {
              // a click can't uncheck a radio: native setter + events
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
              if (setter) setter.call(box, false);
              else box.checked = false;
              fire(box);
            } else {
              box.click(); // toggles + fires click/input/change, which React/Vue listen to
            }
          }
          await tick();
          if (box.checked !== want) return { filled: false, error: `value did not stick: wanted ${want ? "checked" : "unchecked"}, field shows ${box.checked ? "checked" : "unchecked"}` };
          return { filled: true, tag, checked: box.checked, ...extra };
        }

        let want = v;
        if (["date", "datetime-local", "time", "month", "week"].includes(type)) {
          const n = L.normDate(type, v);
          if (n === null) return { filled: false, error: `can't interpret ${JSON.stringify(v)} as a ${type} value (expected ISO, e.g. ${type === "date" ? "2024-03-05" : type === "time" ? "14:30" : type === "month" ? "2024-03" : type === "week" ? "2024-W10" : "2024-03-05T14:30"})` };
          want = n;
        }
        setNativeValue(target, want);
        fire(target);
        await tick();
        const chk = L.valueSticks(type, want, target.value);
        if (!chk.ok) return { filled: false, error: `value did not stick: wanted ${JSON.stringify(want)}, field shows ${JSON.stringify(target.value)}` };
        return { filled: true, tag, ...(want !== v ? { normalized: want } : {}), ...(chk.note ? { note: chk.note } : {}), ...extra };
      }

      if (target instanceof HTMLTextAreaElement) {
        setNativeValue(target, v);
        fire(target);
        await tick();
        const chk = L.valueSticks("textarea", v, target.value);
        if (!chk.ok) return { filled: false, error: `value did not stick: wanted ${JSON.stringify(v.slice(0, 200))}, field shows ${JSON.stringify(target.value.slice(0, 200))}` };
        return { filled: true, tag, ...(chk.note ? { note: chk.note } : {}), ...extra };
      }

      if (target.isContentEditable) {
        // rich editors (ProseMirror/Quill/Lexical/Slate) model their state from beforeinput/input;
        // execCommand fires both natively. Select only THIS element's contents (not the page).
        let via = "execCommand";
        try {
          const selObj = (target.getRootNode() as any).getSelection ? (target.getRootNode() as any).getSelection() : window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(target);
          (selObj || window.getSelection())?.removeAllRanges();
          (selObj || window.getSelection())?.addRange(range);
        } catch {}
        let ok = false;
        try {
          ok = v === "" ? document.execCommand("delete", false) : document.execCommand("insertText", false, v);
        } catch {}
        if (!ok) {
          via = "inputEvent";
          const bi = new InputEvent("beforeinput", { inputType: "insertText", data: v, bubbles: true, cancelable: true, composed: true });
          if (target.dispatchEvent(bi)) target.textContent = v;
          target.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: v, bubbles: true, composed: true }));
        }
        await tick();
        const shown = norm(target.innerText || target.textContent || "");
        if (shown !== norm(v) && !(v && shown.includes(norm(v)))) {
          return { filled: false, error: `value did not stick: wanted ${JSON.stringify(v.slice(0, 200))}, field shows ${JSON.stringify(shown.slice(0, 200))}` };
        }
        return { filled: true, via, tag, ...extra };
      }
      return { error: `Element <${tag}> is not fillable` };
    }

    if (op === "type") {
      target.focus();
      const text = p.value ?? "";
      if (target.isContentEditable) {
        for (const ch of Array.from(text)) {
          target.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
          try {
            document.execCommand("insertText", false, ch);
          } catch {
            target.textContent = (target.textContent ?? "") + ch;
          }
          target.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, cancelable: true }));
        }
        return { typed: text.length, via: "execCommand", tag, ...extra };
      }
      let cur = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target.textContent ?? "";
      for (const ch of Array.from(text)) {
        const opts: any = { key: ch, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent("keydown", opts));
        target.dispatchEvent(new KeyboardEvent("keypress", opts));
        cur += ch;
        setNativeValue(target, cur);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        target.dispatchEvent(new KeyboardEvent("keyup", opts));
      }
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return { typed: text.length, tag, ...extra };
    }
    return { error: `Unknown action: ${op}` };
  }
}
