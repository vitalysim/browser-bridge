// Visual and lifecycle regressions for recording. Every browser/server/profile is isolated.
import { before, after } from "node:test";
import { readFileSync, existsSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Page } from "playwright-core";
import { Harness, ARTIFACTS } from "./harness.js";
import { scenario as defineScenario, printSummary, type Ctx } from "./scenario.js";

let h: Harness;
const scenario = (name: string, fn: (c: Ctx) => Promise<void>, timeout = 120_000) => defineScenario(() => h, `recording:${name}`, fn, { timeout });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const raw = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s).event);
const out = (name: string) => join(h.tmpRoot, name);
before(async () => { h = new Harness({ logName: "server-recording-regression.log" }); try { await h.setup(); } catch (e) { await h.teardown(); throw e; } }, { timeout: 90_000 });
after(async () => { printSummary(); await h?.teardown(); }, { timeout: 60_000 });

async function open(c: Ctx, fixture: string, waitUntil = "load") {
  const url = h.fixtureUrl(`${fixture}${fixture.includes("?") ? "&" : "?"}review=${Date.now()}`);
  const r = await c.call("tab_new", { url, waitUntil });
  const tabId = r.json?.tabId;
  if (typeof tabId !== "number") throw new Error(r.text);
  c.tabs.push(tabId);
  let page: Page | undefined;
  for (let i = 0; i < 50 && !page; i++) { page = h.context!.pages().find((p) => p.url() === url); if (!page) await sleep(50); }
  if (!page) throw new Error(`no page for ${url}`);
  return { tabId, page };
}

scenario("slow-iframe-keeps-base-snapshot-and-stop-is-bounded", async (c) => {
  const { tabId, page } = await open(c, "slow-iframe.html", "domcontentloaded");
  await page.waitForFunction(() => (window as any).__iframeInserted);
  const start = await c.call("session_record_start", { tabId, allFrames: true });
  c.expect(!start.isError, start.text);
  await page.evaluate(() => document.getElementById("out")!.textContent = "Recorded after slow start");
  const stop = await c.call("session_record_stop", { tabId, inlineAssets: false });
  c.expect(!stop.isError, stop.text);
  c.expect(stop.ms < 6000, `stop took ${stop.ms}ms`);
  c.expect(stop.json?.warnings?.some((w: string) => /frame/.test(w)), "unresponsive child was not reported");
  const es = raw(start.json.eventsPath);
  c.expect(es.some((e) => e.type === 4) && es.some((e) => e.type === 2), "base snapshot was dropped before start replied");
});

scenario("duplicate-start-preserves-active-file-and-other-path", async (c) => {
  const { tabId, page } = await open(c, "record-form.html");
  const first = out("first.events.jsonl"), other = out("preserved.txt");
  writeFileSync(other, "preserve-existing-output");
  const start = await c.call("session_record_start", { tabId, eventsPath: first });
  c.expect(!start.isError, start.text);
  for (const eventsPath of [first, other]) {
    const duplicate = await c.call("session_record_start", { tabId, eventsPath });
    c.expect(duplicate.isError, "a duplicate recording start succeeded");
  }
  c.expect(readFileSync(other, "utf8") === "preserve-existing-output", "duplicate start truncated another file");
  await page.locator("#user").fill("original-recorder-still-running");
  const stop = await c.call("session_record_stop", { tabId, inlineAssets: false });
  c.expect(!stop.isError, stop.text);
  const es = raw(first);
  c.expect(es.some((e) => e.type === 2) && JSON.stringify(es).includes("original-recorder-still-running"), "original recording was replaced");
});

scenario("navigation-flushes-click-and-final-mutation", async (c) => {
  const { tabId, page } = await open(c, "record-race.html");
  const start = await c.call("session_record_start", { tabId });
  await sleep(750);
  await Promise.all([page.waitForURL(/record-page2/), page.click("#next")]);
  await sleep(500);
  const stop = await c.call("session_record_stop", { tabId, inlineAssets: false });
  c.expect(!stop.isError, stop.text);
  const es = raw(start.json.eventsPath);
  c.expect(es.filter((e) => e.type === 4).length === 2, "missing or duplicated a navigation segment");
  c.expect(es.some((e) => e.type === 3 && e.data?.source === 2 && e.data?.type === 2), "navigation click was lost");
  c.expect(es.some((e) => e.type === 3 && e.data?.source === 0 && JSON.stringify(e.data).includes("FINAL-NAV-MUTATION-741")), "final mutation was lost");
});

