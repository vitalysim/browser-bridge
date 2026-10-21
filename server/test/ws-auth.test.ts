// The v2 extension handshake: the token must never cross the wire, the server must not attach (or
// let replace the live connection) an unauthenticated socket, and the server must prove itself back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { createHmac, randomBytes } from "crypto";
import { WebSocket } from "ws";
import { ExtensionHub, WS_AUTH_FAILED_CLOSE_CODE, WS_AUTH_TIMEOUT_CLOSE_CODE } from "../src/hub.js";
import { extMac, srvMac, safeEqual, verifyAuthReply } from "../src/ws-auth.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function startHub(): Promise<{ hub: ExtensionHub; server: Server; base: string }> {
  const server = createServer();
  const hub = new ExtensionHub(server, TOKEN, "0.0.0", { reconnectGraceMs: 200 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { hub, server, base: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws` };
}

async function stop(server: Server, ...sockets: WebSocket[]) {
  for (const s of sockets) s.terminate();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
}

/** A fake extension that runs the client side of the handshake with `token`. Resolves with the socket
 *  and every frame it saw, once auth-ok (verified) arrives or the socket closes. */
function fakeExtension(base: string, token: string, opts: { tamperMac?: boolean; onCall?: (msg: any, ws: WebSocket) => void } = {}) {
  return new Promise<{ ws: WebSocket; frames: any[]; authed: boolean; serverVerified: boolean; closeCode?: number }>((resolve, reject) => {
    const ws = new WebSocket(base, { origin: "chrome-extension://test" });
    const frames: any[] = [];
    let sNonce = "";
    const cNonce = randomBytes(32).toString("hex");
    let settled = false;
    const done = (v: any) => {
      if (!settled) {
        settled = true;
        resolve({ ws, frames, ...v });
      }
    };
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      frames.push(msg);
      if (msg.type === "challenge") {
        sNonce = msg.nonce;
        let mac = createHmac("sha256", token).update(`ext|${sNonce}|${cNonce}`).digest("hex");
        if (opts.tamperMac) mac = (mac[0] === "0" ? "1" : "0") + mac.slice(1);
        ws.send(JSON.stringify({ type: "auth", cNonce, mac }));
      } else if (msg.type === "auth-ok") {
        const expected = createHmac("sha256", token).update(`srv|${cNonce}|${sNonce}`).digest("hex");
        done({ authed: true, serverVerified: msg.mac === expected });
      } else opts.onCall?.(msg, ws);
    });
    ws.once("close", (code) => done({ authed: false, serverVerified: false, closeCode: code }));
    ws.once("error", reject);
  });
}

test("handshake: correct token -> auth-ok with a server proof the extension can verify; hub connects", async () => {
  const { hub, server, base } = await startHub();
  const ext = await fakeExtension(base, TOKEN, {
    onCall: (msg, ws) => {
      if (msg.id) ws.send(JSON.stringify({ id: msg.id, ok: true, result: { pong: msg.method } }));
    },
  });
  assert.equal(ext.authed, true);
  assert.equal(ext.serverVerified, true);
  assert.equal(ext.frames[0].type, "challenge");
  assert.match(ext.frames[0].nonce, /^[0-9a-f]{64}$/);
  // No frame the server sent contains the token.
  assert.ok(!JSON.stringify(ext.frames).includes(TOKEN));
  assert.equal(hub.connected, true);
  assert.deepEqual(await hub.call("tabs_list"), { pong: "tabs_list" });
  await stop(server, ext.ws);
});

test("handshake: wrong token -> closed with 4001, never attached", async () => {
  const { hub, server, base } = await startHub();
  const ext = await fakeExtension(base, "ffffffffffffffffffffffffffffffff");
  assert.equal(ext.authed, false);
  assert.equal(ext.closeCode, WS_AUTH_FAILED_CLOSE_CODE);
  assert.equal(hub.connected, false);
  await stop(server, ext.ws);
});

test("handshake: a tampered mac is rejected", async () => {
  const { hub, server, base } = await startHub();
  const ext = await fakeExtension(base, TOKEN, { tamperMac: true });
  assert.equal(ext.closeCode, WS_AUTH_FAILED_CLOSE_CODE);
  assert.equal(hub.connected, false);
  await stop(server, ext.ws);
});

test("handshake: an unauthenticated socket cannot replace the live connection or send traffic", async () => {
  const { hub, server, base } = await startHub();
  const good = await fakeExtension(base, TOKEN, {
    onCall: (msg, ws) => msg.id && ws.send(JSON.stringify({ id: msg.id, ok: true, result: "from-good" })),
  });
  assert.equal(hub.connected, true);
  // An impostor opens a socket and sends a "reply" and a hello instead of authenticating.
  const bad = new WebSocket(base, { origin: "chrome-extension://evil" });
  const badClosed = new Promise<number>((r) => bad.once("close", (c) => r(c)));
  await new Promise((r) => bad.once("open", r));
  bad.send(JSON.stringify({ type: "hello", version: "9.9.9" }));
  assert.equal(await badClosed, WS_AUTH_FAILED_CLOSE_CODE);
  assert.equal(hub.lastHello, null, "hello from an unauthenticated socket was ignored");
  assert.equal(await hub.call("tabs_list"), "from-good", "the authenticated connection is still the live one");
  await stop(server, good.ws, bad);
});

test("legacy ?token= path still attaches with the right token (one-release compatibility) and rejects a wrong one", async () => {
  const { hub, server, base } = await startHub();
  const ok = new WebSocket(`${base}?token=${TOKEN}`, { origin: "chrome-extension://test" });
  await new Promise((r, j) => (ok.once("open", r), ok.once("error", j)));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hub.connected, true);
  const bad = new WebSocket(`${base}?token=nope`, { origin: "chrome-extension://test" });
  await assert.rejects(new Promise((r, j) => (bad.once("open", r), bad.once("error", j))));
  await stop(server, ok);
});

test("verifyAuthReply rejects malformed input and a reflected nonce", () => {
  const s = "a".repeat(64);
  const c = "b".repeat(64);
  assert.equal(verifyAuthReply(TOKEN, s, { type: "auth", cNonce: c, mac: extMac(TOKEN, s, c) }).ok, true);
  assert.equal(verifyAuthReply(TOKEN, s, { type: "auth", cNonce: s, mac: extMac(TOKEN, s, s) }).ok, false);
  assert.equal(verifyAuthReply(TOKEN, s, { type: "auth", cNonce: "xyz", mac: extMac(TOKEN, s, c) }).ok, false);
  assert.equal(verifyAuthReply(TOKEN, s, { type: "auth", cNonce: c, mac: "zz" }).ok, false);
  assert.equal(verifyAuthReply(TOKEN, s, { type: "hello" }).ok, false);
  // The server proof is domain-separated from the extension proof: one can't be reflected as the other.
  assert.notEqual(srvMac(TOKEN, c, s), extMac(TOKEN, s, c));
  assert.notEqual(srvMac(TOKEN, s, c), extMac(TOKEN, s, c));
});

test("safeEqual is exact", () => {
  assert.equal(safeEqual("Bearer abc", "Bearer abc"), true);
  assert.equal(safeEqual("Bearer abc", "Bearer abd"), false);
  assert.equal(safeEqual("Bearer ab", "Bearer abc"), false);
  assert.equal(safeEqual("", "Bearer abc"), false);
});

test("handshake: no reply in time -> closed with the distinct timeout code (not a token rejection)", async () => {
  const server = createServer();
  new ExtensionHub(server, TOKEN, "0.0.0", { reconnectGraceMs: 200, authTimeoutMs: 150 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`, { origin: "chrome-extension://test" });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      ws.once("close", (c) => resolve(c));
      ws.once("error", reject);
      // Receive the challenge, never answer it (a worker suspended mid-handshake).
    });
    assert.equal(code, WS_AUTH_TIMEOUT_CLOSE_CODE);
    assert.notEqual(code, WS_AUTH_FAILED_CLOSE_CODE);
  } finally {
    await stop(server, ws);
  }
});
