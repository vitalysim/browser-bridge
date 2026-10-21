// browser-bridge e2e: the web-security / DevTools tool family (network capture, WS frames, HAR, curl,
// replay, identities, authz_matrix, response_diff, intercept, fuzz, cookies, storage, console, JWT,
// analyze). Own harness; dynamic server routes live in harness.ts's "devtools test routes" block.
// Every scenario asserts the CORRECT behaviour; a failure here is a product bug, not a flaky test.
import { before, after } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, trim, type CallResult } from "./harness.js";
import { scenario as defineScenario, printSummary, type Ctx } from "./scenario.js";

let h: Harness;
const scenario = (name: string, fn: (c: Ctx) => Promise<void>, opts?: { timeout?: number }) => defineScenario(() => h, name, fn, opts);

before(async () => {
  h = new Harness({ logName: "server-devtools.log" });
  try {
    await h.setup();
  } catch (e) {
    await h.teardown();
    throw e;
  }
  console.log(`[e2e:devtools] bridge :${h.bridgePort}  fixtures :${h.fixturePort}  tools=${h.toolSchemas.size}`);
}, { timeout: 90_000 });

after(async () => {
  printSummary();
  await h?.teardown();
}, { timeout: 60_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const origin = () => `http://127.0.0.1:${h.fixturePort}`;
const APP = "devtools-app.html";

/** Poll fn until it returns a truthy value (bounded). Returns the last value either way. */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 8_000, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (!ok(v) && Date.now() < deadline) {
    await sleep(everyMs);
    v = await fn();
  }
  return v;
}

/** Case-insensitive header lookup over a {name: value} map. */
function hdr(obj: any, name: string): string | undefined {
  if (!obj) return undefined;
  const k = Object.keys(obj).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : String(obj[k]);
}

function mustOk(c: Ctx, r: CallResult, what: string): any {
  c.expect(!r.isError && r.json !== undefined, `${what} failed: ${trim(r.text, 300)}`);
  return r.json ?? {};
}

/** Page fetch through the fixture's api() helper; returns {status, body} (body parsed when JSON). */
async function api(c: Ctx, tabId: number, path: string, init: any = {}): Promise<{ status: number; body: any; raw: string }> {
  const v = await c.evalJs(tabId, `api(${JSON.stringify(path)}, ${JSON.stringify(init)})`);
  let body: any = v?.body;
  try {
    body = JSON.parse(v?.body);
  } catch {
    /* not JSON */
  }
  return { status: v?.status, body, raw: v?.body ?? "" };
}

async function requests(c: Ctx, tabId: number, args: any = {}): Promise<any[]> {
  const r = await c.call("net_get_requests", { tabId, ...args });
  return Array.isArray(r.json?.requests) ? r.json.requests : [];
}

/** Wait until the capture buffer holds a finished (status-bearing) row for each url fragment. */
async function waitRows(c: Ctx, tabId: number, frags: string[], args: any = {}): Promise<any[]> {
  return until(
    () => requests(c, tabId, args),
    (rows) => frags.every((f) => rows.some((r) => String(r.url).includes(f) && typeof r.status === "number")),
    8_000,
    250
  );
}

// 1. net_capture_start (urlFilter, excludeExtensionTraffic, maxEntries) + net_get_requests + net_get_body
scenario("net-capture-and-requests", async (c) => {
  const tabId = await c.open(APP);
  const start = mustOk(c, await c.call("net_capture_start", { tabId, urlFilter: "/api/", excludeExtensionTraffic: true }), "net_capture_start");
  c.expect(start.capturing === true && start.tabId === tabId, `capture did not start on the tab: ${JSON.stringify(start)}`);

  await api(c, tabId, "/api/login?user=alice");
  await api(c, tabId, "/api/me", { headers: { Authorization: "Bearer alice-token", "X-CSRF-Token": "csrf-alice" } });
  await api(c, tabId, "/api/echo?n=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"hello":"world"}' });
  await api(c, tabId, "/devtools-app.html?not-matching-filter=1");

  const rows = await waitRows(c, tabId, ["/api/login", "/api/me", "/api/echo"]);
  c.note(`captured ${rows.length}: ${rows.map((r) => `${r.method} ${String(r.url).replace(origin(), "")} ${r.status}`).join(", ")}`);
  c.expect(rows.length === 3, `want exactly the 3 /api/ requests, got ${rows.length}`);
  c.expect(rows.every((r) => String(r.url).includes("/api/")), "urlFilter let a non-/api/ request into the buffer");

  const login = rows.find((r) => String(r.url).includes("/api/login"));
  const setCookie = [...(login?.setCookie ?? []), hdr(login?.responseHeaders, "set-cookie") ?? ""].join("\n");
  c.expect(/sid=sess-alice/.test(setCookie) && /HttpOnly/i.test(setCookie), `Set-Cookie (incl HttpOnly sid) missing on login row: ${trim(JSON.stringify(login), 400)}`);
  c.expect(/prefs=theme-alice/.test(setCookie), "second Set-Cookie (prefs) missing on login row");

  const me = rows.find((r) => String(r.url).includes("/api/me"));
  c.expect(hdr(me?.requestHeaders, "authorization") === "Bearer alice-token", `Authorization request header missing: ${JSON.stringify(me?.requestHeaders)}`);
  c.expect(hdr(me?.requestHeaders, "x-csrf-token") === "csrf-alice", "X-CSRF-Token request header missing");
  c.expect(/sid=sess-alice/.test(hdr(me?.requestHeaders, "cookie") ?? ""), `sent Cookie header (ExtraInfo) missing: ${JSON.stringify(me?.requestHeaders)}`);
  c.expect(me?.status === 200, `me status ${me?.status}`);

  const echo = rows.find((r) => String(r.url).includes("/api/echo"));
  c.expect(echo?.method === "POST" && echo?.requestBody === '{"hello":"world"}', `POST body not captured: ${trim(JSON.stringify(echo), 300)}`);

  // includeBodies + urlFilter
  const withBodies = await requests(c, tabId, { includeBodies: true, urlFilter: "/api/me" });
  c.expect(withBodies.length === 1, `urlFilter=/api/me returned ${withBodies.length} rows`);
  c.expect(/"user":"alice"/.test(withBodies[0]?.responseBody ?? ""), `includeBodies: no body: ${trim(JSON.stringify(withBodies[0]), 300)}`);
  const noBodies = await requests(c, tabId, { urlFilter: "/api/me" });
  c.expect(noBodies[0] && noBodies[0].responseBody === undefined, "body returned without includeBodies");

  // limit keeps the newest
  const limited = await requests(c, tabId, { limit: 1 });
  c.expect(limited.length === 1 && String(limited[0].url).includes("/api/echo"), `limit:1 should keep the newest (echo), got ${limited.map((r) => r.url).join(",")}`);

  // net_get_body
  const body = mustOk(c, await c.call("net_get_body", { tabId, requestId: login.requestId }), "net_get_body");
  c.expect(/"token":"alice-token"/.test(body.body ?? ""), `net_get_body: ${trim(JSON.stringify(body), 200)}`);
  const bad = await c.call("net_get_body", { tabId, requestId: "no-such-request" });
  c.expect(bad.isError, `net_get_body on an unknown requestId should error: ${trim(bad.text, 160)}`);

  // maxEntries: ring keeps only the newest N
  const r2 = mustOk(c, await c.call("net_capture_start", { tabId, urlFilter: "/api/echo", maxEntries: 3 }), "net_capture_start maxEntries");
  c.expect(r2.maxEntries === 3, `maxEntries not echoed: ${JSON.stringify(r2)}`);
  for (let i = 1; i <= 6; i++) await api(c, tabId, `/api/echo?ring=${i}`);
  const ring = await until(() => requests(c, tabId), (rows) => rows.some((r) => String(r.url).endsWith("ring=6") && r.status), 8_000);
  const ringRes = await c.call("net_get_requests", { tabId });
  c.note(`ring: ${ring.map((r) => String(r.url).split("?")[1]).join(",")} totalBuffered=${ringRes.json?.totalBuffered}`);
  c.expect(ring.length === 3 && ringRes.json?.totalBuffered === 3, `maxEntries:3 kept ${ring.length} (totalBuffered ${ringRes.json?.totalBuffered})`);
  c.expect(ring.map((r) => String(r.url).split("ring=")[1]).join(",") === "4,5,6", `ring should hold the newest 3 (4,5,6): ${ring.map((r) => r.url).join(",")}`);

  // excludeExtensionTraffic: a non-http(s) request (data: URL) is dropped only when set
  mustOk(c, await c.call("net_capture_start", { tabId, excludeExtensionTraffic: false }), "capture (control)");
  await c.evalJs(tabId, "fetch('data:text/plain,bb-data-control').then(r => r.text())");
  await api(c, tabId, "/api/echo?marker=control");
  const control = await waitRows(c, tabId, ["marker=control"]);
  const controlHasData = control.some((r) => String(r.url).startsWith("data:"));
  mustOk(c, await c.call("net_capture_start", { tabId, excludeExtensionTraffic: true }), "capture (exclude)");
  await c.evalJs(tabId, "fetch('data:text/plain,bb-data-excluded').then(r => r.text())");
  await api(c, tabId, "/api/echo?marker=excluded");
  const excl = await waitRows(c, tabId, ["marker=excluded"]);
  c.note(`data: rows captured without exclude=${controlHasData}`);
  c.expect(!excl.some((r) => !/^https?:/i.test(String(r.url))), `excludeExtensionTraffic:true still buffered non-http rows: ${excl.map((r) => trim(r.url, 60)).join(",")}`);
  if (!controlHasData) c.note("control: CDP emitted no data: row even without the exclude flag; exclusion asserted one-sided");
});

// 2. persist + savePath + persistBodies: JSONL on disk (temp dir)
scenario("net-capture-persist-jsonl", async (c) => {
  const tabId = await c.open(APP);
  const savePath = join(h.tmpRoot, "devtools-capture.jsonl");
  const noPath = await c.call("net_capture_start", { tabId, persist: true });
  c.expect(noPath.isError && /savePath/.test(noPath.text), `persist without savePath should error: ${trim(noPath.text, 160)}`);

  const r = mustOk(c, await c.call("net_capture_start", { tabId, persist: true, savePath, persistBodies: true, urlFilter: "/api/" }), "persist start");
  c.expect(r.persist === true && r.savePath === savePath, `persist not acknowledged: ${JSON.stringify(r)}`);
  await api(c, tabId, "/api/me", { headers: { Authorization: "Bearer bob-token" } });
  await api(c, tabId, "/api/items/1", { headers: { Authorization: "Bearer alice-token" } });
  await c.evalJs(tabId, "wsRoundtrip(['persist-frame'])");

  const readLines = async () => (existsSync(savePath) ? readFileSync(savePath, "utf8").split("\n").filter(Boolean) : []);
  const lines = await until(readLines, (ls) => ls.some((l) => l.includes("/api/items/1") && l.includes("responseBody")) && ls.some((l) => l.includes("echo:persist-frame")), 8_000, 250);
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { unparseable: l };
    }
  });
  c.note(`jsonl: ${lines.length} lines, kinds=${parsed.map((p) => p.kind).join(",")}`);
  c.expect(parsed.every((p) => !p.unparseable), "a JSONL line is not valid JSON");
  const me = parsed.find((p) => p.kind === "net" && String(p.url).includes("/api/me"));
  c.expect(me && me.status === 200 && hdr(me.requestHeaders, "authorization") === "Bearer bob-token", `persisted /api/me row wrong: ${trim(JSON.stringify(me), 300)}`);
  const item = parsed.find((p) => p.kind === "net" && String(p.url).includes("/api/items/1"));
  c.expect(/alice-private-note/.test(item?.responseBody ?? ""), `persistBodies: body missing on disk: ${trim(JSON.stringify(item), 300)}`);
  c.expect(parsed.some((p) => p.kind === "ws" && p.dir === "sent" && p.payload === "persist-frame"), "persisted WS sent frame missing");
  c.expect(parsed.some((p) => p.kind === "ws" && p.dir === "received" && p.payload === "echo:persist-frame"), "persisted WS received frame missing");
  c.expect(!parsed.some((p) => p.kind === "net" && !String(p.url).includes("/api/")), "urlFilter not applied to the persisted stream");
});

