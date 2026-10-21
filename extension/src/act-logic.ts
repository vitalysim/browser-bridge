// Pure, chrome-free helpers for the element-interaction tools that run in the SERVICE WORKER (not
// injected into pages). Kept out of background.ts so they can be unit-tested from Node
// (server/test/interaction.test.ts). Nothing here may touch `chrome`, `window` or `document`.

// CDP Input modifier bitmask.
export const CDP_MODS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, win: 4, shift: 8 };

// Resolve a key name ("Enter", "ArrowUp", "c", "F5") → { key, code, vk } for CDP Input.dispatchKeyEvent
// and synthetic KeyboardEvent init.
export function keyInfo(name: string): { key: string; code: string; vk: number } {
  const named: Record<string, [string, string, number]> = {
    enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13],
    tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46],
    space: [" ", "Space", 32], spacebar: [" ", "Space", 32],
    up: ["ArrowUp", "ArrowUp", 38], arrowup: ["ArrowUp", "ArrowUp", 38],
    down: ["ArrowDown", "ArrowDown", 40], arrowdown: ["ArrowDown", "ArrowDown", 40],
    left: ["ArrowLeft", "ArrowLeft", 37], arrowleft: ["ArrowLeft", "ArrowLeft", 37],
    right: ["ArrowRight", "ArrowRight", 39], arrowright: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36], end: ["End", "End", 35],
    pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
    insert: ["Insert", "Insert", 45], ins: ["Insert", "Insert", 45],
  };
  const lk = name.toLowerCase();
  if (named[lk]) return { key: named[lk][0], code: named[lk][1], vk: named[lk][2] };
  const fm = /^f([1-9]|1[0-2])$/i.exec(name);
  if (fm) { const n = Number(fm[1]); return { key: "F" + n, code: "F" + n, vk: 111 + n }; }
  if (name.length === 1) {
    const ch = name;
    const up = ch.toUpperCase();
    if (/[a-z]/i.test(ch)) return { key: ch, code: "Key" + up, vk: up.charCodeAt(0) };
    if (/[0-9]/.test(ch)) return { key: ch, code: "Digit" + ch, vk: ch.charCodeAt(0) };
    if (ch === " ") return { key: " ", code: "Space", vk: 32 };
    return { key: ch, code: "", vk: up.charCodeAt(0) };
  }
  return { key: name, code: "", vk: 0 };
}

export interface KeyCombo {
  key: string;
  code: string;
  vk: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  modifiers: number; // CDP bitmask
}

// "Enter", "Shift+Tab", "ctrl+a", "Meta+Enter", "+" → a normalized key + modifier flags.
export function parseKeyCombo(combo: string): KeyCombo {
  const raw = String(combo ?? "");
  let parts: string[];
  if (raw.length <= 1) parts = [raw];
  else {
    parts = raw.split("+").map((s) => s.trim());
    // "ctrl++" / "shift++" → the last key is a literal "+"
    if (parts.length > 1 && parts[parts.length - 1] === "") {
      parts = parts.filter(Boolean);
      parts.push("+");
    } else parts = parts.filter(Boolean);
  }
  // Everything before the last part is a modifier; the last part is the key itself (which may be a
  // modifier key name like "Shift" when pressed alone).
  let mods = 0;
  for (const p of parts.slice(0, -1)) {
    const m = CDP_MODS[p.toLowerCase()];
    if (m !== undefined) mods |= m;
  }
  const base = parts[parts.length - 1] ?? "";
  const info = base ? keyInfo(base) : { key: "", code: "", vk: 0 };
  return {
    ...info,
    shift: !!(mods & 8),
    ctrl: !!(mods & 2),
    alt: !!(mods & 1),
    meta: !!(mods & 4),
    modifiers: mods,
  };
}

// Pick the frame that should receive a synthetic key press, from an all-frames probe of
// { hasFocus, activeIsFrame (document.activeElement is an <iframe>/<frame>), activeIsBody }.
// Prefer the deepest frame that has focus and isn't merely delegating to a child frame; when the
// window itself isn't focused (background tab) fall back to a frame with a real active element.
export interface FocusProbe {
  frameId: number;
  hasFocus: boolean;
  activeIsFrame: boolean;
  activeIsBody: boolean;
}
export function pickFocusedFrame(probes: FocusProbe[]): number {
  const focused = probes.filter((p) => p.hasFocus && !p.activeIsFrame);
  const pick = (list: FocusProbe[]) => list.find((p) => p.frameId !== 0) ?? list[0];
  if (focused.length) return pick(focused).frameId;
  const active = probes.filter((p) => !p.activeIsFrame && !p.activeIsBody);
  if (active.length) return pick(active).frameId;
  return 0;
}

// Map an extension frame (by URL) to its CDP Page.getFrameTree frame id. CDP frame urls carry the
// fragment separately, so compare without the hash. Returns null unless exactly one frame matches.
export function matchCdpFrame(tree: any, url: string): string | null {
  const strip = (u: string) => String(u || "").split("#")[0];
  const want = strip(url);
  const hits: string[] = [];
  const walk = (node: any, isRoot: boolean) => {
    if (!node || !node.frame) return;
    if (!isRoot && strip(node.frame.url) === want) hits.push(node.frame.id);
    for (const c of node.childFrames ?? []) walk(c, false);
  };
  walk(tree, true);
  return hits.length === 1 ? hits[0] : null;
}
