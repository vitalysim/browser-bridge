// Tests for ExtensionHub (server/src/hub.ts) over a real local WebSocket: reconnect grace, cancel-on-
// timeout, and quiet dropping of late replies. The "extension" is a plain ws client with the
// chrome-extension:// origin the hub requires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { ExtensionHub } from "../src/hub.js";

const TOKEN = "test-token";

async function startHub(graceMs: number): Promise<{ hub: ExtensionHub; server: Server; url: string }> {
  const server = createServer();
  const hub = new ExtensionHub(server, TOKEN, "0.0.0", { reconnectGraceMs: graceMs });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { hub, server, url: `ws://127.0.0.1:${port}/ws?token=${TOKEN}` };
}

// `onMessage` is attached BEFORE the socket opens: the hub sends a waiting call the instant the
// connection lands, which can beat a listener added after `open` resolves.
function connectExt(url: string, onMessage?: (msg: any, ws: WebSocket) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: "chrome-extension://test" });
    if (onMessage) ws.on("message", (d) => onMessage(JSON.parse(d.toString()), ws));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function stop(server: Server, ...sockets: WebSocket[]) {
  for (const s of sockets) s.terminate();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
}

test("call fails with NO_EXTENSION after the grace when nothing connects", async () => {
  const { hub, server } = await startHub(100);
  const t0 = Date.now();
  await assert.rejects(hub.call("tabs_list"), /not connected/);
  assert.ok(Date.now() - t0 >= 90, "waited for the reconnect grace");
  await stop(server);
});

test("call waits for an extension that reconnects within the grace", async () => {
  const { hub, server, url } = await startHub(2_000);
  const p = hub.call("tabs_list", {}, 2_000);
  await new Promise((r) => setTimeout(r, 150));
  const ext = await connectExt(url, (msg, ws) => {
    if (msg.method) ws.send(JSON.stringify({ id: msg.id, ok: true, result: ["tab"] }));
  });
  try {
    assert.deepEqual(await p, ["tab"]);
  } finally {
    await stop(server, ext);
  }
});

test("a timed-out call sends {type:'cancel', id} and drops the late reply quietly", async () => {
  const { hub, server, url } = await startHub(0);
  const ext = await connectExt(url);
  const seen: any[] = [];
  let callId = "";
  const cancelled = new Promise<void>((resolve) => {
    ext.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      seen.push(msg);
      if (msg.method) callId = msg.id;
      if (msg.type === "cancel") resolve();
    });
  });
  await assert.rejects(hub.call("slow", {}, 80), /timed out after 80ms/);
  await cancelled;
  const cancel = seen.find((m) => m.type === "cancel");
  assert.equal(cancel.id, callId, "cancel names the timed-out call");
  // A late reply for the cancelled id must not throw or disturb the next call.
  ext.send(JSON.stringify({ id: callId, ok: true, result: "late" }));
  ext.removeAllListeners("message");
  ext.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.method) ext.send(JSON.stringify({ id: msg.id, ok: true, result: "fresh" }));
  });
  assert.equal(await hub.call("next", {}, 1_000), "fresh");
  await stop(server, ext);
});

test("an in-flight call is rejected (not hung) when the extension disconnects", async () => {
  const { hub, server, url } = await startHub(0);
  const ext = await connectExt(url);
  const p = hub.call("never", {}, 5_000);
  await new Promise((r) => setTimeout(r, 50));
  ext.close();
  await assert.rejects(p, /disconnected before responding/);
  await stop(server, ext);
});
