// Recordings must survive an extension socket drop: the extension keeps recording across SW restarts
// and replays its outbox on reconnect, so the hub holds session/capture sinks open for a grace period,
// re-adopts them on the reconnect's hello, and only finalizes them when the grace expires. Real local
// WebSocket; the "extension" is a ws client with the chrome-extension:// origin the hub requires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocket } from "ws";
import { ExtensionHub } from "../src/hub.js";
import { CaptureSink } from "../src/capture-sink.js";
import { parseSessionEventsStream } from "../src/capture-format.js";

const TOKEN = "t";
const rrweb = (timestamp: number) => ({ kind: "rrweb", event: { type: 3, timestamp } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(sinkGraceMs: number) {
  const server = createServer();
  const hub = new ExtensionHub(server, TOKEN, "0.0.0", { reconnectGraceMs: 500, sinkReconnectGraceMs: sinkGraceMs });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws?token=${TOKEN}`;
  const dir = mkdtempSync(join(tmpdir(), "bb-reconnect-"));
  const sockets: WebSocket[] = [];
  const connect = async (hello: Record<string, unknown> = {}) => {
    const ws = new WebSocket(url, { origin: "chrome-extension://test" });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.method === "session_record_stop") ws.send(JSON.stringify({ id: m.id, ok: true, result: { tabId: m.params.tabId ?? 5 } }));
    });
    await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
    ws.send(JSON.stringify({ type: "hello", version: "0.0.0", ...hello }));
    sockets.push(ws);
    await sleep(30);
    return ws;
  };
  const send = async (ws: WebSocket, msg: any) => {
    ws.send(JSON.stringify(msg));
    await sleep(30);
  };
  const drop = async (ws: WebSocket) => {
    ws.terminate();
    await sleep(60);
  };
  const cleanup = async () => {
    for (const s of sockets) s.terminate();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  return { hub, dir, connect, send, drop, cleanup };
}

test("a session recording keeps writing across a socket drop + reconnect (no truncation)", async () => {
  const t = await setup(5_000);
  try {
    const path = join(t.dir, "s.events.jsonl");
    t.hub.registerSessionSink(5, new CaptureSink(path));
    t.hub.setRecordingPath(5, path);
    const a = await t.connect();
    await t.send(a, { type: "capture", stream: "session", tabId: 5, entries: [rrweb(1)] });
    await t.drop(a);
    assert.equal(t.hub.sessionSinkList().length, 1, "sink still open during the grace");
    assert.equal(t.hub.sessionSinkList()[0].awaitingReconnect, true);
    // The extension reconnects and replays its outbox, then the recording continues and ends.
    const b = await t.connect();
    assert.equal(t.hub.sinksHeld, false, "re-adopted on hello");
    await t.send(b, { type: "capture", stream: "session", tabId: 5, entries: [rrweb(2), rrweb(3)] });
    const r = await t.hub.call("session_record_stop", { tabId: 5 });
    await t.send(b, { type: "capture", stream: "session", tabId: 5, entries: [rrweb(4)], done: true });
    await t.hub.settleSessionSink(r.tabId, 2_000);
    const events = await parseSessionEventsStream(t.hub.getRecordingPath(5)!);
    assert.deepEqual(events.map((e) => e.timestamp), [1, 2, 3, 4]);
  } finally {
    await t.cleanup();
  }
});

test("capture (watch-net) sinks are held and re-adopted too", async () => {
  const t = await setup(5_000);
  try {
    const path = join(t.dir, "net.jsonl");
    const sink = new CaptureSink(path);
    t.hub.registerCaptureSink(9, sink);
    const a = await t.connect();
    await t.send(a, { type: "capture", tabId: 9, entries: [{ kind: "net", url: "a" }] });
    await t.drop(a);
    const b = await t.connect();
    await t.send(b, { type: "capture", tabId: 9, entries: [{ kind: "net", url: "b" }] });
    assert.equal(t.hub.closeCaptureSink(9), 2, "both rows reached the same, still-open sink");
  } finally {
    await t.cleanup();
  }
});

test("sinks are finalized when the extension does not come back within the grace", async () => {
  const t = await setup(150);
  try {
    const path = join(t.dir, "s.events.jsonl");
    t.hub.registerSessionSink(5, new CaptureSink(path));
    t.hub.registerCaptureSink(9, new CaptureSink(join(t.dir, "n.jsonl")));
    const a = await t.connect();
    await t.send(a, { type: "capture", stream: "session", tabId: 5, entries: [rrweb(1)] });
    await t.drop(a);
    await sleep(300);
    assert.equal(t.hub.sinksHeld, false);
    assert.equal(t.hub.sessionSinkList().length, 0, "session sink finalized after the grace");
    assert.equal(t.hub.closeCaptureSink(9), undefined, "capture sink finalized after the grace");
    // A later stop still finds the finalized (drained) recording.
    await t.hub.settleSessionSink(5, 100);
    assert.equal((await parseSessionEventsStream(path)).length, 1);
  } finally {
    await t.cleanup();
  }
});

test("a hello that lists its live recordings re-adopts only those", async () => {
  const t = await setup(5_000);
  try {
    t.hub.registerSessionSink(5, new CaptureSink(join(t.dir, "a.jsonl")));
    t.hub.registerSessionSink(6, new CaptureSink(join(t.dir, "b.jsonl")));
    t.hub.registerCaptureSink(9, new CaptureSink(join(t.dir, "n.jsonl")));
    const a = await t.connect();
    await t.drop(a);
    await t.connect({ recordings: [6], captures: [] });
    assert.deepEqual(t.hub.sessionSinkList().map((s) => s.tabId), [6]);
    assert.equal(t.hub.closeCaptureSink(9), undefined);
  } finally {
    await t.cleanup();
  }
});

test("a replaced (stale) socket closing does not hold or finalize the live sinks", async () => {
  const t = await setup(100);
  try {
    t.hub.registerSessionSink(5, new CaptureSink(join(t.dir, "a.jsonl")));
    const a = await t.connect();
    const b = await t.connect(); // replaces a; a's close must not touch b's sinks
    void a;
    await sleep(250);
    assert.equal(t.hub.sinksHeld, false);
    assert.equal(t.hub.sessionSinkList().length, 1);
    await t.send(b, { type: "capture", stream: "session", tabId: 5, entries: [rrweb(1)] });
    assert.equal(t.hub.sessionSinkList()[0].written, 1);
  } finally {
    await t.cleanup();
  }
});
