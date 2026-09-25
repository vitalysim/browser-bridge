// Accessibility-tree renderer tests. The renderer is the only AX surface that's pure (the walk runs
// in-page), so this is where the shaping - state tokens, empty-container elision, interactiveOnly
// pruning, depth/among-siblings caps, multi-frame stitching - gets pinned down. No browser, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAxTree, renderAxSnapshot, type AxNode, type AxSnapshot } from "../src/ax.js";

test("a leaf renders role, name and ref", () => {
  const out = renderAxTree([{ role: "button", name: "Save", ref: 3 }]);
  assert.equal(out, '- button "Save" [ref=3]');
});

test("a container gets a trailing colon and indents its children", () => {
  const tree: AxNode[] = [
    { role: "navigation", name: "Primary", children: [{ role: "link", name: "Home", ref: 1 }] },
  ];
  assert.equal(out(tree), "- navigation \"Primary\":\n  - link \"Home\" [ref=1]");
});

test("state tokens render in a fixed order after the name", () => {
  assert.equal(renderAxTree([{ role: "checkbox", name: "Agree", ref: 2, checked: true }]), '- checkbox "Agree" [checked] [ref=2]');
  assert.equal(renderAxTree([{ role: "checkbox", name: "Off", checked: false }]), '- checkbox "Off" [unchecked]');
  assert.equal(renderAxTree([{ role: "checkbox", name: "Some", checked: "mixed" }]), '- checkbox "Some" [checked=mixed]');
  assert.equal(renderAxTree([{ role: "heading", name: "T", level: 2 }]), '- heading "T" [level=2]');
  assert.equal(
    renderAxTree([{ role: "button", name: "X", expanded: false, disabled: true }]),
    '- button "X" [collapsed] [disabled]'
  );
  assert.equal(
    renderAxTree([{ role: "textbox", name: "Email", ref: 9, required: true, value: "a@b.com" }]),
    '- textbox "Email" [required] [value="a@b.com"] [ref=9]'
  );
});

test("empty generic containers are elided (no name, no ref, no kept children)", () => {
  const tree: AxNode[] = [
    { role: "generic", children: [] },
    { role: "generic", children: [{ role: "generic", children: [] }] },
    { role: "button", name: "Real", ref: 1 },
  ];
  assert.equal(out(tree), "- button \"Real\" [ref=1]");
});

test("a container whose only children are elided renders as a leaf (no colon)", () => {
  const tree: AxNode[] = [{ role: "list", name: "Empty", children: [{ role: "generic", children: [] }] }];
  assert.equal(out(tree), '- list "Empty"');
});

test("interactiveOnly keeps interactive nodes and the containers leading to them, drops pure prose", () => {
  const tree: AxNode[] = [
    {
      role: "main",
      children: [
        { role: "heading", name: "Intro" }, // no ref, no interactive descendant -> dropped
        { role: "paragraph", name: "some prose" }, // dropped
        { role: "form", children: [{ role: "textbox", name: "Q", ref: 5 }] }, // kept (has interactive)
      ],
    },
  ];
  assert.equal(out(tree, { interactiveOnly: true }), "- main:\n  - form:\n    - textbox \"Q\" [ref=5]");
});

test("maxChildren caps siblings with an '(N more)' note", () => {
  const kids: AxNode[] = [1, 2, 3, 4, 5].map((i) => ({ role: "link", name: `L${i}`, ref: i }));
  const out = renderAxTree(kids, { maxChildren: 2 });
  assert.equal(out, '- link "L1" [ref=1]\n- link "L2" [ref=2]\n- … (3 more)');
});

test("maxDepth caps deep subtrees with a note", () => {
  const tree: AxNode[] = [
    { role: "list", name: "Outer", children: [{ role: "listitem", name: "Inner", ref: 1 }] },
  ];
  assert.equal(out(tree, { maxDepth: 1 }), '- list "Outer":\n  - … (1 nodes, depth capped)');
});

test("names have whitespace collapsed and quotes escaped", () => {
  const out = renderAxTree([{ role: "button", name: '  Hello   "World"  ', ref: 1 }]);
  assert.equal(out, '- button "Hello \\"World\\"" [ref=1]');
});

test("renderAxSnapshot stitches child frames under an iframe header", () => {
  const snap: AxSnapshot = {
    url: "http://x",
    frames: [
      { frameId: 0, url: "http://x", root: [{ role: "button", name: "A", ref: 1 }] },
      { frameId: 5, url: "http://y", root: [{ role: "link", name: "B", ref: 501 }] },
    ],
  };
  assert.equal(renderAxSnapshot(snap), '- button "A" [ref=1]\n- iframe "http://y":\n  - link "B" [ref=501]');
});

test("renderAxSnapshot notes truncation and handles an empty page", () => {
  const truncated: AxSnapshot = {
    url: "http://x",
    frames: [{ frameId: 0, url: "http://x", root: [{ role: "button", name: "A", ref: 1 }], truncated: true }],
  };
  assert.equal(renderAxSnapshot(truncated), '- button "A" [ref=1]\n- … (frame node cap reached; tree truncated)');

  const empty: AxSnapshot = { url: "http://x", frames: [{ frameId: 0, url: "http://x", root: [] }] };
  assert.equal(renderAxSnapshot(empty), "(no accessible content)");
});

// small helper so the assertions above read as tree -> text
function out(nodes: AxNode[], opts?: Parameters<typeof renderAxTree>[1]): string {
  return renderAxTree(nodes, opts);
}
