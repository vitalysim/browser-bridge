import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHub } from "../src/hub.js";
import { registerTools } from "../src/tools.js";
import { parseSessionEventsStream } from "../src/capture-format.js";
import { CaptureSink } from "../src/capture-sink.js";

const base = [
  { type: 4, timestamp: 1000, data: { width: 800, height: 600, href: "http://fixture.test/" } },
  { type: 2, timestamp: 1001, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } },
];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bb-recording-unit-"));
  const hub = new ExtensionHub(createServer(), "test-token");
  const tools = new Map<string, (args: any) => Promise<any>>();
  const register = () => registerTools({ registerTool(name: string, _cfg: any, cb: any) { tools.set(name, cb); } } as any, hub);
  register();
  const invoke = async (name: string, args: any) => {
    const out = await tools.get(name)!(args);
    return { error: !!out.isError, value: out.isError ? out.content[0].text : JSON.parse(out.content[0].text) };
  };
  let id = "";
  const stream = (events: any[], done = false, recordingId = id) => (hub as any).onCapture({
    type: "capture", stream: "session", recordingId, tabId: 7, entries: events.map((event) => ({ kind: "rrweb", event })), done,
  });
  let onStart = async () => { stream(base); };
  (hub as any).call = async (method: string, params: any) => {
    if (method === "session_record_prepare") return { tabId: 7 };
    if (method === "session_record_start") { id = params.recordingId; await onStart(); return { tabId: 7, recording: true }; }
    if (method === "session_record_stop") { stream([], true); return { tabId: 7 }; }
    throw new Error(`unexpected method ${method}`);
  };
  return { dir, hub, register, invoke, stream, setStart(fn: () => Promise<void>) { onStart = fn; }, async cleanup() { await hub.drainSinks(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the initial snapshot is durable even when streamed before start replies", async () => {
  const t = setup();
  try {
    const path = join(t.dir, "early.jsonl");
    assert.equal((await t.invoke("session_record_start", { eventsPath: path })).error, false);
    const stop = await t.invoke("session_record_stop", { tabId: 7, inlineAssets: false });
    assert.equal(stop.error, false, String(stop.value));
    assert.deepEqual(await parseSessionEventsStream(path), base);
    assert.ok(existsSync(stop.value.saved));
  } finally { await t.cleanup(); }
});

test("concurrent clients cannot replace a starting recording or truncate a second path", async () => {
  const t = setup();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const hold = new Promise<void>((r) => { release = r; });
  try {
    t.setStart(async () => { entered(); await hold; t.stream(base); });
    const firstPath = join(t.dir, "first.jsonl"), secondPath = join(t.dir, "second.jsonl");
    writeFileSync(secondPath, "preserve this file");
    const first = t.invoke("session_record_start", { eventsPath: firstPath });
    await started;
    t.register(); // another MCP session, same hub
    const duplicate = await t.invoke("session_record_start", { eventsPath: secondPath });
    assert.equal(duplicate.error, true);
    assert.equal(readFileSync(secondPath, "utf8"), "preserve this file");
    release();
    assert.equal((await first).error, false);
    assert.equal((await t.invoke("session_record_stop", { tabId: 7, inlineAssets: false })).error, false);
    assert.deepEqual(await parseSessionEventsStream(firstPath), base);
  } finally { release?.(); await t.cleanup(); }
});

test("failed starts release their reservation; incomplete events never produce a successful replay", async () => {
  const t = setup();
  try {
    t.setStart(async () => { throw new Error("injection failed"); });
    assert.equal((await t.invoke("session_record_start", { eventsPath: join(t.dir, "failed.jsonl") })).error, true);
    assert.equal(t.hub.sessionSinkList().length, 0);
    const raw = join(t.dir, "incomplete.jsonl"), html = join(t.dir, "incomplete.html");
    t.setStart(async () => { t.stream([{ type: 3, timestamp: 2000, data: { source: 0 } }]); });
    assert.equal((await t.invoke("session_record_start", { eventsPath: raw })).error, false);
    const stop = await t.invoke("session_record_stop", { tabId: 7, savePath: html, inlineAssets: false });
    assert.equal(stop.error, true);
    assert.match(stop.value, /no usable Meta\/full snapshot pair/);
    assert.ok(existsSync(raw));
    assert.equal(existsSync(html), false);
  } finally { await t.cleanup(); }
});

test("recording batches are deduplicated and late batches from a replaced recording are ignored", async () => {
  const t = setup();
  try {
    const path = join(t.dir, "dedupe.jsonl");
    const sink = new CaptureSink(path);
    t.hub.registerSessionSink(7, sink, "current-recording");
    const message = { type: "capture", stream: "session", recordingId: "current-recording", tabId: 7,
      documentId: "document-A", seq: 1, entries: base.map((event) => ({ kind: "rrweb", event })) };
    (t.hub as any).onCapture(message);
    (t.hub as any).onCapture(message); // final pagehide resend, or ACK lost during worker restart
    (t.hub as any).onCapture({ ...message, seq: 2, recordingId: "previous-recording" });
    t.hub.closeSessionSink(7);
    await sink.drain();
    assert.deepEqual(await parseSessionEventsStream(path), base);
  } finally { await t.cleanup(); }
});