// 3. net_get_ws_frames over the echo WebSocket
scenario("ws-frames", async (c) => {
  const tabId = await c.open(APP);
  const none = await c.call("net_get_ws_frames", { tabId });
  c.expect(none.isError && /net_capture_start/.test(none.text), `ws frames before capture should say to start capture: ${trim(none.text, 160)}`);
  mustOk(c, await c.call("net_capture_start", { tabId }), "capture");
  const echoes = await c.evalJs(tabId, "wsRoundtrip(['hello-1', 'hello-2'])");
  c.expect(JSON.stringify(echoes) === '["echo:hello-1","echo:hello-2"]', `page-side echo broken: ${JSON.stringify(echoes)}`);
  const get = async (args: any = {}) => (await c.call("net_get_ws_frames", { tabId, ...args })).json ?? {};
  const all = await until(() => get(), (j) => (j.frames ?? []).filter((f: any) => f.dir === "received").length >= 2 && (j.frames ?? []).some((f: any) => f.dir === "close"), 8_000);
  const frames: any[] = all.frames ?? [];
  c.note(`frames: ${frames.map((f) => `${f.dir}:${f.payload ?? ""}`).join(" | ")}`);
  const sent = frames.filter((f) => f.dir === "sent").map((f) => f.payload);
  const recv = frames.filter((f) => f.dir === "received").map((f) => f.payload);
  c.expect(sent.join(",") === "hello-1,hello-2", `sent frames: ${JSON.stringify(sent)}`);
  c.expect(recv.join(",") === "echo:hello-1,echo:hello-2", `received frames: ${JSON.stringify(recv)}`);
  c.expect(frames.some((f) => f.dir === "create" && /\/ws\/echo$/.test(f.url ?? "")), "no create event with the socket url");
  c.expect(frames.filter((f) => f.dir === "sent" || f.dir === "received").every((f) => f.opcode === 1 && /\/ws\/echo$/.test(f.url ?? "")), "text frames should carry opcode 1 and the socket url");
  c.expect(((await get({ urlFilter: "/ws/echo" })).frames ?? []).length === frames.length, "urlFilter matching the socket dropped frames");
  c.expect(((await get({ urlFilter: "no-such-socket" })).frames ?? []).length === 0, "non-matching urlFilter returned frames");
  const one = await get({ limit: 1 });
  c.expect(one.count === 1 && one.frames?.[0]?.dir === frames[frames.length - 1].dir, `limit:1 should return the newest frame: ${JSON.stringify(one)}`);
});

