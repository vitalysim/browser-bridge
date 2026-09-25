/// <reference types="chrome" />
// Watch-mode activity listener — the page half of the browsing copilot.
//
// Registered as a content script on <all_urls> (ISOLATED world, document_start) so it is present
// before the first paint, survives service-worker eviction, and needs no injection race to win. It
// captures ALREADY-LABELED semantic events: the label, the selector and the SPA route are read from
// the live DOM here, where they are free and exact, instead of being reconstructed downstream from a
// node index that resets on every navigation.
//
// Scope is enforced by ARMING, not by injection. The script loads everywhere, buffers into a small
// local ring immediately, and asks the service worker whether this tab belongs to a watch group. If
// the answer is no it drops the buffer and goes dormant. Buffering before the answer is what stops
// the first click on a freshly-opened tab from being lost.

(() => {
  const w = window as any;
  if (w.__bbWatch) return; // a second registration must not double-report every event
  const V = 1;

  // ---- local buffer -------------------------------------------------------
  // The page is the durable queue: events are held until the service worker acks that they reached
  // the socket. That is what makes an SW restart cost nothing.
  const MAX_BUFFER = 500;
  const MAX_BUFFER_BYTES = 256 * 1024;

  let armed: boolean | null = null; // null = still asking
  let dormant = false;
  let buf: any[] = [];
  let bufBytes = 0;
  let dropped = 0;
  let sending = false;
  let retryTimer: any = null;
  let retryDelay = 500;

  // Per-event id: a per-document nonce plus a counter, so the server can drop an event it already
  // folded. The pagehide flush and the retry path can each ship an event twice; the id makes both safe.
  const pageNonce = Math.random().toString(36).slice(2, 8);
  let eventSeq = 0;
  const eid = () => `${pageNonce}.${++eventSeq}`;

  const nav = () => location.href;

  const sizeOf = (e: any) => 120 + (e.value ? String(e.value).length : 0) + (e.text ? String(e.text).length : 0);

  function push(ev: any): void {
    if (dormant) return;
    ev.i = eid();
    buf.push(ev);
    bufBytes += sizeOf(ev);
    while (buf.length > MAX_BUFFER || bufBytes > MAX_BUFFER_BYTES) {
      const old = buf.shift();
      if (!old) break;
      bufBytes -= sizeOf(old);
      dropped++;
    }
    if (armed) flush();
  }

  // Flush per event rather than on a timer. Peak activity is a couple of events per second, so there
  // is nothing to gain by batching — and a 300ms batch is exactly what loses the click that navigates,
  // which is the single most valuable event in the stream.
  //
  // `force` is the pagehide path: the document is dying, so ship whatever is buffered even if a normal
  // send is already in flight (the old code no-op'd on `sending` and lost the tail). Fire-and-forget —
  // there is no time for the ack — and `final:true` tells the SW to hold it in the outbox if the socket
  // is down. Per-event ids let the server drop any duplicate the in-flight send also delivered.
  function flush(force = false): void {
    if (!armed || !buf.length) return;
    if (force) {
      try {
        chrome.runtime.sendMessage({ cmd: "bb-watch", v: V, events: buf.slice(), dropped, final: true });
      } catch {
        /* extension context gone as the page unloads - nothing more we can do */
      }
      return;
    }
    if (sending) return;
    sending = true;
    // A COPY, and a count captured now: `buf` keeps growing while this call is in flight, so holding
    // a reference to it and slicing by its later length would discard events that were never sent.
    const events = buf.slice();
    const n = events.length;
    const hadDropped = dropped;
    // Do NOT clear the buffer yet: it is only safe to drop once the SW confirms it shipped.
    try {
      chrome.runtime.sendMessage({ cmd: "bb-watch", v: V, events, dropped: hadDropped }, (res?: any) => {
        sending = false;
        // Reading lastError suppresses the "unchecked runtime.lastError" noise on a sleeping SW.
        const err = chrome.runtime.lastError;
        if (err || !res || !res.ok) return void scheduleRetry();
        if (res.shipped) {
          buf = buf.slice(n);
          bufBytes = buf.reduce((a, e) => a + sizeOf(e), 0);
          dropped -= hadDropped;
          retryDelay = 500;
          if (buf.length) flush();
        } else if (res.armed === false) {
          disarm();
        } else {
          scheduleRetry(); // SW is up but the socket is not — keep custody and try again
        }
      });
    } catch {
      sending = false;
      scheduleRetry(); // "Extension context invalidated" while the SW respawns
    }
  }

  function scheduleRetry(): void {
    if (retryTimer || dormant) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10_000);
  }

  function disarm(): void {
    armed = false;
    dormant = true;
    buf = [];
    bufBytes = 0;
    dropped = 0;
  }

  // ---- labeling (ported from bbSnapshot so watch labels read like snapshot labels) ----

  const clean = (s: string, n = 80) =>
    (s || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, n);

  /** aria-labelledby, then a <label for=id> or an ancestor <label>. This is where a checkbox/radio's
   *  visible text lives - it has no placeholder, aria-label or useful name - so without it those come
   *  out unlabeled. */
  function associatedLabel(h: HTMLElement): string {
    const doc = h.ownerDocument || document;
    const lb = h.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => (doc.getElementById(id)?.innerText || "").trim())
        .filter(Boolean)
        .join(" ");
      if (t) return t;
    }
    const id = h.getAttribute("id");
    if (id) {
      try {
        const lab = doc.querySelector(`label[for="${CSS.escape ? CSS.escape(id) : id}"]`) as HTMLElement | null;
        if (lab?.innerText) return lab.innerText;
      } catch {
        /* unescapable id */
      }
    }
    const wrap = (h.closest && h.closest("label")) as HTMLElement | null;
    if (wrap?.innerText) return wrap.innerText;
    return "";
  }

  function labelOf(h: HTMLElement): string {
    const i = h as HTMLInputElement;
    // For a form field the label must NOT fall back to `value`: the action already carries the value,
    // so using it here renders `<input#q> "hello" = "hello"` - and mid-burst it renders the label as
    // whatever the first character was. bbSnapshot prefers value because it is describing current
    // state; here the state is reported separately.
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(h.tagName)) {
      return clean(
        (i.placeholder || h.getAttribute("aria-label") || associatedLabel(h) || h.getAttribute("title") || i.name || "") as string
      );
    }
    return clean(
      (h.innerText || h.getAttribute("aria-label") || h.getAttribute("title") || h.getAttribute("alt") || "") as string
    );
  }

  /** A CSS-ish path. Shadow boundaries are joined with " >> " so the locator stays legible even
   *  where it is not directly re-queryable. */
  function selectorOf(h: Element): string {
    const seg = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const id = el.getAttribute("id");
      if (id && !/^[0-9]/.test(id) && !/[:.\[\]]/.test(id)) return `${tag}#${id}`;
      const name = el.getAttribute("name");
      if (name) return `${tag}[name="${name}"]`;
      const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean)[0];
      let s = cls ? `${tag}.${CSS.escape ? CSS.escape(cls) : cls}` : tag;
      const parent = el.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      }
      return s;
    };
    const parts: string[] = [];
    let cur: Element | null = h;
    let hops = 0;
    while (cur && hops < 5) {
      parts.unshift(seg(cur));
      if (cur.getAttribute("id")) break; // an id anchors the path; nothing above it adds precision
      const parent: Element | null = cur.parentElement;
      if (!parent) {
        const root = cur.getRootNode() as any;
        if (root && root.host) {
          // Crossed a shadow boundary — record it explicitly rather than silently flattening.
          parts.unshift(">>");
          cur = root.host as Element;
          hops++;
          continue;
        }
        break;
      }
      cur = parent;
      hops++;
    }
    // Assemble by dropping WHOLE leading segments if too long - a blind slice(0,200) can cut mid-token
    // ("div.foo" → "div.fo") and yield an invalid selector. The leaf (most specific) is always kept.
    const join = () => parts.join(" > ").replace(/ > >> > /g, " >> ");
    let out = join();
    while (out.length > 200 && parts.length > 1) {
      parts.shift();
      out = join();
    }
    // Prefer the SHORTEST suffix of the path that already uniquely identifies this element: start at
    // the leaf and extend leftward until querySelectorAll returns exactly it. A more specific (longer)
    // prefix can disambiguate where the leaf alone cannot, so keep extending rather than giving up.
    try {
      const doc = h.ownerDocument || document;
      const segs = out.split(" > ");
      for (let i = segs.length - 1; i >= 0; i--) {
        const cand = segs.slice(i).join(" > ");
        if (cand.includes(">>")) break; // shadow-boundary paths are not re-queryable; keep the full form
        const m = doc.querySelectorAll(cand);
        if (m.length === 1 && m[0] === h) return cand;
      }
    } catch {
      /* invalid selector under querySelectorAll - fall through to the assembled (still valid) form */
    }
    return out;
  }

  const SECRET_AC = /(current|new)-password|one-time-code|cc-(number|csc)/i;

  function isSecretField(h: HTMLElement): boolean {
    const i = h as HTMLInputElement;
    if ((i.type || "").toLowerCase() === "password") return true;
    return SECRET_AC.test(i.autocomplete || "");
  }

  function ref(h: HTMLElement | null | undefined): any {
    if (!h || !h.tagName) return undefined;
    const i = h as HTMLInputElement;
    const e: any = { tag: h.tagName.toLowerCase(), selector: selectorOf(h) };
    const label = labelOf(h);
    if (label) e.label = label;
    const id = h.getAttribute("id");
    if (id) e.id = id;
    if (i.name) e.name = i.name;
    if (h.tagName === "INPUT" && i.type) e.type = i.type;
    const role = h.getAttribute("role");
    if (role) e.role = role;
    if (h.tagName === "A") e.href = ((h as unknown as HTMLAnchorElement).href || "").slice(0, 200);
    if (isSecretField(h)) e.secret = true;
    return e;
  }

  /** The element the human actually interacted with. `event.target` is retargeted to the shadow HOST,
   *  so using it would label every click inside any web component as the component itself. */
  function actual(e: Event): HTMLElement | null {
    const path = typeof (e as any).composedPath === "function" ? (e as any).composedPath() : null;
    const node = (path && path[0]) || e.target;
    return node && (node as HTMLElement).tagName ? (node as HTMLElement) : null;
  }

  /** Walk up to the nearest thing a human would say they clicked. */
  function interactive(h: HTMLElement | null): HTMLElement | null {
    const SEL = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
    let cur: HTMLElement | null = h;
    let hops = 0;
    while (cur && hops < 6) {
      try {
        if (cur.matches(SEL)) return cur;
      } catch {
        /* matches() can throw on exotic nodes */
      }
      cur = cur.parentElement;
      hops++;
    }
    return h;
  }

  const now = () => Date.now();

  // ---- listeners ----------------------------------------------------------
  // All capture-phase, so a page that stops propagation on its own handlers cannot blind us.

  document.addEventListener(
    "click",
    (e) => {
      const hit = actual(e);
      const el = ref(interactive(hit));
      if (!el) return;
      push({ t: now(), k: "click", el, button: (e as MouseEvent).button, x: Math.round((e as MouseEvent).clientX), y: Math.round((e as MouseEvent).clientY) });
    },
    true
  );

  document.addEventListener(
    "input",
    (e) => {
      const h = actual(e);
      if (!h) return;
      const i = h as HTMLInputElement;
      const value = i.isContentEditable ? clean(h.innerText, 500) : String(i.value ?? "").slice(0, 500);
      push({ t: now(), k: "input", el: ref(h), value, checked: i.type === "checkbox" || i.type === "radio" ? i.checked : undefined });
    },
    true
  );

  document.addEventListener(
    "change",
    (e) => {
      const h = actual(e);
      if (!h) return;
      const i = h as HTMLInputElement;
      push({ t: now(), k: "change", el: ref(h), value: String(i.value ?? "").slice(0, 500), checked: i.type === "checkbox" || i.type === "radio" ? i.checked : undefined });
    },
    true
  );

  document.addEventListener(
    "submit",
    (e) => {
      const form = actual(e) as HTMLFormElement | null;
      if (!form) return;
      const fields: any[] = [];
      try {
        // FormData is exactly what the browser will submit: unchecked checkboxes and unselected radios
        // are omitted, the chosen radio's value appears once, disabled fields are excluded. Iterating
        // form.elements instead reported every option and every unchecked box - not what was sent.
        const secretNames = new Set<string>();
        for (const el of Array.from(form.elements ?? []) as HTMLInputElement[]) {
          if (el.name && isSecretField(el)) secretNames.add(el.name);
        }
        for (const [name, value] of new FormData(form).entries()) {
          if (typeof value !== "string") continue; // a File entry - the name/size, not contents
          fields.push({ name, value: value.slice(0, 200), secret: secretNames.has(name) });
          if (fields.length >= 25) break;
        }
      } catch {
        /* exotic form */
      }
      push({ t: now(), k: "submit", el: ref(form), fields });
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      const ke = e as KeyboardEvent;
      // Printable, unmodified keys are deliberately not reported: the coalesced input action already
      // carries the typed text, and a per-character stream is both noisy and the password-leak path.
      const printable = ke.key && ke.key.length === 1 && !ke.ctrlKey && !ke.metaKey && !ke.altKey;
      if (printable) return;
      push({ t: now(), k: "key", key: ke.key, code: ke.code, ctrl: ke.ctrlKey, meta: ke.metaKey, alt: ke.altKey, shift: ke.shiftKey, el: ref(actual(e)) });
    },
    true
  );

  document.addEventListener("focusin", (e) => push({ t: now(), k: "focus", el: ref(actual(e)) }), true);
  document.addEventListener("focusout", () => push({ t: now(), k: "blur" }), true);

  for (const k of ["copy", "paste"] as const) {
    document.addEventListener(
      k,
      (e) => {
        let text = "";
        try {
          text = (e as ClipboardEvent).clipboardData?.getData("text") ?? "";
        } catch {
          /* clipboard access denied */
        }
        push({ t: now(), k, el: ref(actual(e)), text: text.slice(0, 200) });
      },
      true
    );
  }

  let scrollTimer: any = null;
  document.addEventListener(
    "scroll",
    () => {
      if (scrollTimer) return; // throttle at the source; the server coalesces runs on top of this
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        push({ t: now(), k: "scroll", y: Math.round(window.scrollY) });
      }, 200);
    },
    true
  );

  // SPA route changes. history.pushState/replaceState are patched in the MAIN world (bbWatchMainShim)
  // and relayed here; popstate/hashchange are observable from an isolated world directly.
  let lastUrl = nav();
  const reportNav = (via: string, replace = false) => {
    const url = nav();
    if (url === lastUrl) return;
    const from = lastUrl;
    lastUrl = url;
    const ev: any = { t: now(), k: "nav", url, from, via, title: document.title };
    // replaceState (search-as-you-type rewrites ?q= per keystroke) must not split the input burst -
    // the server drops it while a burst is open. Carry the flag so it can.
    if (replace) ev.replace = true;
    push(ev);
  };
  window.addEventListener("popstate", () => reportNav("popstate"), true);
  window.addEventListener("hashchange", () => reportNav("hash"), true);
  // The MAIN-world script sends a JSON STRING, not an object: a structured-clone `detail` created in
  // the main world is not reliably readable from an isolated world, and silently reads as undefined.
  window.addEventListener("bb-watch-main", ((e: CustomEvent) => {
    let d: any;
    try {
      d = JSON.parse(String(e.detail));
    } catch {
      return;
    }
    if (d.kind === "nav") reportNav("spa", !!d.replace);
    else if (d.kind === "console") push({ t: now(), k: "console", level: d.level, text: String(d.text ?? "").slice(0, 500), src: d.src, line: d.line });
  }) as EventListener);

  document.addEventListener("visibilitychange", () => {
    push({ t: now(), k: document.visibilityState === "hidden" ? "hidden" : "visible", url: nav(), title: document.title });
  });

  // The document is about to die; get whatever is buffered onto the wire even if a send is in flight.
  window.addEventListener("pagehide", () => flush(true), true);

  // ---- arming handshake ---------------------------------------------------

  w.__bbWatch = {
    v: V,
    status: () => ({ v: V, armed, dormant, buffered: buf.length, dropped, url: nav() }),
    arm: (on: boolean, mode?: string) => {
      if (on) {
        armed = true;
        dormant = false;
        void mode; // the MAIN-world shim receives the mode directly as an injection argument
        // The initial navigation is the timeline's first entry, so the agent knows where we started.
        push({ t: now(), k: "nav", url: nav(), via: "load", title: document.title });
        flush();
      } else {
        disarm();
      }
      return { ok: true, armed };
    },
  };

  try {
    chrome.runtime.sendMessage({ cmd: "bb-watch-hello", v: V, url: nav() }, (res?: any) => {
      void chrome.runtime.lastError;
      if (res && res.armed) w.__bbWatch.arm(true, res.consoleMode);
      else disarm();
    });
  } catch {
    disarm(); // no extension context (rare) — never leak a growing buffer
  }
})();
