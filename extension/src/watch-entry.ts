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

  const nav = () => location.href;

  const sizeOf = (e: any) => 120 + (e.value ? String(e.value).length : 0) + (e.text ? String(e.text).length : 0);

  function push(ev: any): void {
    if (dormant) return;
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
  function flush(): void {
    if (!armed || sending || !buf.length) return;
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

  function labelOf(h: HTMLElement): string {
    const i = h as HTMLInputElement;
    // For a form field the label must NOT fall back to `value`: the action already carries the value,
    // so using it here renders `<input#q> "hello" = "hello"` - and mid-burst it renders the label as
    // whatever the first character was. bbSnapshot prefers value because it is describing current
    // state; here the state is reported separately.
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(h.tagName)) {
      return clean(
        (i.placeholder || h.getAttribute("aria-label") || h.getAttribute("title") || i.name || "") as string
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
    return parts.join(" > ").replace(/ > >> > /g, " >> ").slice(0, 200);
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
        for (const el of Array.from(form.elements ?? []) as HTMLInputElement[]) {
          if (!el.name || el.type === "submit" || el.type === "button") continue;
          fields.push({ name: el.name, value: String(el.value ?? "").slice(0, 200), secret: isSecretField(el) });
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

  // SPA route changes. history.pushState is patched in the MAIN world (watch-main.ts) and relayed
  // here; popstate/hashchange are observable from an isolated world directly.
  let lastUrl = nav();
  const reportNav = (via: string) => {
    const url = nav();
    if (url === lastUrl) return;
    const from = lastUrl;
    lastUrl = url;
    push({ t: now(), k: "nav", url, from, via, title: document.title });
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
    if (d.kind === "nav") reportNav("spa");
    else if (d.kind === "console") push({ t: now(), k: "console", level: d.level, text: String(d.text ?? "").slice(0, 500), src: d.src, line: d.line });
  }) as EventListener);

  document.addEventListener("visibilitychange", () => {
    push({ t: now(), k: document.visibilityState === "hidden" ? "hidden" : "visible", url: nav(), title: document.title });
  });

  // The document is about to die; get whatever is buffered onto the wire.
  window.addEventListener("pagehide", () => flush(), true);

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
