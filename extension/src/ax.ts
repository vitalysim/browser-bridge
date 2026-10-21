// In-page accessibility-tree walker. Serialized and run IN THE PAGE (ISOLATED world) via
// chrome.scripting.executeScript, so it must be FULLY self-contained: no references to module-scope
// helpers (esbuild would leave dangling names). Banner-free (plain injection, no chrome.debugger).
//
// It computes role + accessible name + agent-relevant states for each element, descends through open
// shadow roots, skips aria-hidden / not-rendered subtrees, and flattens non-semantic wrappers so the
// tree stays about meaning. Same two-phase ref scheme as bbSnapshot: each INTERACTIVE node is marked
// with `pi` (its priority rank: open dialog/modal/popover first, then in-viewport, then the rest in
// DOM order) and parked in window.__bbPending; the service worker budgets refs across frames, turns
// ranks into refs (snapshot-plan.ts assignAxRefs) and bbCommitRefs registers them in window.__bbRefs
// so they work with click/fill/hover/type. Inert subtrees (and everything behind a native modal
// <dialog>) are skipped. The tree is rendered to text server-side (server/src/ax.ts).

export interface AxWalkNode {
  role: string;
  name?: string;
  ref?: number;
  pi?: number; // priority rank of an interactive node (phase 1 only; becomes `ref` or is dropped)
  level?: number;
  checked?: boolean | "mixed";
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  focused?: boolean;
  value?: string;
  children?: AxWalkNode[];
}

