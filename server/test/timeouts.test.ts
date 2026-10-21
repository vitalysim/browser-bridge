// Tests for the hub-timeout budgets in server/src/timeouts.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inputHubTimeout, SCREENSHOT_HUB_TIMEOUT_MS } from "../src/timeouts.js";

test("input: 45s base for every action", () => {
  assert.equal(inputHubTimeout({ action: "left_click" }), 45_000);
  assert.equal(inputHubTimeout({ action: "key" }), 45_000);
  assert.equal(inputHubTimeout({ action: "type", text: "" }), 45_000);
});

test("input type: budget grows with the text so long typing isn't killed mid-way", () => {
  assert.ok(inputHubTimeout({ action: "type", text: "x".repeat(4000) }) > 45_000 + 4000 * 20);
});

test("screenshot budget is 30s", () => {
  assert.equal(SCREENSHOT_HUB_TIMEOUT_MS, 30_000);
});