scenario("masking-covers-shadow-inputs-editors-and-key-codes", async (c) => {
  const { tabId, page } = await open(c, "record-mask.html");
  const start = await c.call("session_record_start", { tabId, maskInputs: true });
  const selectors = ["#plain", "#password", "#area", "#editor", "#host input"];
  const secrets = selectors.map((_, i) => `Private${i}Az781`);
  for (let i = 0; i < selectors.length; i++) { await page.locator(selectors[i]).click(); await page.keyboard.type(secrets[i], { delay: 5 }); }
  await page.keyboard.press("ArrowLeft");
  const stop = await c.call("session_record_stop", { tabId, inlineAssets: false });
  c.expect(!stop.isError, stop.text);
  const es = raw(start.json.eventsPath), json = JSON.stringify(es), html = readFileSync(stop.json.saved, "utf8");
  for (const secret of secrets) c.expect(!json.includes(secret) && !html.includes(secret), `masked value leaked: ${secret}`);
  const keys = es.filter((e) => e.type === 5 && e.data?.tag === "bb-key").map((e) => e.data.payload);
  c.expect(keys.filter((k) => k.key === "•").length >= secrets.join("").length, "printable keys were not masked");
  c.expect(!keys.some((k) => /^Key|^Digit/.test(k.code || "")), "masked printable key codes still identify characters");
  c.expect(keys.some((k) => k.key === "ArrowLeft"), "non-printable navigation keys should remain");
});

// Decode a browser PNG without another image dependency: Chromium supplies actual composited pixels.
async function pixel(page: Page, png: Buffer, x: number, y: number): Promise<number[]> {
  return page.evaluate(async ({ b64, x, y }) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext("2d")!; ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(x, y, 1, 1).data);
  }, { b64: png.toString("base64"), x, y });
}
const near = (rgb: number[], expected: number[]) => expected.every((v, i) => Math.abs(rgb[i] - v) < 35);

let canvasHtml = "";
scenario("canvas-pixels-visible-offline-playback-seeking-and-navigation", async (c) => {
  const { tabId, page } = await open(c, "record-canvas.html");
  await page.setViewportSize({ width: 1600, height: 1000 });
  const start = await c.call("session_record_start", { tabId, recordCanvas: true, canvasFps: 8 });
  await sleep(700);
  await page.goto(h.fixtureUrl("record-canvas.html?second=1"));
  await sleep(850);
  const stop = await c.call("session_record_stop", { tabId, savePath: out("canvas.html"), title: "Clean replay" });
  c.expect(!stop.isError, stop.text);
  canvasHtml = stop.json.saved;
  copyFileSync(canvasHtml, join(ARTIFACTS, "recording-canvas.html"));
  const es = raw(start.json.eventsPath), meta = es.filter((e) => e.type === 4);
  copyFileSync(start.json.eventsPath, join(ARTIFACTS, "recording-canvas.events.jsonl"));
  c.note(`canvas ids: ${[...new Set(es.filter((e) => e.type === 3 && e.data?.source === 9).map((e) => e.data.id))].join(",")}`);
  c.expect(es.filter((e) => e.type === 3 && e.data?.source === 9).length >= 4, "canvas frames were not captured");
  const first = es.find((e) => e.type === 3 && e.data?.source === 9)!.timestamp - es[0].timestamp;
  const second = meta[1].timestamp - es[0].timestamp;
  const html = readFileSync(canvasHtml, "utf8");
  c.expect(!html.includes("FRACTURE") && !html.includes('id="bb-meta"'), "branding or decorative header remains");
  const replay = await h.context!.newPage();
  try {
    const external: string[] = [];
    await replay.route(/^https?:/, (route) => { external.push(route.request().url()); return route.abort(); });
    await replay.goto("file://" + canvasHtml, { waitUntil: "domcontentloaded" });
    await replay.waitForFunction(() => !!(window as any).__bbExport && (window as any).__bbExport.framesReady());
    await replay.setViewportSize({ width: 1600, height: 1000 });
    // Seek backwards across the document boundary as well as forwards. Canvas ids restart per page.
    for (const [t, color] of [[first + 250, [255, 0, 0]], [second + 350, [0, 255, 0]], [first + 250, [255, 0, 0]]] as const) {
      await replay.evaluate(async (t) => { const e = (window as any).__bbExport; e.enterMode(false); await e.renderAt(t); }, t);
      const png = await replay.screenshot();
      writeFileSync(join(ARTIFACTS, "recording-pixels-debug.png"), png);
      c.expect(near(await pixel(replay, png, 40, 80), [...color]), `canvas 2D pixels missing at ${t}`);
      c.expect(near(await pixel(replay, png, 260, 80), color[1] ? [255, 255, 0] : [0, 0, 255]), `WebGL pixels missing at ${t}`);
      c.expect(near(await pixel(replay, png, 40, 240), [255, 255, 0]), "same-origin iframe canvas blank");
      c.expect(near(await pixel(replay, png, 180, 240), [0, 255, 255]), "shadow canvas blank");
    }
    // Before the first bitmap, restore the recorded background rather than retaining a future frame.
    await replay.evaluate(async () => { await (window as any).__bbExport.renderAt(0); });
    c.expect(near(await pixel(replay, await replay.screenshot(), 40, 80), [238, 238, 238]), "backward seek retained a future canvas frame");
    c.expect(external.length === 0, `offline replay requested external assets: ${external.join(", ")}`);
    // Ordinary playback and the minimal controls use the same bitmap path as export.
    await replay.reload({ waitUntil: "domcontentloaded" });
    await replay.waitForFunction(() => !!(window as any).__bbExport && (window as any).__bbExport.framesReady());
    await replay.click("#bb-play"); await sleep(450); await replay.click("#bb-play");
    const point = await replay.evaluate(() => {
      const iframe = document.querySelector(".replayer-wrapper iframe") as HTMLIFrameElement;
      const r = iframe.getBoundingClientRect(), scale = r.width / iframe.clientWidth;
      return { x: Math.round(r.x + 40 * scale), y: Math.round(r.y + 80 * scale) };
    });
    c.expect(near(await pixel(replay, await replay.screenshot(), point.x, point.y), [255, 0, 0]), "ordinary playback canvas is blank");
    await replay.click('#bb-speeds [data-s="2"]');
    c.expect(await replay.locator('#bb-speeds [data-s="2"]').evaluate((el) => el.classList.contains("on")), "speed control failed");
    c.expect(await replay.title() === "Clean replay", "supplied title was not retained in document metadata");
    await replay.screenshot({ path: join(ARTIFACTS, "recording-clean-replay.png") });
  } finally { await replay.close(); }
});

