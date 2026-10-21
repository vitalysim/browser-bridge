// A taken port must produce ONE clear line and a delayed non-zero exit, not an unhandled 'error'
// crash that launchd relaunches instantly (the real log held ~104,000 of those).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { handleListenError, probeBridgeHealth } from "../src/listen.js";

const eaddrinuse = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });

function harness(probeResult: boolean) {
  const logs: string[] = [];
  const exits: number[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const deps = {
    port: 8765,
    host: "127.0.0.1",
    log: (m: string) => logs.push(m),
    exit: (c: number) => exits.push(c),
    probe: async () => probeResult,
    setTimer: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  };
  return { logs, exits, timers, deps };
}

test("EADDRINUSE with no healthy bridge: one line, exit(1) after 30s", async () => {
  const h = harness(false);
  await handleListenError(eaddrinuse, h.deps);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /port 8765 is already in use - another browser-bridge server is probably running/);
  assert.equal(h.exits.length, 0, "must not exit immediately");
  assert.equal(h.timers[0].ms, 30_000);
  h.timers[0].fn();
  assert.deepEqual(h.exits, [1]);
});

test("EADDRINUSE with a healthy bridge on the port says so", async () => {
  const h = harness(true);
  await handleListenError(eaddrinuse, h.deps);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /healthy browser-bridge/);
});

test("other listen errors are logged and also exit after the delay", async () => {
  const h = harness(false);
  await handleListenError(Object.assign(new Error("permission denied"), { code: "EACCES" }), h.deps);
  assert.match(h.logs[0], /cannot listen.*EACCES/);
  assert.equal(h.timers.length, 1);
});

test("probeBridgeHealth recognises a browser-bridge /health and rejects anything else", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/health") res.end(JSON.stringify({ ok: true, extensionConnected: false }));
    else res.end("nope");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  try {
    assert.equal(await probeBridgeHealth("127.0.0.1", port), true);
  } finally {
    srv.close();
  }
  const other = createServer((_req, res) => res.end("<html>"));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  try {
    assert.equal(await probeBridgeHealth("127.0.0.1", (other.address() as any).port), false);
  } finally {
    other.close();
  }
});