export function bbAxSnapshot(epoch: number): { url: string; root: AxWalkNode[]; truncated: boolean; total: number; modal?: string } | { error: string } {
  try {
    return bbAxWalk(epoch);
  } catch (e) {
    return { error: `ax_snapshot failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  function bbAxWalk(epoch: number) {
  let nodeCount = 0; // total emitted nodes (payload cap)
  let truncated = false;
  const NODE_CAP = 1500;
  // Interactive nodes in DOM order; ranked + parked after the walk.
  const inter: { el: Element; node: AxWalkNode; bucket: number; meta: { tag: string; role: string; name: string } }[] = [];
  const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  let modal: Element | null = null;
  try {
    modal = document.querySelector("dialog:modal");
  } catch {}
  const modalNative = !!modal;
  if (!modal) {
    const ams = document.querySelectorAll('[aria-modal="true"]');
    for (let i = ams.length - 1; i >= 0; i--) {
      const r = ams[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        modal = ams[i];
        break;
      }
    }
  }
  const OVERLAY = 'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [popover]';
  const inOverlay = (el: Element) => {
    const c = el.closest(OVERLAY);
    if (!c) return false;
    if (!c.hasAttribute("popover")) return true;
    try {
      return c.matches(":popover-open");
    } catch {
      return false;
    }
  };

  const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().slice(0, 200);

  // ---- role: explicit role attribute, else the implicit role from tag/type ----
  const INPUT_ROLE: Record<string, string> = {
    button: "button", submit: "button", reset: "button", image: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton",
    search: "searchbox", email: "textbox", tel: "textbox", url: "textbox", text: "textbox", password: "textbox",
  };
  const TAG_ROLE: Record<string, string> = {
    nav: "navigation", main: "main", aside: "complementary", ul: "list", ol: "list", li: "listitem",
    table: "table", form: "form", select: "combobox", textarea: "textbox", output: "status",
    dialog: "dialog", fieldset: "group", figure: "figure", img: "img", button: "button",
    article: "article", summary: "button", menu: "list", details: "group",
  };
  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "input") {
      const t = ((el.getAttribute("type") || "text")).toLowerCase();
      if (t === "hidden") return "";
      return INPUT_ROLE[t] || "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "section")
      return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "generic";
    return TAG_ROLE[tag] || "generic";
  };
  const roleOf = (el: Element): string => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    return explicit || implicitRole(el);
  };

  // ---- accessible name: labelledby -> aria-label -> associated label -> alt/title/placeholder -> text ----
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "treeitem", "switch", "checkbox", "radio", "cell", "columnheader", "rowheader", "gridcell",
    "term", "alert", "status", "tooltip", "log", "caption", "figcaption",
  ]);
  const lookupId = (root: Document | ShadowRoot, id: string): Element | null => {
    try {
      return (
        (root as any).getElementById?.(id) ?? (root as any).querySelector?.("#" + (window as any).CSS.escape(id)) ?? document.getElementById(id)
      );
    } catch {
      return document.getElementById(id);
    }
  };
  const labelledby = (el: Element): string => {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids) return "";
    const root = el.getRootNode() as Document | ShadowRoot;
    let out = "";
    for (const id of ids.split(/\s+/)) {
      const r = lookupId(root, id);
      if (r) out += " " + ((r as HTMLElement).textContent || "");
    }
    return norm(out);
  };
  const associatedLabel = (el: Element): string => {
    const id = el.getAttribute("id");
    if (id) {
      const root = el.getRootNode() as Document | ShadowRoot;
      try {
        const lbl = (root as any).querySelector?.(`label[for="${(window as any).CSS.escape(id)}"]`);
        if (lbl) return norm(lbl.textContent || "");
      } catch {}
    }
    const wrap = el.closest && el.closest("label");
    if (wrap) return norm((wrap as HTMLElement).textContent || "");
    return "";
  };
  const nameOf = (el: Element, role: string): string => {
    const lb = labelledby(el);
    if (lb) return lb;
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return norm(al);
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const assoc = associatedLabel(el);
      if (assoc) return assoc;
      const ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return norm(ph);
      const title = el.getAttribute("title");
      if (title && title.trim()) return norm(title);
      return "";
    }
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt != null && alt.trim()) return norm(alt);
      const title = el.getAttribute("title");
      if (title) return norm(title);
      return "";
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const own = norm(el.textContent || "");
      if (own) return own;
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) return norm(title);
    return "";
  };

  // ---- interactivity (gets a ref) ----
  const INTERACTIVE_ROLE = new Set([
    "link", "button", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "textbox", "searchbox", "combobox", "slider", "spinbutton", "treeitem",
  ]);
  const isInteractive = (el: Element, role: string): boolean => {
    const tag = el.tagName.toLowerCase();
    if ((tag === "a" || tag === "area") && el.hasAttribute("href")) return true;
    if (tag === "button" || tag === "select" || tag === "textarea") return true;
    if (tag === "input") return (el.getAttribute("type") || "text").toLowerCase() !== "hidden";
    if ((el as HTMLElement).isContentEditable) return true;
    return INTERACTIVE_ROLE.has(role);
  };

  // ---- agent-relevant states ----
  const statesOf = (el: Element, role: string, tag: string): Partial<AxWalkNode> => {
    const s: Partial<AxWalkNode> = {};
    const ac = el.getAttribute("aria-checked");
    if (ac === "mixed") s.checked = "mixed";
    else if (ac === "true") s.checked = true;
    else if (ac === "false") s.checked = false;
    else if (tag === "input") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "checkbox" || t === "radio") s.checked = (el as HTMLInputElement).checked;
    }
    const ae = el.getAttribute("aria-expanded");
    if (ae === "true") s.expanded = true;
    else if (ae === "false") s.expanded = false;
    else if (tag === "details") s.expanded = (el as HTMLDetailsElement).open;
    if (el.getAttribute("aria-selected") === "true") s.selected = true;
    else if (tag === "option" && (el as HTMLOptionElement).selected) s.selected = true;
    if ((el as any).disabled || el.getAttribute("aria-disabled") === "true") s.disabled = true;
    if ((el as any).required || el.getAttribute("aria-required") === "true") s.required = true;
    if (document.activeElement === el) s.focused = true;
    if (role === "heading") {
      const al = el.getAttribute("aria-level");
      const m = /^h([1-6])$/.exec(tag);
      const lvl = al ? parseInt(al, 10) : m ? parseInt(m[1], 10) : NaN;
      if (!isNaN(lvl)) s.level = lvl;
    }
    if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "slider" || role === "spinbutton") {
      let v = "";
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) v = el.value;
      else if (el instanceof HTMLSelectElement) v = el.value;
      else if ((el as HTMLElement).isContentEditable) v = el.textContent || "";
      else v = el.getAttribute("aria-valuenow") || el.getAttribute("value") || "";
      if (v) s.value = v.slice(0, 120);
    }
    return s;
  };

  // ---- visibility: skip aria-hidden, [hidden], and not-rendered (display/visibility) subtrees ----
  const SKIP_TAG = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE", "SLOT"]);
  const isHidden = (el: Element): boolean => {
    if (el.getAttribute("aria-hidden") === "true") return true;
    if ((el as HTMLElement).hidden) return true;
    const cv = (el as any).checkVisibility;
    if (typeof cv === "function") {
      try {
        return !cv.call(el);
      } catch {}
    }
    try {
      const st = getComputedStyle(el);
      return st.display === "none" || st.visibility === "hidden";
    } catch {
      return false;
    }
  };

  // ---- the walk: returns this element's contribution (itself, or its children when it's a wrapper) ----
  const GENERIC = new Set(["generic", "none", "presentation", ""]);
  let walkedFirst: Element | null = null; // the open modal, walked before the page (see below)
  const walk = (el: Element): AxWalkNode[] => {
    if (el === walkedFirst) return []; // already emitted at the top
    if (nodeCount >= NODE_CAP) {
      truncated = true;
      return [];
    }
    if (SKIP_TAG.has(el.tagName)) return [];
    if (el.hasAttribute("inert")) return [];
    // Everything outside a native modal <dialog> is inert (not operable, not in the AX tree).
    if (modalNative && modal && !el.contains(modal) && !modal.contains(el) && el.getRootNode() === document) return [];
    if (isHidden(el)) return [];
    const tag = el.tagName.toLowerCase();
    const role = roleOf(el);
    if (role === "") return []; // e.g. input[type=hidden]

    const childNodes: AxWalkNode[] = [];
    // Descend open shadow roots too (closed roots are inaccessible by design). Shadow first, then
    // light children (slotted content lives in light DOM); minor slot-position drift is acceptable.
    if ((el as HTMLElement).shadowRoot) {
      for (const c of Array.from((el as HTMLElement).shadowRoot!.children)) {
        for (const cn of walk(c)) childNodes.push(cn);
        if (nodeCount >= NODE_CAP) break;
      }
    }
    for (const c of Array.from(el.children)) {
      for (const cn of walk(c)) childNodes.push(cn);
      if (nodeCount >= NODE_CAP) break;
    }

    const interactive = isInteractive(el, role);
    const meaningful = interactive || !GENERIC.has(role);
    if (!meaningful) return childNodes; // flatten the non-semantic wrapper

    nodeCount++;
    const node: AxWalkNode = { role };
    const name = nameOf(el, role);
    if (name) node.name = name;
    Object.assign(node, statesOf(el, role, tag));
    if (interactive) {
      const r = el.getBoundingClientRect();
      const inVp = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      const bucket = inOverlay(el) ? 0 : inVp ? 1 : 2;
      inter.push({ el, node, bucket, meta: { tag, role, name: (name || "").slice(0, 80) } });
    }
    if (childNodes.length) node.children = childNodes;
    return [node];
  };

  let root: AxWalkNode[] = [];
  try {
    // An open modal is walked FIRST: a portal modal is usually the last child of <body>, so on a big
    // page the node cap would otherwise be spent before the walk ever reaches it.
    let first: AxWalkNode[] = [];
    if (modal && modal !== document.body) {
      first = walk(modal);
      walkedFirst = modal;
    }
    const body = document.body;
    root = first.concat(body ? walk(body) : []);
  } catch {
    /* return whatever was built */
  }
  // Rank interactive nodes (stable: bucket, then DOM order) and park them for bbCommitRefs.
  const order = inter.map((_, i) => i).sort((a, b) => inter[a].bucket - inter[b].bucket || a - b);
  const items: { el: Element; meta: any }[] = [];
  order.forEach((idx, rank) => {
    inter[idx].node.pi = rank;
    items.push({ el: inter[idx].el, meta: inter[idx].meta });
  });
  (window as any).__bbPending = { epoch, items };
  const out: { url: string; root: AxWalkNode[]; truncated: boolean; total: number; modal?: string } = { url: location.href, root, truncated, total: items.length };
  if (modal) out.modal = norm(modal.getAttribute("aria-label") || (modal as HTMLElement).innerText || "").slice(0, 60) || modal.tagName.toLowerCase();
  return out;
  }
}