// 4. export_har -> valid HAR 1.2
scenario("export-har", async (c) => {
  const tabId = await c.open(APP);
  mustOk(c, await c.call("net_capture_start", { tabId, urlFilter: "/api/" }), "capture");
  await api(c, tabId, "/api/me", { headers: { Authorization: "Bearer alice-token" } });
  await api(c, tabId, "/api/echo?har=1", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "har-body" });
  await waitRows(c, tabId, ["/api/me", "/api/echo"]);
  const savePath = join(h.tmpRoot, "devtools.har");
  const r = mustOk(c, await c.call("export_har", { tabId, savePath }), "export_har");
  c.expect(r.saved === savePath && r.entries === 2, `export_har result: ${JSON.stringify(r)}`);
  let har: any;
  try {
    har = JSON.parse(readFileSync(savePath, "utf8"));
  } catch (e) {
    c.expect(false, `HAR not valid JSON: ${String(e)}`);
    return;
  }
  c.expect(har?.log?.version === "1.2" && typeof har.log.creator?.name === "string", `HAR log header: ${trim(JSON.stringify(har?.log ?? {}), 200)}`);
  const entries: any[] = har.log.entries ?? [];
  c.expect(entries.length === 2, `HAR entries ${entries.length}`);
  for (const e of entries) {
    c.expect(
      typeof e.startedDateTime === "string" && !isNaN(Date.parse(e.startedDateTime)) && Array.isArray(e.request?.headers) && Array.isArray(e.response?.headers) && typeof e.response?.content === "object" && typeof e.timings === "object",
      `HAR entry missing required fields: ${trim(JSON.stringify(e), 200)}`
    );
  }
  const me = entries.find((e) => String(e.request?.url).includes("/api/me"));
  c.expect(me?.response?.status === 200 && /"user":"alice"/.test(me?.response?.content?.text ?? ""), `HAR /api/me response: ${trim(JSON.stringify(me?.response), 200)}`);
  c.expect(me?.request?.headers?.some((x: any) => x.name.toLowerCase() === "authorization" && x.value === "Bearer alice-token"), "HAR request headers lack Authorization");
  const post = entries.find((e) => e.request?.method === "POST");
  c.expect(post?.request?.postData?.text === "har-body", `HAR postData: ${JSON.stringify(post?.request?.postData)}`);
  c.expect(post?.request?.queryString?.some((q: any) => q.name === "har" && q.value === "1"), "HAR queryString missing");
  // includeBodies:false drops the bodies
  const lean = join(h.tmpRoot, "devtools-lean.har");
  mustOk(c, await c.call("export_har", { tabId, savePath: lean, includeBodies: false }), "export_har lean");
  const leanHar = JSON.parse(readFileSync(lean, "utf8"));
  c.expect(leanHar.log.entries.every((e: any) => e.response.content.text === undefined), "includeBodies:false still inlined bodies");
});

