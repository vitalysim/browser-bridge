// Per-scenario context + result bookkeeping. Each scenario records every tool call it made (trimmed),
// so a failure report shows real observed tool output rather than just an assertion message.
import { test, type TestContext } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS, CallTimeoutError, trim, type CallResult, type Harness } from "./harness.js";

export interface ScenarioRecord {
  name: string;
  status: "pass" | "fail" | "skip";
  ms: number;
  reason: string;
  notes: string[];
  calls: { name: string; args: string; ms: number; isError: boolean; timedOut: boolean; out: string }[];
}

export const records: ScenarioRecord[] = [];

class SkipSignal extends Error {}

export class Ctx {
  tabs: number[] = [];
  constructor(
    readonly h: Harness,
    readonly rec: ScenarioRecord,
    private readonly t: TestContext,
    private readonly failures: string[] = []
  ) {}

  /** The same scenario (record + soft-assertion list) driving a second, separately set-up harness. */
  fork(h2: Harness): Ctx {
    return new Ctx(h2, this.rec, this.t, this.failures);
  }

  async call(name: string, args: any = {}, opts: { timeoutMs?: number; allowTimeout?: boolean } = {}): Promise<CallResult> {
    let r: CallResult;
    try {
      r = await this.h.call(name, args, opts);
    } catch (e) {
      if (e instanceof CallTimeoutError) this.log(e.result);
      throw e;
    }
    this.log(r);
    return r;
  }

  private log(r: CallResult) {
    const shown = r.content?.some((c: any) => c.type === "image") ? `${trim(r.text, 200)} [+image]` : trim(r.text, 600);
    this.rec.calls.push({ name: r.name, args: trim(JSON.stringify(r.args), 200), ms: r.ms, isError: r.isError, timedOut: r.timedOut, out: shown });
  }

  /** Open a fixture in a new tab and return its tabId (every scenario works on its own tab). */
  async open(fixture: string): Promise<number> {
    const r = await this.call("tab_new", { url: this.h.fixtureUrl(fixture) });
    const tabId = r.json?.tabId;
    if (typeof tabId !== "number") throw new Error(`tab_new returned no tabId: ${trim(r.text)}`);
    this.tabs.push(tabId);
    return tabId;
  }

  /** eval_js in the tab's top frame; returns the parsed value (eval_js JSON-stringifies objects). */
  async evalJs(tabId: number, code: string, opts: { timeoutMs?: number } = {}): Promise<any> {
    const r = await this.call("eval_js", { code, tabId }, opts);
    if (r.isError) throw new Error(`eval_js failed: ${trim(r.text)}`);
    const v = r.json?.value;
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  async snapshot(tabId: number, opts: { timeoutMs?: number; allowTimeout?: boolean } = {}) {
    const r = await this.call("snapshot", { tabId }, opts);
    const elements: any[] = Array.isArray(r.json?.elements) ? r.json.elements : [];
    return { r, elements, json: r.json };
  }

  note(s: string) {
    this.rec.notes.push(s);
  }

  /** Soft assertion: keeps going so the record lists every broken expectation, fails at the end. */
  expect(cond: unknown, msg: string): boolean {
    if (!cond) this.failures.push(msg);
    return !!cond;
  }

  skip(reason: string): never {
    this.rec.status = "skip";
    this.rec.reason = reason;
    this.t.skip(reason);
    throw new SkipSignal(reason);
  }

  finish() {
    if (this.failures.length) throw new Error(this.failures.join(" | "));
  }

  async cleanup() {
    await this.h.dismissPendingDialogs().catch(() => undefined);
    if (this.tabs.length) {
      await this.h.call("tab_close", { tabIds: this.tabs }, { timeoutMs: 5_000, allowTimeout: true }).catch(() => undefined);
    }
  }
}

export function findEl(elements: any[], pred: (e: any) => boolean): any | undefined {
  return elements.find((e) => {
    try {
      return pred(e);
    } catch {
      return false;
    }
  });
}

export const byLabel = (re: RegExp) => (e: any) => re.test(String(e.label ?? "")) || re.test(String(e.name ?? ""));

export function scenario(getHarness: () => Harness, name: string, fn: (c: Ctx) => Promise<void>, opts: { timeout?: number } = {}) {
  test(name, { timeout: opts.timeout ?? 90_000 }, async (t) => {
    const rec: ScenarioRecord = { name, status: "fail", ms: 0, reason: "scenario timed out (node:test timeout)", notes: [], calls: [] };
    records.push(rec);
    const h = getHarness();
    if (!h) {
      rec.reason = "harness setup failed";
      throw new Error(rec.reason);
    }
    const c = new Ctx(h, rec, t);
    const t0 = Date.now();
    try {
      await fn(c);
      c.finish();
      rec.status = "pass";
      rec.reason = rec.notes[0] ?? "ok";
    } catch (e) {
      if (e instanceof SkipSignal) return;
      rec.status = "fail";
      rec.reason = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      rec.ms = Date.now() - t0;
      await c.cleanup();
    }
  });
}

export function printSummary(): void {
  const rows = records.map((r) => [r.name, r.status.toUpperCase(), String(r.ms), trim(r.reason, 110)]);
  const head = ["scenario", "result", "ms", "reason"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => "| " + cells.map((c, i) => c.padEnd(w[i])).join(" | ") + " |";
  const out = [line(head), "|" + w.map((n) => "-".repeat(n + 2)).join("|") + "|", ...rows.map(line)];
  const pass = records.filter((r) => r.status === "pass").length;
  const fail = records.filter((r) => r.status === "fail").length;
  const skip = records.filter((r) => r.status === "skip").length;
  console.log("\n" + out.join("\n") + `\n\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
  try {
    writeFileSync(join(ARTIFACTS, "results.json"), JSON.stringify(records, null, 2));
    console.log(`[e2e] per-call details: ${join(ARTIFACTS, "results.json")}`);
  } catch {
    /* best-effort */
  }
}
