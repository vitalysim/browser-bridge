// Accessibility-tree rendering (pure). The in-page ARIA walker (extension/src/ax.ts) returns a
// compact structured tree per frame; this turns it into the indented, YAML-like text an agent reads.
// Kept server-side and pure so it is unit-testable without a browser, and so the token-lean shaping
// (empty-container elision, depth/among-siblings caps) lives in one place. Shape modelled on
// Playwright MCP's aria snapshot: `- role "name" [state] [ref=N]`, children indented two spaces.

export interface AxNode {
  role: string;
  name?: string;
  ref?: number; // present iff the element is interactive (usable with click/fill/hover/type)
  level?: number; // heading level
  checked?: boolean | "mixed";
  expanded?: boolean; // present iff the element exposes aria-expanded
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  focused?: boolean;
  value?: string; // current value of a textbox/combobox/slider
  children?: AxNode[];
}

export interface AxFrame {
  frameId: number;
  url: string;
  root: AxNode[] | null;
  truncated?: boolean; // the in-page walk hit its per-frame node cap
}

export interface AxSnapshot {
  url: string;
  frames: AxFrame[];
}

export interface RenderAxOpts {
  interactiveOnly?: boolean; // keep only interactive nodes and the containers on the way to them
  maxDepth?: number; // elide deeper than this, with a note (default 25)
  maxChildren?: number; // elide siblings past this, with a note (default 60)
}

const DEFAULT_MAX_DEPTH = 25;
const DEFAULT_MAX_CHILDREN = 60;

// interactiveOnly keeps a node when it (or a descendant) is interactive, so the containing
// landmarks/lists that give an interactive element its context survive but pure prose does not.
function hasInteractive(n: AxNode): boolean {
  if (n.ref !== undefined) return true;
  return !!n.children && n.children.some(hasInteractive);
}

// Whether a node carries any signal worth printing. Recursive so a wrapper whose whole subtree is
// empty generic containers is dropped, not just a childless one. In interactiveOnly mode only
// interactive nodes (and their ancestors) count.
function renderable(n: AxNode, interactiveOnly: boolean): boolean {
  if (interactiveOnly) return hasInteractive(n);
  if (n.ref !== undefined || n.name) return true;
  return !!n.children && n.children.some((k) => renderable(k, interactiveOnly));
}

function escapeName(s: string): string {
  return s.replace(/\s+/g, " ").replace(/"/g, '\\"').trim().slice(0, 120);
}

// The bracketed state tokens after the name. Order is fixed so output is stable/diffable.
function stateTokens(n: AxNode): string {
  const t: string[] = [];
  if (n.checked === true) t.push("[checked]");
  else if (n.checked === "mixed") t.push("[checked=mixed]");
  else if (n.checked === false) t.push("[unchecked]");
  if (n.expanded === true) t.push("[expanded]");
  else if (n.expanded === false) t.push("[collapsed]");
  if (n.selected) t.push("[selected]");
  if (n.disabled) t.push("[disabled]");
  if (n.required) t.push("[required]");
  if (n.focused) t.push("[focused]");
  if (n.level !== undefined) t.push(`[level=${n.level}]`);
  if (n.value) t.push(`[value="${escapeName(n.value)}"]`);
  return t.length ? " " + t.join(" ") : "";
}

function renderNodes(nodes: AxNode[], opts: Required<RenderAxOpts>, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  if (depth >= opts.maxDepth) {
    if (nodes.length) out.push(`${pad}- … (${nodes.length} nodes, depth capped)`);
    return;
  }
  let shown = 0;
  for (const n of nodes) {
    if (!renderable(n, opts.interactiveOnly)) continue;
    if (shown >= opts.maxChildren) {
      const remaining = nodes.slice(nodes.indexOf(n)).filter((k) => renderable(k, opts.interactiveOnly)).length;
      out.push(`${pad}- … (${remaining} more)`);
      break;
    }
    shown++;
    const kids = n.children ?? [];
    // A container whose only content was elided renders as a leaf (no trailing colon).
    const hasKids = kids.some((k) => renderable(k, opts.interactiveOnly));
    let line = `${pad}- ${n.role || "generic"}`;
    if (n.name) line += ` "${escapeName(n.name)}"`;
    line += stateTokens(n);
    if (n.ref !== undefined) line += ` [ref=${n.ref}]`;
    if (hasKids) line += ":";
    out.push(line);
    if (hasKids) renderNodes(kids, opts, depth + 1, out);
  }
}

/** Render one frame's node list to the indented text form (no frame header). Exported for tests. */
export function renderAxTree(nodes: AxNode[] | null, opts: RenderAxOpts = {}): string {
  const full: Required<RenderAxOpts> = {
    interactiveOnly: !!opts.interactiveOnly,
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxChildren: opts.maxChildren ?? DEFAULT_MAX_CHILDREN,
  };
  const out: string[] = [];
  renderNodes(nodes ?? [], full, 0, out);
  return out.join("\n");
}

/**
 * Render a full multi-frame snapshot. Frame 0 is the page; each further frame with content is
 * appended under an `iframe` header (positional nesting inside the parent is not attempted - the
 * child frames are cross-origin islands, listed after the main tree).
 */
export function renderAxSnapshot(snap: AxSnapshot, opts: RenderAxOpts = {}): string {
  const parts: string[] = [];
  const main = snap.frames.find((f) => f.frameId === 0) ?? snap.frames[0];
  if (main) {
    const body = renderAxTree(main.root, opts);
    if (body) parts.push(body);
    if (main.truncated) parts.push("- … (frame node cap reached; tree truncated)");
  }
  for (const f of snap.frames) {
    if (!main || f.frameId === main.frameId) continue;
    const body = renderAxTree(f.root, opts);
    if (!body) continue;
    parts.push(`- iframe "${escapeName(f.url)}":`);
    parts.push(body.replace(/^/gm, "  "));
    if (f.truncated) parts.push("  - … (frame node cap reached; tree truncated)");
  }
  const text = parts.join("\n");
  return text || "(no accessible content)";
}
