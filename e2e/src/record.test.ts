// browser-bridge e2e: watch mode, session recording (+ MP4 export), playbook record/save, and
// environment emulation. Own Harness (own server, Chromium, temp HOME). Each scenario asserts the
// CORRECT behaviour; a failure is a product bug, not a reason to relax the assertion.
//
// The "human" is Playwright input on the real page (CDP Input.* events: isTrusted, not tagged as the
// agent's). Files the server writes land under <harness tmpRoot>/home (its HOME), checked on disk here.
import { before, after } from "node:test";
import { existsSync, readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "playwright-core";
import { Harness, trim } from "./harness.js";
import { scenario as defineScenario, printSummary, type Ctx } from "./scenario.js";

let h: Harness;
const scenario = (name: string, fn: (c: Ctx) => Promise<void>, opts?: { timeout?: number }) => defineScenario(() => h, name, fn, opts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = () => join(h.tmpRoot, "home");

before(async () => {
  h = new Harness({ logName: "server-record.log" });
  try {
    await h.setup();
  } catch (e) {
    await h.teardown();
    throw e;
  }
  console.log(`[e2e:record] bridge :${h.bridgePort}  fixtures :${h.fixturePort}  home ${home()}  tools=${h.toolSchemas.size}`);
}, { timeout: 90_000 });

after(async () => {
  printSummary();
  await h?.teardown();
}, { timeout: 60_000 });

// ---- helpers ------------------------------------------------------------------------------------

/** Open a fixture under a unique query (so its Playwright Page can be found by URL); returns both handles. */
async function openHuman(c: Ctx, fixture: string, tag: string): Promise<{ tabId: number; page: Page; url: string }> {
  const path = `${fixture}?s=${tag}-${Date.now()}`;
  const tabId = await c.open(path);
  const url = c.h.fixtureUrl(path);
  const page = await findPage((p) => p.url() === url);
  await page.waitForLoadState("load");
  return { tabId, page, url };
}

async function findPage(pred: (p: Page) => boolean, timeoutMs = 10_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = h.context!.pages().find(pred);
    if (p) return p;
    await sleep(100);
  }
  throw new Error("Playwright page not found");
}

/** Split a text-mode watch_read into its meta (first line) and the timeline lines. */
function parseRead(text: string): { meta: any; header: string; lines: string[] } {
  const all = text.split("\n");
  let meta: any = {};
  try {
    meta = JSON.parse(all[0]);
  } catch {
    /* not a meta line */
  }
  const rest = all.slice(1).filter((l) => !l.startsWith("NOTE "));
  const header = rest.find((l) => l.startsWith("WATCH ")) ?? "";
  return { meta, header, lines: rest.filter((l) => /\s#\d+\s/.test(l)) };
}

/** Follow the cursor (long-polling) until `done(lines so far)` or the deadline. */
async function readUntil(c: Ctx, since: string, done: (lines: string[]) => boolean, timeoutMs = 15_000) {
  const lines: string[] = [];
  let cursor = since;
  let meta: any = {};
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await c.call("watch_read", { since: cursor, waitMs: 2_000 });
    if (r.isError) throw new Error(`watch_read failed: ${trim(r.text, 200)}`);
    const p = parseRead(r.text);
    meta = p.meta;
    lines.push(...p.lines);
    if (meta.nextCursor) cursor = meta.nextCursor;
    if (done(lines)) break;
  }
  return { lines, cursor, meta };
}

/** A captured net row's response body as text (octet-stream bodies come back base64). */
const bodyText = (row: any): string => {
  const b = row?.responseBody;
  if (typeof b !== "string") return "";
  return row.responseBodyBase64 ? Buffer.from(b, "base64").toString("utf8") : b;
};
const seqOf = (line: string) => Number(/#(\d+)\s/.exec(line)?.[1]);
const has = (lines: string[], re: RegExp) => lines.some((l) => re.test(l));
const readJsonl = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

async function stopAllWatches(c: Ctx) {
  for (let i = 0; i < 3; i++) {
    const s = await c.h.call("watch_status", {});
    const ws = (s.json?.watches ?? []) as any[];
    if (!ws.length) return;
    for (const w of ws) await c.h.call("watch_stop", { watchId: w.watchId }).catch(() => undefined);
  }
}

// =================================================================================================
// WATCH MODE
// =================================================================================================

let fullWatchDigest = ""; // reused by the file-mode scenario

scenario(
  "watch-human-timeline",
  async (c) => {
    await stopAllWatches(c);
    const { tabId, page } = await openHuman(c, "record-form.html", "watch1");
    const ws = await c.call("watch_start", {
      tabId,
      redact: "auto",
      retain: "digest",
      digestPath: "~/.browser-bridge/watch/record-e2e.jsonl",
      network: true,
      networkBodies: true,
      console: true,
    });
    c.expect(!ws.isError && ws.json?.watching === true, `watch_start failed: ${trim(ws.text, 200)}`);
    const start = ws.json?.cursor as string;
    const watchId = ws.json?.watchId as string;
    const digestPath = ws.json?.digestPath as string;
    c.expect(typeof start === "string" && start.startsWith(watchId), `cursor ${start} does not name watch ${watchId}`);
    c.expect(digestPath === join(home(), ".browser-bridge/watch/record-e2e.jsonl"), `digestPath ~ not expanded into the server HOME: ${digestPath}`);
    c.expect(ws.json?.banner === true, "network:true should report banner:true");
    c.expect(ws.json?.redact === "auto", `redact echoed as ${ws.json?.redact}`);
    c.expect(typeof ws.json?.networkPath === "string", `no networkPath for network:true: ${trim(ws.text, 200)}`);
    try {
      // watch_status while live
      const st = await c.call("watch_status", {});
      const w = (st.json?.watches ?? []).find((x: any) => x.watchId === watchId);
      c.expect(w?.health?.state === "live", `watch_status state=${w?.health?.state} (want live)`);
      c.expect(w?.tabs?.includes(tabId), `watch_status tabs ${JSON.stringify(w?.tabs)} lacks ${tabId}`);
      c.expect(w?.digestPath === digestPath, "watch_status digestPath mismatch");
      c.expect(st.json?.extensionConnected === true, "watch_status says the extension is disconnected");

      // ---- the human ----
      await page.click("#user");
      await page.keyboard.type("alice", { delay: 40 });
      await page.click("#pass");
      await page.keyboard.type("hunter2", { delay: 40 });
      await page.click("#remember");
      await page.click("#load");
      await page.waitForFunction(() => document.getElementById("out")!.textContent!.includes("record-data-payload"));
      await page.click("#boom");
      await sleep(300);
      // ---- the agent, on the same watched tab ----
      const ac = await c.call("click", { selector: "#ping", tabId });
      c.expect(!ac.isError, `agent click failed: ${trim(ac.text, 160)}`);
      await sleep(2_000); // well clear of the agent call (attribution is checked in watch-agent-vs-human-attribution)
      // ---- the human submits (POST -> navigation) ----
      await Promise.all([page.waitForURL(/record-done\.html/), page.click("#submit")]);

      const { lines, cursor } = await readUntil(c, start, (ls) => has(ls, /nav\s+\/record-done\.html/) && has(ls, /net\s+POST \/record-done\.html/), 20_000);
      c.note(`timeline (${lines.length} lines): ${trim(lines.join(" ⏎ "), 900)}`);
      const human = lines.filter((l) => !/\[agent\]/.test(l));
      c.expect(has(human, /click\s+<input#user> "Username"/), "no labeled human click on <input#user> \"Username\"");
      c.expect(has(human, /input\s+<input#user> "Username" = "alice"\s+\(5 keys/), "no coalesced input line `<input#user> = \"alice\" (5 keys`");
      const passLine = lines.find((l) => /input\s+<input#pass>/.test(l));
      c.expect(!!passLine, "no input line for the password field");
      c.expect(!lines.some((l) => l.includes("hunter2")), "password typed value leaked in cleartext into the timeline");
      c.expect(!!passLine && /•••• \(7 chars\)/.test(passLine), `password not redacted as •••• (7 chars): ${passLine}`);
      c.expect(has(human, /input\s+<input#remember>/) || has(human, /click\s+<input#remember>/), "checkbox interaction missing");
      c.expect(has(human, /click\s+<button#load> "Load data"/), "no labeled click on button#load \"Load data\"");
      c.expect(has(lines, /net\s+GET \/record-data\.txt\?from=load → 200/), "no `net GET /record-data.txt?from=load → 200` line");
      c.expect(has(lines, /console\s+error .*RECORD-BOOM-5150/), "uncaught error RECORD-BOOM-5150 not folded in as a console line");
      const agentLine = lines.find((l) => /click\s+<button#ping>/.test(l));
      c.expect(!!agentLine && /\[agent\]/.test(agentLine), `agent's click not labeled [agent]: ${agentLine}`);
      const misLabeled = lines.filter((l) => !/<button#ping>/.test(l) && /\[agent\]/.test(l));
      c.expect(misLabeled.length === 0, `human actions labeled [agent]: ${trim(misLabeled.join(" | "), 300)}`);
      const submit = lines.find((l) => /submit\s+<form#login>/.test(l));
      c.expect(!!submit, "no submit <form#login> line");
      c.expect(!!submit && /user="alice"/.test(submit) && /remember="yes"/.test(submit), `submit fields wrong: ${submit}`);
      c.expect(!!submit && !submit.includes("hunter2") && /pass="•••• \(7 chars\)"/.test(submit), `submit leaked/unmasked pass: ${submit}`);
      c.expect(has(lines, /nav\s+\/record-done\.html.*"Signed in"/), "no nav line to /record-done.html \"Signed in\"");
      c.expect(has(lines, /net\s+POST \/record-done\.html → 200/), "no `net POST /record-done.html → 200` line");
      // order: submit before nav
      const sSeq = submit ? seqOf(submit) : NaN;
      const nSeq = seqOf(lines.find((l) => /nav\s+\/record-done/.test(l)) ?? "");
      c.expect(sSeq < nSeq, `submit #${sSeq} should precede nav #${nSeq}`);

      // ---- cursor semantics ----
      const empty = await c.call("watch_read", { since: cursor, waitMs: 0 });
      const ep = parseRead(empty.text);
      c.expect(ep.lines.length === 0, `reading at the head returned ${ep.lines.length} actions`);
      c.expect(ep.meta.nextCursor === cursor, `head read moved the cursor ${cursor} -> ${ep.meta.nextCursor}`);
      c.expect(ep.meta.health?.state === "live", `health ${ep.meta.health?.state}`);
      const again = parseRead((await c.call("watch_read", { since: start, limit: 1000 })).text);
      const seqsIncremental = lines.map(seqOf);
      c.expect(seqsIncremental.every((s) => again.lines.some((l) => seqOf(l) === s)), "re-reading from the start cursor did not return the same actions");
      // paging with limit: no dupes, no gaps
      const p1 = parseRead((await c.call("watch_read", { since: start, limit: 3 })).text);
      c.expect(p1.lines.length === 3 && p1.meta.more === true, `limit:3 -> ${p1.lines.length} lines more=${p1.meta.more}`);
      const p2 = parseRead((await c.call("watch_read", { since: p1.meta.nextCursor, limit: 3 })).text);
      c.expect(p2.lines.length > 0 && seqOf(p2.lines[0]) > seqOf(p1.lines[2]), "page 2 overlaps page 1");
      c.expect(seqOf(p2.lines[0]) === again.lines.map(seqOf).find((s) => s > seqOf(p1.lines[2])), "page 2 skipped an action");
      // a cursor from another incarnation is reported as reset
      const stale = await c.call("watch_read", { since: `${watchId}.bogusepoch:3`, limit: 5 });
      c.expect(parseRead(stale.text).meta.reset === true, `foreign-epoch cursor not reported reset: ${trim(stale.text, 160)}`);
      // include filter
      const onlyClicks = parseRead((await c.call("watch_read", { since: start, include: ["click"], limit: 1000 })).text);
      c.expect(onlyClicks.lines.length >= 4 && onlyClicks.lines.every((l) => /\sclick\s/.test(l)), `include:[click] returned non-click lines: ${trim(onlyClicks.lines.join(" | "), 300)}`);

      // ---- long poll: blocks until the human acts, then returns promptly ----
      const idle = await c.call("watch_read", { since: cursor, waitMs: 1_500 });
      c.expect(parseRead(idle.text).lines.length === 0 && idle.ms >= 1_300 && idle.ms < 5_000, `idle waitMs:1500 returned in ${idle.ms}ms with ${parseRead(idle.text).lines.length} lines`);
      await page.goto(c.h.fixtureUrl("record-page2.html?lp=1")); // human navigates back to a page with a button
      const afterNav = await readUntil(c, cursor, (ls) => has(ls, /nav\s+\/record-page2\.html/), 10_000);
      const lpPromise = c.call("watch_read", { since: afterNav.cursor, waitMs: 12_000 });
      await sleep(1_200);
      const clickedAt = Date.now();
      await page.click("#two");
      const lp = await lpPromise;
      const lpl = parseRead(lp.text).lines;
      c.note(`long-poll returned after ${lp.ms}ms (${Date.now() - clickedAt}ms after the click): ${trim(lpl.join(" | "), 200)}`);
      c.expect(has(lpl, /click\s+<button#two> "Second button"/), "long poll did not return the click");
      c.expect(lp.ms >= 1_000 && lp.ms < 6_000, `long poll took ${lp.ms}ms (want: blocked until the click, then prompt)`);

      // ---- watch_read format:json + watch_detail ----
      const j = await c.call("watch_read", { since: start, format: "json", limit: 1000 });
      const actions = (j.json?.actions ?? []) as any[];
      const getNet = actions.find((a) => a.kind === "net" && /record-data\.txt/.test(a.url));
      const postNet = actions.find((a) => a.kind === "net" && a.method === "POST" && /record-done\.html/.test(a.url));
      const userClick = actions.find((a) => a.kind === "click" && a.target?.id === "user");
      c.expect(userClick?.target?.selector && typeof userClick.target.selector === "string", "click action has no target.selector");
      c.expect(getNet?.requestId, "net action has no requestId in format:json");
      if (getNet) {
        const d = await c.call("watch_detail", { seq: getNet.seq });
        c.expect(!d.isError && d.json?.requestId === getNet.requestId && d.json?.method === "GET" && d.json?.status === 200, `watch_detail(seq): ${trim(d.text, 300)}`);
        c.expect(bodyText(d.json).includes("record-data-payload-8812"), `watch_detail(seq) lacks the response body: keys=${Object.keys(d.json ?? {}).join(",")}`);
      }
      if (postNet) {
        const d = await c.call("watch_detail", { requestId: postNet.requestId });
        const s = JSON.stringify(d.json ?? d.text);
        c.expect(!d.isError && /user=alice/.test(s), `watch_detail(requestId) lacks the POST body: ${trim(d.text, 300)}`);
        c.expect(bodyText(d.json).includes("RECORD-DONE-MARKER"), "POST response body not captured although the document was replaced (networkBodies:true)");
      } else c.expect(false, "no POST net action in format:json");
      if (userClick) {
        const d = await c.call("watch_detail", { seq: userClick.seq });
        c.expect(d.isError && /is a 'click', not a captured request/.test(d.text), `watch_detail on a click should explain it is not a request: ${trim(d.text, 200)}`);
      }

      // ---- digest on disk (while live) ----
      c.expect(existsSync(digestPath), `digest not on disk: ${digestPath}`);
      const netFile = `${digestPath.replace(/\.jsonl$/, "")}.net.${tabId}.jsonl`;
      c.expect(existsSync(netFile), `network capture file missing: ${netFile}`);
      if (existsSync(netFile)) {
        const netRows = readJsonl(netFile);
        c.expect(netRows.some((r: any) => /record-data\.txt/.test(r.url ?? "") && bodyText(r).includes("record-data-payload-8812")), "network JSONL lacks the fetched response body");
      }
    } finally {
      const stop = await c.call("watch_stop", {});
      c.expect(stop.json?.stopped === true && stop.json?.watchId === watchId, `watch_stop: ${trim(stop.text, 200)}`);
      c.expect(stop.json?.actions > 5, `watch_stop actions=${stop.json?.actions}`);
      c.expect(stop.json?.digestPath === digestPath, "watch_stop digestPath mismatch");
    }
    const rows = readJsonl(digestPath);
    c.expect(rows[0]?.kind === "watch-header" && rows[0]?.watchId === watchId && rows[0]?.rootTabId === tabId, `digest header wrong: ${JSON.stringify(rows[0])}`);
    const dInput = rows.find((r: any) => r.kind === "input" && r.target?.id === "user");
    const dPass = rows.find((r: any) => r.kind === "input" && r.target?.id === "pass");
    c.expect(dInput?.value === "alice", `digest input value ${dInput?.value}`);
    c.expect(dPass?.redacted === true && !readFileSync(digestPath, "utf8").includes("hunter2"), "digest has the cleartext password or no redacted flag");
    c.expect(rows.some((r: any) => r.kind === "submit") && rows.some((r: any) => r.kind === "nav" && /record-done/.test(r.url)), "digest lacks submit/nav rows");
    fullWatchDigest = digestPath;

    // after stop: status lists nothing live; a live read is not 'live'
    const st2 = await c.call("watch_status", {});
    c.expect(!(st2.json?.watches ?? []).some((w: any) => w.watchId === watchId && w.health?.state === "live"), "watch still live after watch_stop");
    const post = await c.call("watch_read", { since: start });
    const pm = parseRead(post.text).meta;
    c.note(`watch_read(since) after stop -> ${trim(post.text, 220)}`);
    c.expect(post.isError || pm.health?.state !== "live", "watch_read after stop still reports live");
    c.expect(!/server restarted|recovering/.test(post.text), `watch_read on a deliberately stopped watch claims a server restart / 'retry shortly': ${trim(post.text, 200)}`);
  },
  { timeout: 150_000 }
);

// docs/WATCH.md: an action the AGENT issues is labeled [agent], so "what did I do" excludes it. A human
// click shortly after an agent call is still the human's.
scenario("watch-agent-vs-human-attribution", async (c) => {
  await stopAllWatches(c);
  const { tabId, page } = await openHuman(c, "record-form.html", "attr");
  const ws = await c.call("watch_start", { tabId, retain: "none" });
  c.expect(!ws.isError, `watch_start: ${trim(ws.text, 160)}`);
  try {
    await sleep(300);
    const ac = await c.call("click", { selector: "#ping", tabId });
    c.expect(!ac.isError, `agent click: ${trim(ac.text, 160)}`);
    await sleep(400);
    await page.click("#load"); // the human, 400ms after the agent's call returned
    await sleep(2_500);
    await page.click("#boom"); // the human, well after
    const { lines } = await readUntil(c, ws.json.cursor, (ls) => has(ls, /click\s+<button#boom>/), 10_000);
    c.note(`attribution -> ${trim(lines.join(" | "), 400)}`);
    const agent = lines.find((l) => /click\s+<button#ping>/.test(l));
    const humanSoon = lines.find((l) => /click\s+<button#load>/.test(l));
    const humanLate = lines.find((l) => /click\s+<button#boom>/.test(l));
    c.expect(!!agent && /\[agent\]$/.test(agent), `agent click not labeled [agent]: ${agent}`);
    c.expect(!!humanLate && !/\[agent\]/.test(humanLate), `late human click labeled [agent]: ${humanLate}`);
    c.expect(!!humanSoon && !/\[agent\]/.test(humanSoon), `human click 400ms after an agent call was labeled [agent]: ${humanSoon}`);
  } finally {
    await c.call("watch_stop", {});
  }
});

scenario("watch-read-file-mode", async (c) => {
  if (!fullWatchDigest) throw new Error("depends on watch-human-timeline's digest");
  const r = await c.call("watch_read", { file: fullWatchDigest, limit: 1000 });
  c.expect(!r.isError && r.text.startsWith(`WATCH  file  ${fullWatchDigest}`), `file header: ${trim(r.text, 160)}`);
  const lines = r.text.split("\n").filter((l) => /\s#\d+\s/.test(l));
  c.expect(has(lines, /input\s+<input#user> "Username" = "alice"/), "file mode lacks the input line");
  c.expect(has(lines, /submit\s+<form#login>/) && has(lines, /nav\s+\/record-done\.html/), "file mode lacks submit/nav");
  c.expect(!r.text.includes("hunter2"), "file mode leaks the password");
  const mid = seqOf(lines[Math.floor(lines.length / 2)]);
  const tail = await c.call("watch_read", { file: fullWatchDigest, since: `x.y:${mid}`, limit: 1000 });
  const tl = tail.text.split("\n").filter((l) => /\s#\d+\s/.test(l));
  c.expect(tl.length > 0 && tl.every((l) => seqOf(l) > mid), `file mode 'since' not honored (mid=${mid})`);
  const j = await c.call("watch_read", { file: fullWatchDigest, format: "json", include: ["submit"] });
  c.expect(j.json?.actions?.length === 1 && j.json.actions[0].kind === "submit", `file json include:[submit] -> ${trim(j.text, 200)}`);
  const missing = await c.call("watch_read", { file: join(home(), "nope.jsonl") });
  c.expect(missing.isError && /not found/.test(missing.text), `missing digest: ${trim(missing.text, 160)}`);
});

scenario("watch-options-include-redact-retain", async (c) => {
  await stopAllWatches(c);
  // (a) include:[click,input] + redact:all + retain:none
  const a = await openHuman(c, "record-form.html", "watchopt-a");
  const watchDir = join(home(), ".browser-bridge", "watch");
  const before = existsSync(watchDir) ? readdirSync(watchDir).length : 0;
  const ws = await c.call("watch_start", { tabId: a.tabId, include: ["click", "input"], redact: "all", retain: "none" });
  c.expect(!ws.isError && ws.json?.digestPath === undefined, `retain:none still has a digestPath: ${trim(ws.text, 200)}`);
  c.expect(ws.json?.banner === false, "banner should be false without network");
  try {
    await a.page.click("#user");
    await a.page.keyboard.type("bob", { delay: 30 });
    await a.page.click("#boom"); // console - excluded by include
    await Promise.all([a.page.waitForURL(/record-page2/), a.page.click("#next")]); // nav - excluded
    const { lines } = await readUntil(c, ws.json.cursor, (ls) => has(ls, /click\s+<a#next>/), 10_000);
    c.note(`include/redact:all -> ${trim(lines.join(" | "), 300)}`);
    c.expect(lines.length > 0 && lines.every((l) => /\s(click|input)\s/.test(l)), `include:[click,input] let other kinds through: ${trim(lines.join(" | "), 300)}`);
    const inp = lines.find((l) => /input\s+<input#user>/.test(l));
    c.expect(!!inp && !inp.includes("bob") && /•••• \(3 chars\)/.test(inp), `redact:all did not mask a plain text field: ${inp}`);
    const after = existsSync(watchDir) ? readdirSync(watchDir).length : 0;
    c.expect(after === before, `retain:none wrote a digest file (${before} -> ${after})`);
  } finally {
    await c.call("watch_stop", {});
  }

  // (b) redact:none + console:false
  const b = await openHuman(c, "record-form.html", "watchopt-b");
  const ws2 = await c.call("watch_start", { tabId: b.tabId, redact: "none", console: false, retain: "none" });
  c.expect(!ws2.isError, `watch_start(b): ${trim(ws2.text, 160)}`);
  try {
    await b.page.click("#pass");
    await b.page.keyboard.type("plainpw9", { delay: 30 });
    await b.page.click("#boom");
    await sleep(500);
    await b.page.click("#ping");
    const { lines } = await readUntil(c, ws2.json.cursor, (ls) => has(ls, /click\s+<button#ping>/), 10_000);
    c.note(`redact:none -> ${trim(lines.join(" | "), 300)}`);
    c.expect(has(lines, /input\s+<input#pass> "Password" = "plainpw9"/), "redact:none did not keep the password field raw");
    c.expect(!has(lines, /console\s/), "console:false still captured the uncaught error");
  } finally {
    await c.call("watch_stop", {});
  }
});

scenario("watch-multi-tab", async (c) => {
  await stopAllWatches(c);
  const { tabId, page } = await openHuman(c, "record-form.html", "watchmulti");
  const ws = await c.call("watch_start", { tabId, retain: "none" });
  c.expect(!ws.isError, `watch_start: ${trim(ws.text, 160)}`);
  try {
    await sleep(300);
    const [popup] = await Promise.all([h.context!.waitForEvent("page", { timeout: 10_000 }), page.click("#popup")]);
    await popup.waitForLoadState("load");
    const tl = await c.call("tabs_list", {});
    const tabs = (tl.json?.tabs ?? tl.json ?? []) as any[];
    const child = Array.isArray(tabs) ? tabs.find((t: any) => /record-page2\.html\?popup=1/.test(t.url ?? "")) : undefined;
    if (child?.id ?? child?.tabId) c.tabs.push(child.id ?? child.tabId);
    const childId = child?.id ?? child?.tabId;
    c.expect(typeof childId === "number", `child tab not in tabs_list: ${trim(tl.text, 200)}`);
    await sleep(800);
    await popup.click("#two");
    await popup.click("#note");
    await popup.keyboard.type("in-child", { delay: 30 });
    await popup.keyboard.press("Tab");
    await readUntil(c, ws.json.cursor, (ls) => has(ls, /input\s+<input#note>/), 15_000);
    // one read spanning both tabs: every line carries its tab
    const lines = parseRead((await c.call("watch_read", { since: ws.json.cursor, limit: 1000 })).text).lines;
    c.note(`multi-tab -> ${trim(lines.join(" | "), 500)}`);
    c.expect(lines.every((l) => /^\[t\d+\] /.test(l)), "a multi-tab read has lines without a [t<tab>] prefix");
    const ja = ((await c.call("watch_read", { since: ws.json.cursor, format: "json", limit: 1000 })).json?.actions ?? []) as any[];
    c.expect(ja.some((a) => a.tabId === childId && a.kind === "click" && a.target?.id === "two"), "json: child click not attributed to the child tab");
    c.expect(ja.some((a) => a.tabId === childId && a.kind === "tab"), "json: no tab event for the followed tab");
    c.expect(has(lines, new RegExp(`^\\[t${tabId}\\] .*click\\s+<a#popup>`)), "parent's click not prefixed with its tab");
    c.expect(has(lines, new RegExp(`^\\[t${childId}\\] .*click\\s+<button#two>`)), "child tab's click missing / not prefixed [t<child>]");
    c.expect(has(lines, new RegExp(`^\\[t${childId}\\] .*input\\s+<input#note> "Note" = "in-child"`)), "child tab's typing missing");
    const st = await c.call("watch_status", {});
    const w = (st.json?.watches ?? [])[0];
    c.expect(w?.tabs?.includes(tabId) && w?.tabs?.includes(childId), `watch_status tabs ${JSON.stringify(w?.tabs)} should include both`);
    const only = await c.call("watch_read", { since: ws.json.cursor, tabId: childId, limit: 1000 });
    const ol = parseRead(only.text).lines;
    c.expect(ol.length > 0 && !has(ol, /<a#popup>|<input#user>/), `watch_read({tabId: child}) included parent actions: ${trim(ol.join(" | "), 300)}`);
  } finally {
    await c.call("watch_stop", {});
  }
});

// =================================================================================================
// SESSION RECORDING + MP4
// =================================================================================================

let replayHtml = "";

scenario(
  "session-record-across-navigation",
  async (c) => {
    const { tabId, page } = await openHuman(c, "record-form.html", "rec1");
    const st0 = await c.call("session_record_start", { tabId });
    c.expect(!st0.isError && st0.json?.tabId === tabId, `session_record_start: ${trim(st0.text, 200)}`);
    const eventsPath = st0.json?.eventsPath as string;
    c.expect(typeof eventsPath === "string" && eventsPath.startsWith(join(home(), ".browser-bridge", "recordings", "session-")), `default eventsPath not under the server HOME: ${eventsPath}`);
    const dup = await c.call("session_record_start", { tabId, eventsPath });
    c.expect(dup.isError, `second start on the same events file should fail: ${trim(dup.text, 160)}`);
    await sleep(500);
    await page.click("#user");
    await page.keyboard.type("rec-user-42", { delay: 30 });
    await page.click("#ping");
    await sleep(600);
    const mid = await c.call("session_record_status", {});
    const entry = (mid.json?.recordings ?? []).find((r: any) => r.tabId === tabId);
    c.expect(entry?.path === eventsPath && entry?.written > 0, `session_record_status mid-recording: ${trim(mid.text, 200)}`);
    // across a navigation (same tab)
    await Promise.all([page.waitForURL(/record-page2\.html/), page.click("#next")]);
    await sleep(1_200);
    await page.click("#two");
    await page.click("#note");
    await page.keyboard.type("after-nav-77", { delay: 30 });
    await sleep(1_500);
    const savePath = join(home(), "replays", "record-e2e.html");
    const stop = await c.call("session_record_stop", { tabId, savePath, title: "Record E2E Replay" }, { timeoutMs: 60_000 });
    c.note(`stop -> ${trim(stop.text, 240)}`);
    c.expect(!stop.isError && stop.json?.saved === savePath, `session_record_stop: ${trim(stop.text, 200)}`);
    c.expect(stop.json?.eventCount > 10 && stop.json?.durationMs > 2_000, `eventCount=${stop.json?.eventCount} durationMs=${stop.json?.durationMs}`);
    c.expect(existsSync(savePath) && statSync(savePath).size === stop.json?.htmlBytes, "replay html missing or size != htmlBytes");
    const rows = existsSync(eventsPath) ? readJsonl(eventsPath) : [];
    const events = rows.filter((r: any) => r.kind === "rrweb").map((r: any) => r.event);
    c.expect(events.length === stop.json?.eventCount, `events JSONL has ${events.length} rrweb rows, stop reported ${stop.json?.eventCount}`);
    const metas = events.filter((e: any) => e.type === 4).map((e: any) => e.data?.href ?? "");
    const fulls = events.filter((e: any) => e.type === 2).length;
    c.expect(metas.some((u: string) => /record-form\.html/.test(u)) && metas.some((u: string) => /record-page2\.html/.test(u)), `meta hrefs do not span the navigation: ${JSON.stringify(metas)}`);
    c.expect(fulls >= 2, `only ${fulls} full snapshots (want one per document)`);
    const evText = JSON.stringify(events);
    c.expect(evText.includes("rec-user-42") && evText.includes("after-nav-77"), "typed text before/after navigation missing from events (maskInputs off)");
    c.expect(evText.includes("PAGE-TWO-CLICKED"), "post-navigation DOM mutation not recorded");
    if (existsSync(savePath)) {
      const html = readFileSync(savePath, "utf8");
      c.expect(html.includes("Record E2E Replay"), "title not in the replay");
      c.expect(html.includes("PAGE-ONE-MARKER") && html.includes("PAGE-TWO-MARKER"), "replay lacks content from both documents");
      c.expect(!/<script[^>]+src=["']https?:/i.test(html), "replay loads an external script (not self-contained)");
      c.expect(/rrweb/i.test(html), "replay has no rrweb player inlined");
    }
    const after = await c.call("session_record_status", {});
    c.expect(!(after.json?.recordings ?? []).some((r: any) => r.tabId === tabId), "recording still listed after stop");
    const again = await c.call("session_record_stop", { tabId });
    c.expect(again.isError, `stopping twice should error: ${trim(again.text, 160)}`);
    replayHtml = savePath;
  },
  { timeout: 120_000 }
);

scenario("session-record-mask-inputs", async (c) => {
  const { tabId, page } = await openHuman(c, "record-form.html", "rec-mask");
  const eventsPath = join(home(), "rec-mask", "mask.events.jsonl");
  const st = await c.call("session_record_start", { tabId, maskInputs: true, eventsPath });
  c.expect(!st.isError && st.json?.eventsPath === eventsPath, `start: ${trim(st.text, 200)}`);
  await sleep(400);
  await page.click("#user");
  await page.keyboard.type("mask-secret-991", { delay: 30 });
  await page.click("#ping");
  await sleep(1_200);
  const stop = await c.call("session_record_stop", { tabId, inlineAssets: false }, { timeoutMs: 60_000 });
  const saved = stop.json?.saved as string;
  c.expect(!stop.isError && saved === join(home(), "rec-mask", "mask.html"), `default savePath should be the events file with .html: ${trim(stop.text, 200)}`);
  c.expect(existsSync(eventsPath) && !readFileSync(eventsPath, "utf8").includes("mask-secret-991"), "maskInputs:true leaked the typed value into the events JSONL");
  c.expect(!!saved && existsSync(saved) && !readFileSync(saved, "utf8").includes("mask-secret-991"), "maskInputs:true leaked the typed value into the replay html");
});

scenario(
  "render-recording-video",
  async (c) => {
    if (!replayHtml || !existsSync(replayHtml)) throw new Error("depends on session-record-across-navigation's replay");
    const out = join(home(), "replays", "record-e2e.mp4");
    const r = await c.call("render_recording_video", { htmlPath: replayHtml, out, fps: 2, scale: 1, crf: 30, settleMs: 20 }, { timeoutMs: 60_000 });
    c.note(`render -> ${r.ms}ms ${trim(r.text, 300)}`);
    c.expect(!r.isError && r.json?.saved === out, `render_recording_video failed: ${trim(r.text, 400)}`);
    c.expect(r.json?.frames >= 2 && r.json?.fps === 2 && r.json?.scale === 1, `render result: ${trim(r.text, 200)}`);
    if (existsSync(out)) {
      const buf = Buffer.alloc(12);
      const fd = openSync(out, "r");
      readSync(fd, buf, 0, 12, 0);
      closeSync(fd);
      c.expect(buf.toString("latin1", 4, 8) === "ftyp" && statSync(out).size > 2_000, `not an MP4 (${statSync(out).size} bytes, magic ${buf.toString("hex")})`);
      // Decode it for real when ffprobe is around (it ships with ffmpeg, which the tool itself needs).
      try {
        const probe = JSON.parse(
          execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,nb_read_frames,width,height", "-of", "json", out], { encoding: "utf8" })
        ).streams?.[0];
        c.note(`ffprobe: ${JSON.stringify(probe)}`);
        c.expect(probe?.codec_name === "h264" && Number(probe?.nb_read_frames) === r.json?.frames && probe?.width > 100, `ffprobe: ${JSON.stringify(probe)}`);
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
        c.note("ffprobe not installed - decoded-frame check skipped");
      }
    } else c.expect(false, `no mp4 at ${out}`);
    const bad = await c.call("render_recording_video", { htmlPath: join(home(), "missing.html") });
    c.expect(bad.isError && /not found/.test(bad.text), `missing html: ${trim(bad.text, 160)}`);
  },
  { timeout: 90_000 }
);

// =================================================================================================
// PLAYBOOKS
// =================================================================================================

scenario("playbook-record-and-save", async (c) => {
  const { tabId } = await openHuman(c, "record-form.html", "pb");
  const notRec = await c.call("playbook_record_stop", {});
  c.expect(notRec.json?.recording === false, `stop while idle: ${trim(notRec.text, 120)}`);
  const draft = "~/.browser-bridge/playbooks/record-e2e-login.draft.jsonl";
  const draftAbs = join(home(), ".browser-bridge", "playbooks", "record-e2e-login.draft.jsonl");
  const st = await c.call("playbook_record_start", { savePath: draft });
  c.expect(st.json?.saved === draftAbs, `record start path: ${trim(st.text, 160)}`);
  await c.call("navigate", { tabId, url: c.h.fixtureUrl("record-form.html?s=pb-nav") });
  await c.call("fill", { tabId, selector: "#user", value: "pb-user" });
  await c.call("click", { tabId, selector: "#ping" });
  await c.call("get_page_text", { tabId });
  const stop = await c.call("playbook_record_stop", {});
  c.expect(stop.json?.saved === draftAbs && stop.json?.count >= 4, `record stop: ${trim(stop.text, 160)}`);
  await sleep(200);
  const rows = existsSync(draftAbs) ? readJsonl(draftAbs) : [];
  const methods = rows.map((r: any) => r.method);
  c.note(`draft methods: ${methods.join(",")}`);
  c.expect(["navigate", "fill", "click", "get_page_text"].every((m) => methods.includes(m)), `draft lacks calls: ${methods.join(",")}`);
  c.expect(rows.every((r: any) => typeof r.ts === "number" && r.params), "draft rows lack ts/params");
  c.expect(rows.some((r: any) => r.method === "fill" && r.params?.selector === "#user" && r.params?.value === "pb-user"), "fill params not recorded");
  const n = rows.length;
  await c.call("eval_js", { tabId, code: "1+1" });
  await sleep(200);
  c.expect(readJsonl(draftAbs).length === n, "calls after playbook_record_stop were still recorded");

  const md = [
    "---",
    "id: record-e2e-login",
    "name: Sign in to the record fixture",
    "goal: Fill the username and ping the page.",
    `site: ["${c.h.fixtureUrl("record-form.html")}*"]`,
    "version: 1",
    "last_verified: 2026-10-21",
    "destructive: false",
    "reversible: true",
    "tags: [e2e, login]",
    "tools: [navigate, fill, click, get_page_text]",
    "params:",
    "  username: { desc: the account name to type, example: pb-user, required: true }",
    "preconditions:",
    "  - The record fixture is served.",
    "success: get_page_text shows Pinged 1.",
    "---",
    "",
    "# Sign in",
    "",
    "## Step 1 — Fill the username",
    "```yaml",
    "intent: Put the account name in the Username box.",
    "locator: { role: textbox, name: { equals: Username } }",
    'action: { tool: fill, value: "{{username}}" }',
    "checkpoint: { snapshot_has: { role: textbox, name: Username } }",
    "```",
    "",
  ].join("\n");
  const save = await c.call("playbook_save", { savePath: "~/.browser-bridge/playbooks/record-e2e-login.md", markdown: md });
  const mdAbs = join(home(), ".browser-bridge", "playbooks", "record-e2e-login.md");
  c.expect(save.json?.saved === mdAbs && save.json?.bytes === Buffer.byteLength(md), `playbook_save: ${trim(save.text, 160)}`);
  const onDisk = existsSync(mdAbs) ? readFileSync(mdAbs, "utf8") : "";
  c.expect(onDisk === md, "saved playbook differs from the markdown sent");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(onDisk)?.[1] ?? "";
  const keys = new Map(fm.split("\n").filter((l) => /^[a-z_]+:/.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  for (const k of ["id", "name", "goal", "site", "version", "last_verified", "destructive", "params"]) c.expect(keys.has(k), `front-matter missing ${k}`);
  c.expect(keys.get("id") === "record-e2e-login", "front-matter id != file slug");
  c.expect(/^## Step 1 — /m.test(onDisk), "no `## Step N — ` heading");
  c.expect(!/\bref\b|requestId|hunter2/.test(onDisk), "playbook contains a ref/requestId/secret");
});

// =================================================================================================
// EMULATION
// =================================================================================================

const PROBE = `(() => ({
  w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, touch: navigator.maxTouchPoints,
  lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  off: new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset(), num: new Intl.NumberFormat().format(1234.5),
  online: navigator.onLine
}))()`;
const FETCH_MS = `(async () => { const t = performance.now(); try { const r = await fetch('record-data.txt?t=' + Math.random(), { cache: 'no-store' }); const s = await r.text(); return { ok: true, ms: performance.now() - t, body: s.trim() }; } catch (e) { return { ok: false, ms: performance.now() - t, err: String(e) }; } })()`;
const CPU_MS = `(() => { const t = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x = (x + i * 7) % 1000003; return performance.now() - t; })()`;
const GEO = `new Promise((res) => navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }), (e) => res({ err: e.code + ' ' + e.message }), { timeout: 4000, maximumAge: 0 }))`;

scenario(
  "emulation-all-and-reset",
  async (c) => {
    const { tabId, url } = await openHuman(c, "record-emulate.html", "emu");
    await h.context!.grantPermissions(["geolocation"], { origin: new URL(url).origin });
    // Attach the debugger first: its infobar shrinks the viewport, so the baseline must include it.
    const att = await c.call("cdp_eval", { tabId, code: "1" });
    c.expect(!att.isError, `cdp_eval attach: ${trim(att.text, 160)}`);
    await sleep(500);
    const base = await c.evalJs(tabId, PROBE);
    const baseFetch = await c.evalJs(tabId, FETCH_MS);
    const baseCpu = Math.min(await c.evalJs(tabId, CPU_MS), await c.evalJs(tabId, CPU_MS));
    c.note(`baseline ${JSON.stringify(base)} fetch=${Math.round(baseFetch?.ms)}ms cpu=${Math.round(baseCpu)}ms`);
    c.expect(baseFetch?.ok === true, `baseline fetch failed: ${JSON.stringify(baseFetch)}`);

    // device: preset
    const d1 = await c.call("emulate_device", { tabId, preset: "iPhone 15" });
    c.expect(!d1.isError, `emulate_device preset: ${trim(d1.text, 200)}`);
    const p1 = await c.evalJs(tabId, PROBE);
    c.expect(p1?.w === 393 && p1?.dpr === 3, `iPhone 15: innerWidth=${p1?.w} dpr=${p1?.dpr}`);
    c.expect(/iPhone/.test(p1?.ua ?? ""), `iPhone UA not applied: ${p1?.ua}`);
    c.expect(p1?.touch > 0, `touch not emulated (maxTouchPoints=${p1?.touch})`);
    // device: explicit fields
    const d2 = await c.call("emulate_device", { tabId, width: 800, height: 600, deviceScaleFactor: 1.5, mobile: false, touch: false, userAgent: "BB-E2E-UA/1.0" });
    c.expect(!d2.isError, `emulate_device explicit: ${trim(d2.text, 200)}`);
    const p2 = await c.evalJs(tabId, PROBE);
    c.expect(p2?.w === 800 && p2?.h === 600 && p2?.dpr === 1.5 && p2?.ua === "BB-E2E-UA/1.0", `explicit device: ${JSON.stringify(p2)}`);
    const bad = await c.call("emulate_device", { tabId, preset: "Nokia 3310" });
    c.expect(bad.isError && /Unknown device preset/.test(bad.text), `unknown preset: ${trim(bad.text, 160)}`);

    // network: latency throttle
    const n1 = await c.call("emulate_network", { tabId, latencyMs: 1500, downloadKbps: 20000, uploadKbps: 20000 });
    c.expect(!n1.isError, `emulate_network throttle: ${trim(n1.text, 200)}`);
    const slow = await c.evalJs(tabId, FETCH_MS);
    c.note(`throttled fetch ${Math.round(slow?.ms)}ms`);
    c.expect(slow?.ok === true && slow.ms >= 1_300, `latency 1500ms not applied (fetch took ${Math.round(slow?.ms)}ms)`);
    // network: offline
    const n2 = await c.call("emulate_network", { tabId, preset: "offline" });
    c.expect(!n2.isError, `emulate_network offline: ${trim(n2.text, 200)}`);
    const off = await c.evalJs(tabId, FETCH_MS);
    const offProbe = await c.evalJs(tabId, PROBE);
    c.expect(off?.ok === false && /fetch/i.test(off?.err ?? ""), `offline fetch did not fail: ${JSON.stringify(off)}`);
    c.expect(offProbe?.online === false, `navigator.onLine=${offProbe?.online} while offline`);
    const badNet = await c.call("emulate_network", { tabId });
    c.expect(badNet.isError, "emulate_network with nothing should error");

    // cpu
    const cpu = await c.call("emulate_cpu", { tabId, rate: 6 });
    c.expect(!cpu.isError && cpu.json?.rate === 6, `emulate_cpu: ${trim(cpu.text, 160)}`);
    const slowCpu = await c.evalJs(tabId, CPU_MS);
    c.note(`cpu throttled ${Math.round(slowCpu)}ms vs ${Math.round(baseCpu)}ms`);
    c.expect(slowCpu >= baseCpu * 2.5, `CPU rate 6 only slowed the loop ${(slowCpu / baseCpu).toFixed(2)}x`);

    // locale + timezone
    const loc = await c.call("emulate_locale", { tabId, locale: "fr-FR", timezoneId: "Asia/Tokyo", acceptLanguage: "fr-FR,fr;q=0.9" });
    c.expect(!loc.isError, `emulate_locale: ${trim(loc.text, 200)}`);
    const pl = await c.evalJs(tabId, PROBE);
    c.expect(pl?.lang === "fr-FR", `navigator.language=${pl?.lang}`);
    c.expect(pl?.tz === "Asia/Tokyo" && pl?.off === -540, `timezone: tz=${pl?.tz} offset=${pl?.off}`);
    c.expect(/1\s234,5/.test(pl?.num ?? ""), `Intl number format not fr-FR: ${JSON.stringify(pl?.num)}`);

    // geolocation
    const geo = await c.call("emulate_geolocation", { tabId, latitude: 48.8566, longitude: 2.3522, accuracy: 25 });
    c.expect(!geo.isError, `emulate_geolocation: ${trim(geo.text, 200)}`);
    const g = await c.evalJs(tabId, GEO, { timeoutMs: 10_000 });
    c.expect(g?.lat === 48.8566 && g?.lon === 2.3522 && g?.acc === 25, `geolocation: ${JSON.stringify(g)}`);
    const gc = await c.call("emulate_geolocation", { tabId, clear: true });
    c.expect(!gc.isError && gc.json?.cleared === true, `geolocation clear: ${trim(gc.text, 160)}`);
    const g2 = await c.evalJs(tabId, GEO, { timeoutMs: 10_000 });
    c.expect(!(g2?.lat === 48.8566 && g2?.lon === 2.3522), `geolocation still overridden after clear: ${JSON.stringify(g2)}`);
    await c.call("emulate_geolocation", { tabId, latitude: -33.8688, longitude: 151.2093 }); // re-set so reset has something to undo

    // reset -> everything back
    const rs = await c.call("emulate_reset", { tabId });
    c.note(`reset -> ${trim(rs.text, 200)}`);
    c.expect(!rs.isError && rs.json?.reset === true, `emulate_reset: ${trim(rs.text, 160)}`);
    const wa = JSON.stringify(rs.json?.wasApplied ?? "");
    for (const k of ["device", "network", "cpu", "locale", "geolocation"]) c.expect(wa.includes(k), `wasApplied lacks ${k}: ${wa}`);
    const pr = await c.evalJs(tabId, PROBE);
    c.expect(pr?.w === base?.w && pr?.h === base?.h && pr?.dpr === base?.dpr, `viewport not restored: ${JSON.stringify(pr)} vs ${JSON.stringify(base)}`);
    c.expect(pr?.ua === base?.ua && pr?.touch === base?.touch, `UA/touch not restored: ${pr?.ua} touch=${pr?.touch}`);
    c.expect(pr?.lang === base?.lang && pr?.tz === base?.tz && pr?.off === base?.off && pr?.num === base?.num, `locale/tz not restored: ${JSON.stringify(pr)}`);
    c.expect(pr?.online === true, "still offline after reset");
    const rf = await c.evalJs(tabId, FETCH_MS);
    c.expect(rf?.ok === true && rf.ms < 1_000, `network not restored: ${JSON.stringify(rf)}`);
    const rc = await c.evalJs(tabId, CPU_MS);
    c.expect(rc < baseCpu * 2, `CPU still throttled after reset: ${Math.round(rc)}ms vs ${Math.round(baseCpu)}ms`);
    const rg = await c.evalJs(tabId, GEO, { timeoutMs: 10_000 });
    c.expect(!(rg?.lat === -33.8688 && rg?.lon === 151.2093), `geolocation override survived reset: ${JSON.stringify(rg)}`);
    await c.call("debugger_detach", { tabId }).catch(() => undefined);
  },
  { timeout: 120_000 }
);

// =================================================================================================
// WATCH: blind while the extension socket is down (last: it disconnects the extension)
// =================================================================================================

scenario(
  "watch-blind-when-extension-disconnected",
  async (c) => {
    await stopAllWatches(c);
    const { tabId, page } = await openHuman(c, "record-form.html", "blind");
    const ws = await c.call("watch_start", { tabId, retain: "none" });
    c.expect(!ws.isError, `watch_start: ${trim(ws.text, 160)}`);
    const sw = h.context!.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
    if (!sw) throw new Error("extension service worker handle not available");
    const setToken = (token: string) =>
      sw.evaluate(({ token, port }) => (globalThis as any).chrome.storage.local.set({ token, port }), { token, port: h.bridgePort });
    let restored = false;
    try {
      await page.click("#ping");
      const first = await readUntil(c, ws.json.cursor, (ls) => has(ls, /click\s+<button#ping>/), 8_000);
      c.expect(has(first.lines, /click\s+<button#ping>/), "baseline click not captured");
      // knock the socket down: a wrong token makes the extension drop and fail re-auth
      await setToken("wrong-token-" + Date.now());
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await h.health()).extensionConnected) await sleep(200);
      c.expect((await h.health()).extensionConnected === false, "extension did not disconnect");
      const st = await c.call("watch_status", {});
      const w = (st.json?.watches ?? [])[0];
      c.expect(w?.health?.state === "blind", `watch_status state=${w?.health?.state} while the extension is disconnected (want blind)`);
      c.expect((w?.health?.warnings ?? []).some((x: string) => /disconnected/.test(x)), "no disconnected warning");
      const rd = await c.call("watch_read", { since: first.cursor, waitMs: 8_000 });
      const rp = parseRead(rd.text);
      c.expect(rp.meta.health?.state === "blind" && /WATCH\s+blind/.test(rp.header), `watch_read health while disconnected: ${trim(rd.text, 200)}`);
      c.expect(rd.ms < 4_000, `watch_read waitMs blocked ${rd.ms}ms although capture is blind`);
      await sleep(1_000);
      await setToken(h.token);
      restored = true;
      const d2 = Date.now() + 15_000;
      while (Date.now() < d2 && !(await h.health()).extensionConnected) await sleep(200);
      c.expect((await h.health()).extensionConnected === true, "extension did not reconnect");
      await sleep(500);
      await page.click("#ping");
      const back = await readUntil(c, first.cursor, (ls) => has(ls, /click\s+<button#ping>/), 10_000);
      c.note(`after reconnect: ${trim(back.lines.join(" | "), 300)}`);
      c.expect(has(back.lines, /gap\s+extension-disconnected \(\d+\.\d+s\)/), "no `gap extension-disconnected` line after the outage");
      c.expect(has(back.lines, /click\s+<button#ping>/), "click after reconnect not captured");
      c.expect(back.meta.health?.state === "live", `state after reconnect: ${back.meta.health?.state}`);
    } finally {
      if (!restored) await setToken(h.token).catch(() => undefined);
      const d3 = Date.now() + 15_000;
      while (Date.now() < d3 && !(await h.health()).extensionConnected) await sleep(200);
      await c.call("watch_stop", {}).catch(() => undefined);
    }
  },
  { timeout: 120_000 }
);
