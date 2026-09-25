// Emulation preset-resolution tests. The mapping (preset name -> concrete metrics / network numbers)
// is the only place a bug is silent - the wrong viewport or throttle just looks like the site behaving
// oddly. Everything here is pure: no browser, no CDP.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDevice,
  resolveNetwork,
  kbpsToBytesPerSec,
  normalizeKey,
  DEVICE_PRESETS,
  NETWORK_PRESETS,
} from "../src/emulate.js";

test("a device preset resolves to its metrics + UA", () => {
  const r = resolveDevice({ preset: "iPhone 15" });
  assert.equal(r.metrics.width, 393);
  assert.equal(r.metrics.height, 852);
  assert.equal(r.metrics.deviceScaleFactor, 3);
  assert.equal(r.metrics.mobile, true);
  assert.equal(r.touch, true, "a mobile preset is touch by default");
  assert.match(r.userAgent ?? "", /iPhone/);
  assert.equal(r.preset, "iphone15");
});

test("preset names are matched loosely (case, spaces, dashes)", () => {
  for (const name of ["Pixel 8", "pixel-8", "PIXEL8", "  pixel 8  "]) {
    assert.equal(resolveDevice({ preset: name }).metrics.width, 412, `matched ${name}`);
  }
});

test("explicit fields override a preset", () => {
  const r = resolveDevice({ preset: "iPhone 15", width: 500, deviceScaleFactor: 1, touch: false });
  assert.equal(r.metrics.width, 500, "explicit width wins");
  assert.equal(r.metrics.height, 852, "unspecified height stays from the preset");
  assert.equal(r.metrics.deviceScaleFactor, 1);
  assert.equal(r.touch, false, "explicit touch:false overrides the mobile default");
});

test("explicit metrics with no preset work, and default DPR/mobile/touch", () => {
  const r = resolveDevice({ width: 800, height: 600 });
  assert.equal(r.metrics.deviceScaleFactor, 1);
  assert.equal(r.metrics.mobile, false);
  assert.equal(r.touch, false, "non-mobile defaults to no touch");
  assert.equal(r.userAgent, undefined);
  assert.equal(r.preset, null);
});

test("touch defaults to the mobile flag when neither preset nor touch is given", () => {
  assert.equal(resolveDevice({ width: 400, height: 800, mobile: true }).touch, true);
  assert.equal(resolveDevice({ width: 400, height: 800, mobile: false }).touch, false);
});

test("device: missing width/height with no preset throws", () => {
  assert.throws(() => resolveDevice({ deviceScaleFactor: 2 }), /width and height/);
  assert.throws(() => resolveDevice({ width: 400 }), /width and height/);
});

test("device: an unknown preset throws and lists known names", () => {
  assert.throws(() => resolveDevice({ preset: "nokia 3310" }), /Unknown device preset/);
});

test("the desktop preset carries no UA override", () => {
  const r = resolveDevice({ preset: "desktop" });
  assert.equal(r.metrics.mobile, false);
  assert.equal(r.userAgent, undefined, "desktop keeps the real UA");
});

test("kbps -> bytes/sec uses 1000 and rounds", () => {
  assert.equal(kbpsToBytesPerSec(1000), 125_000);
  assert.equal(kbpsToBytesPerSec(400), 50_000);
  assert.equal(kbpsToBytesPerSec(1), 125);
});

test("normalizeKey strips case and non-alphanumerics", () => {
  assert.equal(normalizeKey("Slow 3G"), "slow3g");
  assert.equal(normalizeKey("iPhone-15"), "iphone15");
});

test("a network preset resolves to concrete throttle numbers", () => {
  const r = resolveNetwork({ preset: "slow-3g" });
  assert.equal(r.offline, false);
  assert.equal(r.latency, 2000);
  assert.equal(r.downloadThroughput, 50_000);
  assert.equal(r.uploadThroughput, 50_000);
  assert.equal(r.preset, "slow3g");
});

test("the offline preset sets offline true", () => {
  assert.equal(resolveNetwork({ preset: "offline" }).offline, true);
});

test("explicit kbps/latency override a preset and convert units", () => {
  const r = resolveNetwork({ preset: "fast-3g", downloadKbps: 2000, latencyMs: 10 });
  assert.equal(r.downloadThroughput, 250_000, "2000 kbps -> 250000 B/s");
  assert.equal(r.latency, 10);
  assert.equal(r.uploadThroughput, 84_375, "unspecified upload stays from the preset");
});

test("explicit-only network (no preset) starts from unthrottled", () => {
  const r = resolveNetwork({ latencyMs: 100 });
  assert.equal(r.latency, 100);
  assert.equal(r.downloadThroughput, -1, "unthrottled where not specified");
  assert.equal(r.uploadThroughput, -1);
  assert.equal(r.offline, false);
  assert.equal(r.preset, null);
});

test("offline:true alone is a valid network override", () => {
  const r = resolveNetwork({ offline: true });
  assert.equal(r.offline, true);
});

test("network: nothing specified throws", () => {
  assert.throws(() => resolveNetwork({}), /needs a preset or at least one/);
});

test("network: an unknown preset throws", () => {
  assert.throws(() => resolveNetwork({ preset: "5g" }), /Unknown network preset/);
});

test("preset tables are keyed by their own normalized names", () => {
  for (const k of Object.keys(DEVICE_PRESETS)) assert.equal(normalizeKey(k), k, `device key ${k}`);
  for (const k of Object.keys(NETWORK_PRESETS)) assert.equal(normalizeKey(k), k, `network key ${k}`);
});
