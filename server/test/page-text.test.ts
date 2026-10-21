// get_page_text paging: a page longer than one response is read in slices via offset/nextOffset
// instead of being cut to an unrecoverable preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageTextSlice } from "../src/tools.js";
import { fakeBridge, captureStderr } from "./helpers/fake-server.js";

const page = (n: number) => ({ title: "T", url: "https://x.test/", text: Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join("") });

test("a short page comes back whole with nextOffset:null", () => {
  const r = pageTextSlice(page(100), {});
  assert.equal(r.text, page(100).text);
  assert.equal(r.totalChars, 100);
  assert.equal(r.offset, 0);
  assert.equal(r.nextOffset, null);
  assert.equal(r.title, "T");
});

test("offset/maxChars slice the text and nextOffset walks it to the end with no gaps", () => {
  const src = page(1000);
  let offset: number | null = 0;
  let joined = "";
  let pages = 0;
  while (offset !== null) {
    const r: any = pageTextSlice(src, { offset, maxChars: 300 });
    joined += r.text;
    offset = r.nextOffset;
    pages++;
  }
  assert.equal(joined, src.text);
  assert.equal(pages, 4);
});

test("an offset past the end returns an empty last page", () => {
  const r = pageTextSlice(page(10), { offset: 50 });
  assert.equal(r.text, "");
  assert.equal(r.offset, 10);
  assert.equal(r.nextOffset, null);
});

test("JSON escaping cannot push a page over budget: the slice shrinks and stays exact", () => {
  const src = { title: "T", url: "u", text: '"\n'.repeat(5000) }; // every char escapes to 2
  const r: any = pageTextSlice(src, { maxChars: 10_000 }, 8_000);
  assert.ok(JSON.stringify(r).length <= 8_000);
  assert.equal(r.nextOffset, r.text.length);
});

test("the tool returns paged JSON and echoes the caller's tabId", async () => {
  const b = fakeBridge({ get_page_text: () => page(70_000) });
  const { value } = await captureStderr(() => b.invoke("get_page_text", { tabId: 5 }));
  const r = JSON.parse(value.content[0].text);
  assert.equal(r.tabId, 5);
  assert.equal(r.totalChars, 70_000);
  assert.equal(r.text.length, 40_000);
  assert.equal(r.nextOffset, 40_000);
  assert.equal(r.truncated, undefined, "a page must never fall into the prefix-preview path");
  const { value: v2 } = await captureStderr(() => b.invoke("get_page_text", { tabId: 5, offset: r.nextOffset }));
  const r2 = JSON.parse(v2.content[0].text);
  assert.equal(r2.text.length, 30_000);
  assert.equal(r2.nextOffset, null);
});