// 5. request_to_curl: the emitted command really reproduces the request
scenario("request-to-curl", async (c) => {
  const tabId = await c.open(APP);
  mustOk(c, await c.call("net_capture_start", { tabId, urlFilter: "/api/echo" }), "capture");
  await api(c, tabId, "/api/echo?curl=1", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer alice-token", "X-CSRF-Token": "csrf-curl" }, body: `{"it's":"quoted"}` });
  const [row] = await waitRows(c, tabId, ["curl=1"]);
  const r = mustOk(c, await c.call("request_to_curl", { tabId, requestId: row?.requestId }), "request_to_curl");
  const curl: string = r.curl ?? "";
  c.note(`curl: ${trim(curl, 200)}`);
  c.expect(r.method === "PUT" && /-X PUT/.test(curl) && /--data-raw/.test(curl), `curl lacks method/body: ${trim(curl, 300)}`);
  // Async on purpose: the fixture server lives in this process, so a sync spawn would deadlock it.
  const run = async (cmd: string) => JSON.parse((await promisify(execFile)("/bin/sh", ["-c", `${cmd} --silent --max-time 5`], { encoding: "utf8" })).stdout);
  try {
    const echoed = await run(curl);
    c.expect(echoed.method === "PUT", `curl replay method ${echoed.method}`);
    c.expect(echoed.body === `{"it's":"quoted"}`, `curl replay body ${JSON.stringify(echoed.body)}`);
    c.expect(echoed.headers.authorization === "Bearer alice-token" && echoed.headers["x-csrf-token"] === "csrf-curl", `curl replay headers: ${JSON.stringify(echoed.headers)}`);
    c.expect(echoed.url === "/api/echo?curl=1", `curl replay url ${echoed.url}`);
  } catch (e) {
    c.expect(false, `captured curl did not run: ${String(e)}`);
  }
  // ad-hoc
  const adhoc = mustOk(c, await c.call("request_to_curl", { url: `${origin()}/api/echo?adhoc=1`, method: "delete", headers: { "X-Thing": "a b'c" }, body: "x=1" }), "ad-hoc curl");
  try {
    const echoed = await run(adhoc.curl);
    c.expect(echoed.method === "DELETE" && echoed.headers["x-thing"] === "a b'c" && echoed.body === "x=1", `ad-hoc curl replay: ${JSON.stringify(echoed)}`);
  } catch (e) {
    c.expect(false, `ad-hoc curl did not run: ${String(e)} (${adhoc.curl})`);
  }
  const none = await c.call("request_to_curl", {});
  c.expect(none.isError, "request_to_curl with neither requestId nor url should error");
});

// 6. replay_request: default session, anon, overrides, captured-header forwarding, named identity
scenario("replay-request", async (c) => {
  const tabId = await c.open(APP);
  await api(c, tabId, "/api/login?user=alice"); // jar: sid=sess-alice (HttpOnly), prefs=theme-alice
  mustOk(c, await c.call("net_capture_start", { tabId, urlFilter: "/api/echo" }), "capture");
  await api(c, tabId, "/api/echo?replay=1", { headers: { Authorization: "Bearer alice-token", "X-CSRF-Token": "csrf-alice", "X-Custom": "one" } });
  const [row] = await waitRows(c, tabId, ["replay=1"]);
  c.expect(/sid=sess-alice/.test(hdr(row?.requestHeaders, "cookie") ?? ""), "capture should hold the sent cookie (sid=sess-alice)");
  // Swap the live jar's session: a replay must use the live jar, never the captured Cookie header.
  mustOk(c, await c.call("cookies_set", { url: `${origin()}/`, name: "sid", value: "sess-bob", httpOnly: true, path: "/" }), "cookies_set sid");

  const replay = async (args: any) => {
    const r = await c.call("replay_request", { tabId, ...args });
    const j = mustOk(c, r, `replay_request ${JSON.stringify(args)}`);
    let echo: any = {};
    try {
      echo = JSON.parse(j.body ?? "{}");
    } catch {
      c.expect(false, `replay body not JSON: ${trim(j.body, 200)}`);
    }
    return { j, echo };
  };

  // default identity: captured Authorization/CSRF/custom forwarded, live cookies via credentials
  const def = await replay({ requestId: row?.requestId });
  c.expect(def.j.status === 200, `default replay status ${def.j.status}`);
  c.expect(def.echo.headers?.authorization === "Bearer alice-token", `captured Authorization not forwarded: ${JSON.stringify(def.echo.headers)}`);
  c.expect(def.echo.headers?.["x-csrf-token"] === "csrf-alice" && def.echo.headers?.["x-custom"] === "one", "captured CSRF/custom header not forwarded");
  c.expect(def.echo.cookies?.sid === "sess-bob", `default replay should carry the LIVE jar cookie (sess-bob), got ${JSON.stringify(def.echo.cookies)}`);
  c.expect(def.echo.url === "/api/echo?replay=1" && def.echo.method === "GET", "default replay changed url/method");

  // anon: no cookies, no Authorization
  const anon = await replay({ requestId: row?.requestId, identity: "anon" });
  c.expect(!anon.echo.headers?.cookie, `anon replay sent cookies: ${anon.echo.headers?.cookie}`);
  c.expect(!anon.echo.headers?.authorization, `anon replay sent Authorization: ${anon.echo.headers?.authorization}`);

  // overrides: url/method/body/headers; "" removes a header; forbidden headers dropped (not sent, no error)
  const ov = await replay({
    requestId: row?.requestId,
    overrides: {
      url: `${origin()}/api/echo?over=1`,
      method: "POST",
      body: "override-body",
      headers: { "X-Custom": "two", "X-CSRF-Token": "", Host: "evil.example", Cookie: "sid=forged", Origin: "http://evil.example", "Content-Length": "999" },
    },
  });
  c.note(`override echo headers: ${trim(JSON.stringify(ov.echo.headers), 300)}`);
  c.expect(ov.echo.method === "POST" && ov.echo.url === "/api/echo?over=1" && ov.echo.body === "override-body", `overrides not applied: ${trim(JSON.stringify(ov.echo), 200)}`);
  c.expect(ov.echo.headers?.["x-custom"] === "two", "override header not applied");
  c.expect(ov.echo.headers?.["x-csrf-token"] === undefined, "empty-string override did not remove the header");
  c.expect(ov.echo.headers?.authorization === "Bearer alice-token", "url override should still forward the captured Authorization (documented)");
  c.expect(ov.echo.headers?.host === `127.0.0.1:${h.fixturePort}`, `forbidden Host override leaked: ${ov.echo.headers?.host}`);
  c.expect(ov.echo.cookies?.sid === "sess-bob", `forbidden Cookie override leaked / live cookie lost: ${JSON.stringify(ov.echo.cookies)}`);
  c.expect(ov.echo.headers?.origin !== "http://evil.example", "forbidden Origin override leaked");

  // ad-hoc request (no requestId)
  const adhoc = await replay({ url: `${origin()}/api/echo?adhoc=1`, method: "PATCH", headers: { "X-Adhoc": "yes" }, body: "adhoc-body" });
  c.expect(adhoc.echo.method === "PATCH" && adhoc.echo.headers?.["x-adhoc"] === "yes" && adhoc.echo.body === "adhoc-body", `ad-hoc replay: ${trim(JSON.stringify(adhoc.echo), 200)}`);

  // named identity with a bearer: its bearer replaces the captured Authorization, cookies omitted
  await api(c, tabId, "/api/echo?bobauth=1", { headers: { Authorization: "Bearer bob-token" } });
  await waitRows(c, tabId, ["bobauth=1"]);
  mustOk(c, await c.call("identity_capture", { tabId, name: "dt-replay-bob" }), "identity_capture");
  const asBob = await replay({ requestId: row?.requestId, identity: "dt-replay-bob" });
  c.expect(asBob.echo.headers?.authorization === "Bearer bob-token", `identity bearer not used: ${asBob.echo.headers?.authorization}`);
  c.expect(!asBob.echo.headers?.cookie, "bearer identity replay should omit the session cookies");
  const missing = await c.call("replay_request", { tabId, requestId: row?.requestId, identity: "no-such-identity" });
  c.expect(missing.isError && /identity_capture/.test(missing.text), `unknown identity should error: ${trim(missing.text, 160)}`);
  await c.call("identity_purge", { name: "dt-replay-bob" });
  await c.call("cookies_delete", { url: `${origin()}/`, name: "sid" });
});

// 7. identity_capture / identity_list / identity_purge
scenario("identities", async (c) => {
  const tabId = await c.open(APP);
  mustOk(c, await c.call("net_capture_start", { tabId, urlFilter: "/api/" }), "capture");
  await api(c, tabId, "/api/login?user=alice");
  await c.evalJs(tabId, "localStorage.setItem('acct', 'alice'); sessionStorage.setItem('tabState', 'open'); true");
  await api(c, tabId, "/api/me", { headers: { Authorization: "Bearer alice-token" } });
  await waitRows(c, tabId, ["/api/me"]);
  const cap = mustOk(c, await c.call("identity_capture", { tabId, name: "dt-alice", domain: "127.0.0.1" }), "identity_capture");
  c.note(`identity_capture -> ${JSON.stringify(cap)}`);
  c.expect(cap.cookies >= 2, `want >=2 cookies (sid, prefs), got ${cap.cookies}`);
  c.expect(cap.httpOnly >= 1, `HttpOnly sid not captured (httpOnly=${cap.httpOnly})`);
  c.expect(cap.hasStorage === true, "local/session storage not captured");
  c.expect(cap.hasBearer === true, "bearer from the capture buffer not captured");
  const other = mustOk(c, await c.call("identity_capture", { tabId, name: "dt-nodomain", domain: "example.invalid" }), "identity_capture other domain");
  c.expect(other.cookies === 0, `domain filter kept ${other.cookies} foreign cookies`);

  const list = mustOk(c, await c.call("identity_list", {}), "identity_list");
  const a = (list.identities ?? []).find((i: any) => i.name === "dt-alice");
  c.expect(a && a.cookies >= 2 && a.hasBearer === true, `identity_list entry: ${JSON.stringify(a)}`);
  const p = mustOk(c, await c.call("identity_purge", { name: "dt-alice" }), "identity_purge");
  c.expect(p.purged === true, `purge: ${JSON.stringify(p)}`);
  const p2 = mustOk(c, await c.call("identity_purge", { name: "dt-alice" }), "identity_purge again");
  c.expect(p2.purged === false, "purging twice should report purged:false");
  await c.call("identity_purge", { name: "dt-nodomain" });
  const afterRes = mustOk(c, await c.call("identity_list", {}), "identity_list after");
  c.expect(!(afterRes.identities ?? []).some((i: any) => i.name === "dt-alice" || i.name === "dt-nodomain"), "purged identity still listed");
  await c.call("cookies_delete", { url: `${origin()}/`, name: "sid" });
  await c.call("cookies_delete", { url: `${origin()}/`, name: "prefs" });
});

// 8. authz_matrix detects the BOLA (alice reads bob's item) and not the protected twin
scenario("authz-matrix-bola", async (c) => {
  const tabId = await c.open(APP);
  mustOk(c, await c.call("net_capture_start", { tabId, urlFilter: "/api/" }), "capture");
  await api(c, tabId, "/api/items/2", { headers: { Authorization: "Bearer bob-token" } });
  await api(c, tabId, "/api/secure-items/2", { headers: { Authorization: "Bearer bob-token" } });
  const rows = await waitRows(c, tabId, ["/api/items/2", "/api/secure-items/2"]);
  mustOk(c, await c.call("identity_capture", { tabId, name: "dt-bob" }), "capture bob");
  await api(c, tabId, "/api/me", { headers: { Authorization: "Bearer alice-token" } });
  await waitRows(c, tabId, ["/api/me"]);
  mustOk(c, await c.call("identity_capture", { tabId, name: "dt-alice" }), "capture alice");
  const ids = mustOk(c, await c.call("identity_list", {}), "identity_list");
  c.expect(["dt-bob", "dt-alice"].every((n) => ids.identities?.some((i: any) => i.name === n && i.hasBearer)), `identities: ${JSON.stringify(ids)}`);

  const item = rows.find((r) => String(r.url).endsWith("/api/items/2"));
  const secure = rows.find((r) => String(r.url).endsWith("/api/secure-items/2"));
  const m = mustOk(
    c,
    await c.call("authz_matrix", { tabId, requestIds: [item?.requestId, secure?.requestId], identities: ["dt-bob", "dt-alice", "anon"], mutateIds: true }, { timeoutMs: 60_000 }),
    "authz_matrix"
  );
  const mrows: any[] = m.rows ?? [];
  c.note(mrows.map((r) => `${String(r.url).replace(origin(), "")}${r.label ? `(${r.label})` : ""}: ${r.cells.map((x: any) => `${x.identity}=${x.status ?? x.error}${x.flag ? "!" : ""}`).join(" ")}`).join(" ; "));
  const cell = (row: any, ident: string) => row?.cells?.find((x: any) => x.identity === ident);
  const bola = mrows.find((r) => String(r.url).endsWith("/api/items/2") && !r.label);
  c.expect(cell(bola, "dt-bob")?.status === 200 && /bob-private-note/.test(cell(bola, "dt-bob")?.body ?? ""), "baseline (owner bob) should read item 2");
  c.expect(cell(bola, "dt-alice")?.status === 200 && /bob-private-note/.test(cell(bola, "dt-alice")?.body ?? ""), `alice should (vulnerably) read bob's item: ${JSON.stringify(cell(bola, "dt-alice"))}`);
  c.expect(/ACCESS-CONTROL/.test(cell(bola, "dt-alice")?.flag ?? ""), `BOLA not flagged for alice: ${JSON.stringify(cell(bola, "dt-alice"))}`);
  c.expect(cell(bola, "dt-alice")?.diff?.similarity === 1, `alice/bob bodies should be identical: ${JSON.stringify(cell(bola, "dt-alice")?.diff)}`);
  c.expect(cell(bola, "anon")?.status === 401 && !cell(bola, "anon")?.flag, `anon should be 401 and unflagged: ${JSON.stringify(cell(bola, "anon"))}`);
  const safe = mrows.find((r) => String(r.url).endsWith("/api/secure-items/2") && !r.label);
  c.expect(cell(safe, "dt-alice")?.status === 403 && !cell(safe, "dt-alice")?.flag, `protected endpoint must not be flagged: ${JSON.stringify(cell(safe, "dt-alice"))}`);
  const nb = mrows.find((r) => r.label === "id+1 neighbor" && String(r.url).endsWith("/api/items/3"));
  c.expect(nb && cell(nb, "dt-bob")?.status === 200 && /alice-second-note/.test(cell(nb, "dt-bob")?.body ?? ""), `mutateIds neighbor row (items/3) missing or wrong: ${trim(JSON.stringify(nb), 300)}`);
  await c.call("identity_purge", { name: "dt-bob" });
  await c.call("identity_purge", { name: "dt-alice" });
});

// 9. response_diff
scenario("response-diff", async (c) => {
  const same = mustOk(c, await c.call("response_diff", { a: { status: 200, body: '{"id":2,"note":"x"}' }, b: { status: 200, body: '{"id":2,"note":"x"}' } }), "diff same");
  c.expect(same.sameStatus === true && same.similarity === 1 && same.lenDelta === 0, `identical: ${JSON.stringify(same)}`);
  const diff = mustOk(c, await c.call("response_diff", { a: { status: 200, body: '{"id":2,"owner":"bob","note":"bob-private-note"}' }, b: { status: 403, body: '{"error":"forbidden"}' } }), "diff different");
  c.expect(diff.sameStatus === false && diff.statusA === 200 && diff.statusB === 403, `status diff: ${JSON.stringify(diff)}`);
  c.expect(diff.lenDelta === '{"error":"forbidden"}'.length - '{"id":2,"owner":"bob","note":"bob-private-note"}'.length, `lenDelta ${diff.lenDelta}`);
  c.expect(diff.similarity < 0.2, `unrelated bodies similarity ${diff.similarity}`);
  const noisy = mustOk(
    c,
    await c.call("response_diff", { a: { status: 200, body: '{"user":"alice","csrf":"aaa111","nonce":"n-1","timestamp":"1700000000"}' }, b: { status: 200, body: '{"user":"alice","csrf":"zzz999","nonce":"n-2","timestamp":"1800000000"}' } }),
    "diff noisy"
  );
  c.expect(noisy.similarity === 1, `csrf/nonce/timestamp noise should be suppressed: ${JSON.stringify(noisy)}`);
});

// 10. intercept_start / intercept_pending / intercept_resolve (continue, modify response, fail, fulfill rule) / intercept_stop
scenario("intercept", async (c) => {
  const tabId = await c.open(APP);
  const result = (k: string) => c.evalJs(tabId, `window.__r[${JSON.stringify(k)}]`);
  const settled = (k: string) => until(() => result(k), (v) => v !== "pending" && v !== undefined, 8_000);
  const pending = async (args: any = {}) => (await c.call("intercept_pending", { tabId, ...args })).json ?? {};
  const waitPending = (n: number, args: any = {}) => until(() => pending(args), (j) => (j.pending ?? []).length >= n, 8_000);

  const off = await pending();
  c.expect(off.intercepting === false && off.count === 0, `pending before start: ${JSON.stringify(off)}`);
  const resolveOff = await c.call("intercept_resolve", { tabId, all: true });
  c.expect(resolveOff.isError, "intercept_resolve before intercept_start should error");

  // Request stage: plain continue, then continue with header mutation
  const st = mustOk(c, await c.call("intercept_start", { tabId, patterns: [{ urlPattern: "*/api/echo*" }] }), "intercept_start");
  c.expect(st.intercepting === true, `intercept_start: ${JSON.stringify(st)}`);
  await c.evalJs(tabId, "fire('k1', '/api/echo?k=1')");
  let p = await waitPending(1);
  const e1 = p.pending?.[0];
  c.expect(e1 && /\/api\/echo\?k=1$/.test(e1.url) && e1.method === "GET" && e1.stage === "Request", `paused entry: ${JSON.stringify(e1)}`);
  c.expect((await result("k1")) === "pending", "request should be held while paused");
  const res1 = mustOk(c, await c.call("intercept_resolve", { tabId, requestId: e1?.requestId, action: "continue" }), "resolve continue");
  c.expect(res1.resolved?.[0]?.resolved === "continue", `resolve continue: ${JSON.stringify(res1)}`);
  const k1 = await settled("k1");
  c.expect(k1?.status === 200 && /"k=1"|\?k=1/.test(k1?.body ?? ""), `continued request result: ${JSON.stringify(k1)}`);

  await c.evalJs(tabId, "fire('k2', '/api/echo?k=2')");
  p = await waitPending(1);
  const e2 = p.pending?.[0];
  mustOk(c, await c.call("intercept_resolve", { tabId, requestId: e2?.requestId, action: "continue", set: { headers: { "X-Tampered": "yes" } } }), "resolve continue+set");
  const k2 = await settled("k2");
  let k2echo: any = {};
  try {
    k2echo = JSON.parse(k2?.body ?? "{}");
  } catch {}
  c.expect(k2echo.headers?.["x-tampered"] === "yes", `set.headers not applied to the continued request: ${trim(k2?.body, 200)}`);
  const again = mustOk(c, await c.call("intercept_resolve", { tabId, requestId: e2?.requestId }), "resolve twice");
  c.expect(/not paused/.test(again.resolved?.[0]?.error ?? ""), `resolving an already-resolved id: ${JSON.stringify(again)}`);

  // fail
  await c.evalJs(tabId, "fire('k3', '/api/echo?k=3')");
  p = await waitPending(1);
  mustOk(c, await c.call("intercept_resolve", { tabId, requestId: p.pending?.[0]?.requestId, action: "fail" }), "resolve fail");
  const k3 = await settled("k3");
  c.expect(typeof k3?.error === "string" && /Failed to fetch|TypeError/i.test(k3.error), `failed request should reject in the page: ${JSON.stringify(k3)}`);

  // Response stage: read the real body, then modify the response the page sees
  mustOk(c, await c.call("intercept_start", { tabId, stage: "Response", patterns: [{ urlPattern: "*/api/me*", requestStage: "Response" }] }), "intercept_start Response");
  await c.evalJs(tabId, `fire('k4', '/api/me', {headers: {Authorization: 'Bearer alice-token'}})`);
  p = await waitPending(1, { withBodies: true });
  const e4 = p.pending?.[0];
  c.expect(e4?.stage === "Response" && e4?.responseStatusCode === 200 && /"user":"alice"/.test(e4?.body ?? ""), `Response-stage pending: ${trim(JSON.stringify(e4), 300)}`);
  mustOk(c, await c.call("intercept_resolve", { tabId, requestId: e4?.requestId, action: "modify", response: { status: 203, headers: { "content-type": "application/json" }, body: '{"user":"mallory"}' } }), "resolve modify");
  const k4 = await settled("k4");
  c.expect(k4?.status === 203 && k4?.body === '{"user":"mallory"}', `modified response not seen by the page: ${JSON.stringify(k4)}`);

  // auto-resolve rule (fulfill) - never queues
  mustOk(
    c,
    await c.call("intercept_start", { tabId, patterns: [{ urlPattern: "*/api/search*" }], rules: [{ match: { urlContains: "/api/search", method: "GET" }, action: "fulfill", response: { status: 200, headers: { "content-type": "text/plain" }, body: "ruled" } }] }),
    "intercept_start rules"
  );
  await c.evalJs(tabId, "fire('k5', '/api/search?q=rule')");
  const k5 = await settled("k5");
  c.expect(k5?.status === 200 && k5?.body === "ruled", `rule fulfill: ${JSON.stringify(k5)}`);
  c.expect(((await pending()).pending ?? []).length === 0, "a rule-resolved request was left pending");

  // intercept_stop releases a held request and disables interception
  mustOk(c, await c.call("intercept_start", { tabId, patterns: [{ urlPattern: "*/api/echo*" }] }), "intercept_start again");
  await c.evalJs(tabId, "fire('k6', '/api/echo?k=6')");
  await waitPending(1);
  const stop = mustOk(c, await c.call("intercept_stop", { tabId }), "intercept_stop");
  c.expect(stop.intercepting === false, `intercept_stop: ${JSON.stringify(stop)}`);
  const k6 = await settled("k6");
  c.expect(k6?.status === 200, `held request not released by intercept_stop: ${JSON.stringify(k6)}`);
  await c.evalJs(tabId, "fire('k7', '/api/echo?k=7')");
  const k7 = await settled("k7");
  c.expect(k7?.status === 200, `request after intercept_stop: ${JSON.stringify(k7)}`);
  c.expect((await pending()).intercepting === false, "still intercepting after stop");
});

// 11. fuzz: detects the reflected parameter + the quote-induced error; header-marker template
scenario("fuzz", async (c) => {
  const tabId = await c.open(APP);
  const payloads = ["apple", "banana", "cherry", "bbxss<b>z</b>", "o'brien"];
  const f = mustOk(c, await c.call("fuzz", { tabId, template: `${origin()}/api/search?q=§`, payloads }, { timeoutMs: 60_000 }), "fuzz sniper");
  const res: any[] = f.results ?? [];
  c.note(`fuzz: ${res.map((r) => `${r.payload}=${r.status}/${r.length}${r.anomaly ? "!" : ""}`).join(" ")}`);
  c.expect(f.mode === "sniper" && f.count === payloads.length && res.length === payloads.length, `fuzz shape: ${trim(JSON.stringify(f), 200)}`);
  c.expect(f.baseline?.status === 200, `baseline status ${f.baseline?.status}`);
  const by = (p: string) => res.find((r) => r.payload === p);
  for (const p of ["apple", "banana", "cherry", "bbxss<b>z</b>"]) {
    c.expect(by(p)?.status === 200 && (by(p)?.snippet ?? "").includes(`Results for: ${p}`), `payload ${p} not reflected verbatim: ${JSON.stringify(by(p))}`);
    c.expect(by(p)?.anomaly === false, `benign payload ${p} flagged as anomaly`);
  }
  c.expect(by("o'brien")?.status === 500 && by("o'brien")?.anomaly === true, `quote payload should be a 500 anomaly: ${JSON.stringify(by("o'brien"))}`);
  c.expect(res[0]?.payload === "o'brien", "anomalies should be sorted first");
  c.expect(f.anomalies === 1, `anomalies=${f.anomalies}`);

  // marker inside a header of an object template
  const g = mustOk(c, await c.call("fuzz", { tabId, template: { url: `${origin()}/api/me`, headers: { Authorization: "Bearer §" } }, payloads: ["alice-token", "bob-token", "mallory-token"], identity: "anon" }, { timeoutMs: 60_000 }), "fuzz header");
  const gr = (p: string) => (g.results ?? []).find((r: any) => r.payload === p);
  c.expect(gr("alice-token")?.status === 200 && /alice/.test(gr("alice-token")?.snippet ?? ""), `header fuzz alice: ${JSON.stringify(gr("alice-token"))}`);
  c.expect(gr("bob-token")?.status === 200 && /bob/.test(gr("bob-token")?.snippet ?? ""), "header fuzz bob");
  c.expect(gr("mallory-token")?.status === 401 && gr("mallory-token")?.anomaly === true, `invalid token should be the 401 anomaly: ${JSON.stringify(gr("mallory-token"))}`);
  const bad = await c.call("fuzz", { tabId, template: `${origin()}/api/search?q=§`, payloads: [] });
  c.expect(bad.isError, "sniper with no payloads should error");
});

// 12. cookies_get / cookies_set / cookies_delete (incl HttpOnly)
scenario("cookies", async (c) => {
  const tabId = await c.open(APP);
  const url = `${origin()}/`;
  const set = mustOk(c, await c.call("cookies_set", { url, name: "dt_http", value: "v1", httpOnly: true, path: "/", sameSite: "lax", expirationDate: Math.floor(Date.now() / 1000) + 3600 }), "cookies_set");
  c.expect(set.set === true && set.cookie?.httpOnly === true, `cookies_set: ${JSON.stringify(set)}`);
  const got = mustOk(c, await c.call("cookies_get", { url, name: "dt_http" }), "cookies_get");
  const ck = got.cookies?.[0];
  c.expect(got.count === 1 && ck?.value === "v1" && ck?.httpOnly === true && ck?.sameSite === "lax" && typeof ck?.expirationDate === "number", `cookies_get: ${JSON.stringify(got)}`);
  c.expect(!String(await c.evalJs(tabId, "document.cookie")).includes("dt_http"), "HttpOnly cookie visible to document.cookie");
  const echo = await api(c, tabId, "/api/echo?ck=1");
  c.expect(echo.body?.cookies?.dt_http === "v1", `cookie not sent by the browser: ${JSON.stringify(echo.body?.cookies)}`);
  // server-set HttpOnly cookie is readable through cookies_get
  await api(c, tabId, "/api/login?user=bob");
  const byDomain = mustOk(c, await c.call("cookies_get", { domain: "127.0.0.1" }), "cookies_get domain");
  const sid = (byDomain.cookies ?? []).find((x: any) => x.name === "sid");
  c.expect(sid?.value === "sess-bob" && sid?.httpOnly === true, `server HttpOnly sid via cookies_get: ${JSON.stringify(sid)}`);
  const del = mustOk(c, await c.call("cookies_delete", { url, name: "dt_http" }), "cookies_delete");
  c.expect(del.deleted === true, `cookies_delete: ${JSON.stringify(del)}`);
  const gone = mustOk(c, await c.call("cookies_get", { url, name: "dt_http" }), "cookies_get after delete");
  c.expect(gone.count === 0, `cookie still present after delete: ${JSON.stringify(gone)}`);
  for (const n of ["sid", "prefs"]) await c.call("cookies_delete", { url, name: n });
});

// 13. storage_dump / storage_set / storage_remove / storage_clear (local + session)
scenario("web-storage", async (c) => {
  const tabId = await c.open(APP);
  await c.evalJs(tabId, "localStorage.clear(); sessionStorage.clear(); true");
  mustOk(c, await c.call("storage_set", { tabId, key: "k1", value: "v1" }), "storage_set local (default)");
  mustOk(c, await c.call("storage_set", { tabId, area: "local", key: "k2", value: "v2" }), "storage_set local");
  mustOk(c, await c.call("storage_set", { tabId, area: "session", key: "s1", value: "sv1" }), "storage_set session");
  const dump = mustOk(c, await c.call("storage_dump", { tabId }), "storage_dump");
  c.expect(dump.origin === origin(), `dump origin ${dump.origin}`);
  c.expect(JSON.stringify(dump.local) === JSON.stringify({ k1: "v1", k2: "v2" }) || (dump.local?.k1 === "v1" && dump.local?.k2 === "v2" && Object.keys(dump.local).length === 2), `local: ${JSON.stringify(dump.local)}`);
  c.expect(JSON.stringify(dump.session) === JSON.stringify({ s1: "sv1" }), `session: ${JSON.stringify(dump.session)}`);
  c.expect((await c.evalJs(tabId, "localStorage.getItem('k1') + '|' + sessionStorage.getItem('s1')")) === "v1|sv1", "page does not see the stored values");
  const onlySession = mustOk(c, await c.call("storage_dump", { tabId, kinds: ["session"] }), "storage_dump session");
  c.expect(onlySession.local === undefined && onlySession.session?.s1 === "sv1", `kinds:[session]: ${JSON.stringify(onlySession)}`);
  mustOk(c, await c.call("storage_remove", { tabId, area: "local", key: "k1" }), "storage_remove");
  c.expect((await c.evalJs(tabId, "localStorage.getItem('k1')")) === null, "k1 not removed");
  mustOk(c, await c.call("storage_remove", { tabId, area: "session", key: "nope" }), "storage_remove missing key");
  const clr = mustOk(c, await c.call("storage_clear", { tabId, area: "local" }), "storage_clear local");
  c.expect(clr.cleared === true, `storage_clear: ${JSON.stringify(clr)}`);
  const d2 = mustOk(c, await c.call("storage_dump", { tabId }), "dump after local clear");
  c.expect(Object.keys(d2.local ?? {}).length === 0 && d2.session?.s1 === "sv1", `local clear touched session or left local: ${JSON.stringify(d2)}`);
  mustOk(c, await c.call("storage_clear", { tabId, area: "session" }), "storage_clear session");
  const d3 = mustOk(c, await c.call("storage_dump", { tabId }), "dump after session clear");
  c.expect(Object.keys(d3.session ?? {}).length === 0, `session not cleared: ${JSON.stringify(d3)}`);
});

// 14. console_start / console_get / console_stop
scenario("console-capture", async (c) => {
  const tabId = await c.open(APP);
  const st = mustOk(c, await c.call("console_start", { tabId }), "console_start");
  c.expect(st.capturing === true, `console_start: ${JSON.stringify(st)}`);
  await c.evalJs(tabId, "doLogs('t1')");
  const get = async (args: any = {}) => (await c.call("console_get", { tabId, ...args })).json ?? {};
  const all = await until(() => get({ pattern: "t1" }), (j) => (j.logs ?? []).some((l: any) => l.source === "exception"), 8_000);
  const logs: any[] = all.logs ?? [];
  c.note(`logs: ${logs.map((l) => `${l.source}/${l.level}:${l.text}`).join(" | ")}`);
  const lv = (t: string) => logs.find((l) => l.text?.includes(t));
  c.expect(lv("bb-log t1")?.level === "log", "console.log level");
  c.expect(lv("bb-info t1")?.level === "info", "console.info level");
  c.expect(lv("bb-warn t1")?.level === "warning", `console.warn level ${lv("bb-warn t1")?.level}`);
  c.expect(lv("bb-error t1")?.level === "error", "console.error level");
  const ex = logs.find((l) => l.source === "exception");
  c.expect(ex?.level === "error" && /bb-uncaught t1/.test(ex?.text ?? ""), `uncaught exception entry: ${JSON.stringify(ex)}`);
  const errs = await get({ level: "error", pattern: "t1" });
  c.expect((errs.logs ?? []).length === 2 && errs.logs.every((l: any) => l.level === "error"), `level:error -> ${JSON.stringify(errs.logs)}`);
  const warn = await get({ pattern: "bb-warn t1" });
  c.expect(warn.total === 1, `pattern filter total ${warn.total}`);
  const lim = await get({ pattern: "t1", limit: 2 });
  c.expect((lim.logs ?? []).length === 2 && lim.total === 5, `limit:2 -> ${(lim.logs ?? []).length} (total ${lim.total})`);
  const stop = mustOk(c, await c.call("console_stop", { tabId }), "console_stop");
  c.expect(stop.capturing === false, `console_stop: ${JSON.stringify(stop)}`);
  await c.evalJs(tabId, "doLogs('t2')");
  await sleep(700);
  const afterRes = await get({ pattern: "t2" });
  c.expect(afterRes.capturing === false && (afterRes.logs ?? []).length === 0, `logs captured after console_stop: ${JSON.stringify(afterRes.logs)}`);
});

// 15. jwt_decode on tokens issued by the fixture server
scenario("jwt-decode", async (c) => {
  const tabId = await c.open(APP);
  const good = (await api(c, tabId, "/api/jwt?sub=alice")).body?.token;
  const d = mustOk(c, await c.call("jwt_decode", { token: `Bearer ${good}` }), "jwt_decode");
  c.expect(d.header?.alg === "HS256" && d.header?.typ === "JWT" && d.alg === "HS256", `header: ${JSON.stringify(d.header)}`);
  c.expect(d.payload?.sub === "alice" && d.payload?.role === "admin", `payload: ${JSON.stringify(d.payload)}`);
  c.expect(d.signaturePresent === true && d.expired === false && d.expiresInSec > 3000 && d.expiresInSec <= 3600, `expiry: ${JSON.stringify(d)}`);
  c.expect((d.findings ?? []).some((f: any) => f.id === "hmac-alg"), "HS256 alg-confusion hint missing");
  const none = (await api(c, tabId, "/api/jwt?sub=bob&alg=none&exp=past")).body?.token;
  const n = mustOk(c, await c.call("jwt_decode", { token: none }), "jwt_decode none");
  c.expect(n.alg === "none" && n.signaturePresent === false && n.expired === true, `alg none token: ${JSON.stringify(n)}`);
  c.expect((n.findings ?? []).some((f: any) => f.id === "alg-none" && f.severity === "high"), "alg:none not flagged high");
  c.expect((n.findings ?? []).some((f: any) => f.id === "expired"), "expired not flagged");
  const bad = await c.call("jwt_decode", { token: "not-a-jwt" });
  c.expect(bad.isError, "non-JWT input should error");
});

// 16. analyze (headers, cookies, secrets; deep sweeps the same-origin bundle)
scenario("analyze", async (c) => {
  const tabId = await c.open("devtools/analyze");
  const a = mustOk(c, await c.call("analyze", { tabId }, { timeoutMs: 60_000 }), "analyze");
  const ids = new Set((a.findings ?? []).map((f: any) => f.id));
  c.note(`analyze findings: ${[...ids].join(",")}`);
  c.expect(a.url === `${origin()}/devtools/analyze` && a.status === 200, `analyze url/status: ${a.url} ${a.status}`);
  for (const id of ["csp-unsafe-inline", "csp-unsafe-eval", "csp-no-object-src", "clickjacking", "cors-wildcard-creds", "no-nosniff", "x-powered-by", "server-version", "secret-aws-akia", "secret-jwt", "cookie-not-httponly"]) {
    c.expect(ids.has(id), `missing finding ${id}`);
  }
  c.expect(!ids.has("csp-missing"), "CSP is present but reported missing");
  c.expect(!ids.has("secret-github-token"), "non-deep analyze should not have swept the external bundle");
  const sev = (a.findings ?? []).map((f: any) => ({ high: 3, medium: 2, low: 1, info: 0 } as any)[f.severity]);
  c.expect(sev.every((s: number, i: number) => i === 0 || sev[i - 1] >= s), "findings not sorted by severity");
  c.expect(a.summary?.total === (a.findings ?? []).length && a.summary?.high >= 2, `summary: ${JSON.stringify(a.summary)}`);
  c.expect((a.cookies ?? []).some((k: any) => k.name === "session_token" && k.httpOnly === false), `cookie report: ${JSON.stringify(a.cookies)}`);
  const deep = mustOk(c, await c.call("analyze", { tabId, url: `${origin()}/devtools/analyze`, deep: true }, { timeoutMs: 60_000 }), "analyze deep");
  const gh = (deep.findings ?? []).find((f: any) => f.id === "secret-github-token");
  c.expect(gh && /external script/.test(gh.detail ?? "") && /analyze-bundle\.js/.test(gh.evidence ?? ""), `deep: bundle secret not found: ${JSON.stringify(gh)}`);
  await c.call("cookies_delete", { url: `${origin()}/`, name: "session_token" });
});