scenario("mp4-pixels-dimensions-controls-and-failure-cleanup", async (c) => {
  if (!canvasHtml) throw new Error("canvas fixture did not produce a replay");
  const decoder = await h.context!.newPage();
  try {
    for (const scale of [1, 2]) {
      const video = await c.call("render_recording_video", { htmlPath: canvasHtml, out: out(`canvas-${scale}.mp4`), fps: 2, scale, crf: 20, settleMs: 0 }, { timeoutMs: 120_000 });
      c.expect(!video.isError, video.text);
      if (video.isError) continue;
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,codec_name", "-of", "json", video.json.saved], { encoding: "utf8" })).streams[0];
      c.expect(probe.width === 1600 * scale && probe.height === 1000 * scale, `wrong export dimensions ${JSON.stringify(probe)}`);
      c.expect(video.json.width === probe.width && video.json.height === probe.height, "returned dimensions do not match decoded video");
      c.expect(probe.codec_name === "h264" && Number(probe.nb_read_frames) === video.json.frames, "codec/frame count mismatch");
      const png = execFileSync("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", video.json.saved, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { maxBuffer: 20_000_000 });
      c.expect(near(await pixel(decoder, png, 40 * scale, 80 * scale), [255, 0, 0]), "decoded MP4 lost the 2D canvas");
      c.expect(near(await pixel(decoder, png, 260 * scale, 80 * scale), [0, 0, 255]), "decoded MP4 lost WebGL");
      if (scale === 1) { copyFileSync(video.json.saved, join(ARTIFACTS, "recording-canvas.mp4")); writeFileSync(join(ARTIFACTS, "recording-canvas-frame.png"), png); }
    }
    const controls = await c.call("render_recording_video", { htmlPath: canvasHtml, out: out("controls.mp4"), fps: 1, scale: 1, chrome: true }, { timeoutMs: 90_000 });
    c.expect(!controls.isError && controls.json?.width === 1600 && controls.json?.height === 1064, controls.text);
    const oldHtml = out("old-replay.html");
    writeFileSync(oldHtml, '<!doctype html><script>window.__bbExport={total:700,vw:320,vh:240,enterMode:()=>true,renderAt:()=>true,framesReady:()=>true}</script>');
    const old = await c.call("render_recording_video", { htmlPath: oldHtml, out: out("old.mp4"), fps: 1, scale: 1 });
    c.expect(!old.isError && old.json?.width === 320 && old.json?.height === 240, "legacy synchronous harness compatibility failed");
    writeFileSync(oldHtml, '<!doctype html><script>window.__bbExport={total:700,vw:321,vh:241,enterMode:()=>true,renderAt:()=>true}</script>');
    const odd = await c.call("render_recording_video", { htmlPath: oldHtml, out: out("odd.mp4"), fps: 1, scale: 1.251 });
    c.expect(!odd.isError && odd.json?.width === 402 && odd.json?.height === 300, `fractional scale and odd dimensions: ${odd.text}`);
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("bb-frames-")));
    const broken = out("broken.html");
    writeFileSync(broken, '<!doctype html><script>window.__bbExport={total:1000,vw:320,vh:240,version:2,enterMode:()=>true,framesReady:()=>true,renderAt:()=>Promise.reject(new Error("seek failed"))}</script>');
    const failed = await c.call("render_recording_video", { htmlPath: broken, out: out("failed.mp4"), fps: 1, scale: 1 });
    c.expect(failed.isError && /seek failed/.test(failed.text), "render errors were swallowed");
    c.expect(!existsSync(out("failed.mp4")), "failed render wrote a successful-looking MP4");
    c.expect(!readdirSync(h.tmpRoot).some((n) => n.startsWith(".bb-video-")), "failed render leaked its encoding directory");
    c.expect(readdirSync(tmpdir()).filter((n) => n.startsWith("bb-frames-") && !before.has(n)).length === 0, "failed render leaked its frame directory");
    const tabs = await c.call("tabs_list", {});
    c.expect(!(tabs.json ?? []).some((t: any) => t.url === "file://" + broken), "failed render left its tab open");
  } finally { await decoder.close(); }
}, 240_000);
