// In-page accessibility-tree walker. Serialized and run IN THE PAGE (ISOLATED world) via
// chrome.scripting.executeScript, so it must be FULLY self-contained: no references to module-scope
// helpers (esbuild would leave dangling names). Banner-free (plain injection, no chrome.debugger).
//
// It computes role + accessible name + agent-relevant states for each element, descends through open
// shadow roots, skips aria-hidden / not-rendered subtrees, and flattens non-semantic wrappers so the
// tree stays about meaning. Each INTERACTIVE node is registered in window.__bbRefs (same registry and
// per-frame offset scheme bbSnapshot uses) so its ref works with the existing click/fill/hover/type.
// The structured tree is rendered to text server-side (server/src/ax.ts) - kept pure for testing.

export interface AxWalkNode {
  role: string;
  name?: string;
  ref?: number;
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

export function bbAxSnapshot(refOffset: number): { url: string; root: AxWalkNode[]; truncated: boolean } {
  // Fresh ref registry each snapshot (never merged), matching bbSnapshot's invariant: refs from a
  // prior snapshot must not leak, and every ref locator injects in this same ISOLATED world.
  const bbRefs: Map<number, Element> = ((window as any).__bbRefs = new Map());
  let refCount = 0; // interactive refs assigned; capped below STRIDE so frames' ranges can't collide
  let nodeCount = 0; // total emitted nodes (payload cap)
  let truncated = false;
  const REF_CAP = 400; // < the 500 per-frame ref stride, like bbSnapshot's element cap
  const NODE_CAP = 1500;

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
  const walk = (el: Element): AxWalkNode[] => {
    if (nodeCount >= NODE_CAP) {
      truncated = true;
      return [];
    }
    if (SKIP_TAG.has(el.tagName)) return [];
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
    if (interactive && refCount < REF_CAP) {
      refCount++;
      const ref = refOffset + refCount;
      bbRefs.set(ref, el);
      node.ref = ref;
    }
    if (childNodes.length) node.children = childNodes;
    return [node];
  };

  let root: AxWalkNode[] = [];
  try {
    const body = document.body;
    root = body ? walk(body) : [];
  } catch {
    /* return whatever was built */
  }
  return { url: location.href, root, truncated };
}
