// Single injected find-and-act helper. Serialized and run IN THE PAGE (ISOLATED world), so it must
// be FULLY self-contained: no references to module-scope helpers (esbuild would leave dangling
// names). Failure is signalled by RETURNING { error } / { notFound } / { staleRef } - never by
// throwing, because Chrome swallows exceptions thrown inside executeScript and resolves with null.
//
// This is the ONE copy of the deep-find + ref-resolution logic that click/fill/hover/type,
// file_upload, paste_image and the trusted-paste locate all share, so the callers can't drift.
// `op` selects the action; `p` bundles its args (nulls, never undefined - executeScript rejects
// undefined in the args array).

export interface BbActParams {
  ref?: number | null;
  sel?: string | null;
  value?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  b64?: string | null;
  method?: string | null;
}

export function bbAct(op: string, p: BbActParams): any {
  // Shadow-piercing deep walk - only used when the cheap querySelector misses (selector path) or a
  // ref needs no DOM search at all. Self-contained (injected funcs can't call module helpers).
  const deepFind = (pred: (e: Element) => boolean): HTMLElement | null => {
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
          if (pred(el)) return el as HTMLElement;
        } catch {}
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) stack.push(sr);
      }
    }
    return null;
  };

  // Resolve the target. A ref hits the ISOLATED-world registry (window.__bbRefs) that bbSnapshot /
  // bbAxSnapshot build - a Map lookup, no DOM walk. A selector tries the cheap light-DOM
  // querySelector FIRST and only falls back to the shadow-piercing walk on a miss.
  let el: HTMLElement | null = null;
  if (p.ref != null) {
    const reg = (window as any).__bbRefs as Map<number, Element> | undefined;
    const hit = reg && reg.get(p.ref);
    if (!hit) return { notFound: true };
    if (!(hit as Element).isConnected) return { staleRef: true };
    el = hit as HTMLElement;
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

  const tag = el.tagName.toLowerCase();

  // ---- locate: scroll into view, return viewport-center coords (for the trusted CDP paste path) ----
  if (op === "locate") {
    el.scrollIntoView({ block: "center", inline: "center" });
    try {
      el.focus();
    } catch {}
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  // ---- upload: set an <input type=file>'s files from base64 ----
  if (op === "upload") {
    if (!(el instanceof HTMLInputElement) || el.type !== "file") return { error: "Target is not an <input type=file>" };
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
    (el as HTMLInputElement).files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { uploaded: p.filename, size: bytes.length };
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
    el.focus();
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
      el.dispatchEvent(ev);
      did.push("paste");
    }
    if (method === "drop" || method === "both") {
      const r = el.getBoundingClientRect();
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
        el.dispatchEvent(de);
      }
      did.push("drop");
    }
    return { pasted: true, method: did.join("+") || method, tag, size: bytes.length };
  }

  // ---- interact: click / hover / fill / type (op is the action) ----
  const setNativeValue = (target: HTMLElement, v: string): boolean => {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(target, v);
      else (target as any).value = v;
    } else if (target instanceof HTMLSelectElement) {
      (target as HTMLSelectElement).value = v;
    } else if (target.isContentEditable) {
      target.textContent = v;
    } else {
      return false;
    }
    return true;
  };

  // actionability preflight (returns {notActionable, reason} so the caller can retry/report)
  const cs = getComputedStyle(el);
  const rect0 = el.getBoundingClientRect();
  const visible =
    (!!rect0.width || !!rect0.height) &&
    cs.visibility !== "hidden" &&
    cs.display !== "none" &&
    ((el as any).checkVisibility ? (el as any).checkVisibility() : true);
  const disabled = !!(el as any).disabled || el.getAttribute("aria-disabled") === "true";
  if (!visible) return { notActionable: true, reason: "hidden", tag };
  if (disabled && op !== "hover") return { notActionable: true, reason: "disabled", tag };

  if (op === "click" || op === "hover") {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (op === "click") {
      const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
      const covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
      if (covered) {
        const by =
          top!.tagName.toLowerCase() +
          (top!.id ? "#" + top!.id : top!.className && typeof top!.className === "string" ? "." + top!.className.trim().split(/\s+/)[0] : "");
        return { notActionable: true, reason: "covered", coveredBy: by, tag };
      }
      el.click();
      return { clicked: true, via: "synthetic", tag, label: (el.innerText || "").trim().slice(0, 80) };
    }
    const base: any = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    el.dispatchEvent(new PointerEvent("pointerover", base));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new MouseEvent("mouseenter", base));
    el.dispatchEvent(new MouseEvent("mousemove", base));
    return { hovered: true, tag };
  }
  if (op === "fill") {
    el.focus();
    if (el.isContentEditable) {
      // rich editors (ProseMirror/Quill/Lit/React) require beforeinput - execCommand fires it
      try {
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, p.value ?? "");
      } catch {
        el.textContent = p.value ?? "";
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { filled: true, via: "execCommand", tag };
    }
    if (!setNativeValue(el, p.value ?? "")) return { error: `Element <${tag}> is not fillable` };
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, tag };
  }
  if (op === "type") {
    el.focus();
    const text = p.value ?? "";
    if (el.isContentEditable) {
      for (const ch of Array.from(text)) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
        try {
          document.execCommand("insertText", false, ch);
        } catch {
          el.textContent = (el.textContent ?? "") + ch;
        }
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, cancelable: true }));
      }
      return { typed: text.length, via: "execCommand", tag };
    }
    let cur = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent ?? "";
    for (const ch of Array.from(text)) {
      const opts: any = { key: ch, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      cur += ch;
      setNativeValue(el, cur);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: text.length, tag };
  }
  return { error: `Unknown action: ${op}` };
}
