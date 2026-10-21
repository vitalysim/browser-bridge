// replay_request header building (extension/src/replay-headers.ts, pure): captured auth/CSRF/custom
// headers must survive a replay; headers fetch() can't set are dropped; overrides and identity apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReplayHeaders, isReplayableHeader } from "../../extension/src/replay-headers.js";

const captured = {
  ":authority": "api.example.com",
  ":method": "POST",
  Host: "api.example.com",
  Cookie: "sid=1",
  "Content-Length": "12",
  Connection: "keep-alive",
  "Keep-Alive": "timeout=5",
  "Proxy-Authorization": "Basic x",
  "sec-ch-ua": '"Chromium"',
  "Sec-Fetch-Mode": "cors",
  "Transfer-Encoding": "chunked",
  Upgrade: "h2c",
  TE: "trailers",
  Trailer: "x",
  Expect: "100-continue",
  Date: "now",
  Via: "1.1 proxy",
  Origin: "https://app.example.com",
  "Accept-Encoding": "gzip",
  Referer: "https://app.example.com/page",
  Authorization: "Bearer AAA",
  "X-CSRF-Token": "csrf123",
  "x-api-key": "k",
  Accept: "application/json",
  "Content-Type": "application/json",
};

test("all settable captured headers are kept (lower-cased); forbidden/hop-by-hop are dropped", () => {
  const { headers, referrer } = buildReplayHeaders(captured, null, { hasBody: true });
  assert.deepEqual(headers, {
    authorization: "Bearer AAA",
    "x-csrf-token": "csrf123",
    "x-api-key": "k",
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.equal(referrer, "https://app.example.com/page");
});

test("content-type is dropped when the replay has no body", () => {
  const { headers } = buildReplayHeaders(captured, null, { hasBody: false });
  assert.equal(headers["content-type"], undefined);
  assert.equal(headers.authorization, "Bearer AAA");
});

test("overrides apply case-insensitively, can remove a header, and can't set forbidden ones", () => {
  const { headers, referrer } = buildReplayHeaders(captured, { "X-CSRF-TOKEN": "new", "x-api-key": "", cookie: "evil=1", host: "h", Referer: "https://other/" }, { hasBody: true });
  assert.equal(headers["x-csrf-token"], "new");
  assert.equal("x-api-key" in headers, false);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.host, undefined);
  assert.equal(referrer, "https://other/");
});

test("identity anon strips the captured Authorization (an explicit override survives)", () => {
  assert.equal(buildReplayHeaders(captured, null, { hasBody: true, identity: "anon" }).headers.authorization, undefined);
  assert.equal(buildReplayHeaders(captured, { Authorization: "Bearer O" }, { hasBody: true, identity: "anon" }).headers.authorization, "Bearer O");
});

test("a named identity's bearer replaces Authorization; without a bearer the session's is not forwarded", () => {
  assert.equal(buildReplayHeaders(captured, { authorization: "Bearer O" }, { hasBody: true, identity: "bob", bearer: "Bearer BOB" }).headers.authorization, "Bearer BOB");
  assert.equal(buildReplayHeaders(captured, null, { hasBody: true, identity: "bob", bearer: null }).headers.authorization, undefined);
  assert.equal(buildReplayHeaders(captured, null, { hasBody: true, identity: "bob", bearer: null }).headers["x-csrf-token"], "csrf123");
});

test("isReplayableHeader", () => {
  for (const h of ["cookie", "Sec-Fetch-Site", "proxy-connection", ":path", "origin", "content-length"]) assert.equal(isReplayableHeader(h), false, h);
  for (const h of ["authorization", "x-requested-with", "accept-language", "if-none-match"]) assert.equal(isReplayableHeader(h), true, h);
});

test("null base / null values are tolerated", () => {
  assert.deepEqual(buildReplayHeaders(null, null, { hasBody: false }), { headers: {} });
  assert.deepEqual(buildReplayHeaders({ a: null as any, b: "1" }, { c: null as any }, { hasBody: false }), { headers: { b: "1" } });
});
