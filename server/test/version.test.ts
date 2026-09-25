// Version-skew comparison: the directional warning is what an agent reads to know whether to reload
// the extension or restart the server, so the direction and the "no news when equal" cases matter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, versionSkewWarning } from "../src/version.js";

test("compareVersions orders dotted numeric versions", () => {
  assert.equal(compareVersions("0.16.0", "0.17.0"), -1);
  assert.equal(compareVersions("0.17.0", "0.16.0"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.16.0", "0.16.0"), 0);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1); // numeric, not lexicographic
});

test("compareVersions returns null when a version is missing or unparseable", () => {
  assert.equal(compareVersions(undefined, "0.1.0"), null);
  assert.equal(compareVersions("0.1.0", ""), null);
  assert.equal(compareVersions("abc", "0.1.0"), null);
});

test("versionSkewWarning is null when versions match or are unknown", () => {
  assert.equal(versionSkewWarning("0.16.0", "0.16.0"), null);
  assert.equal(versionSkewWarning("0.16.0", undefined), null);
});

test("versionSkewWarning names the older side and points at the fix", () => {
  const older = versionSkewWarning("0.17.0", "0.16.0");
  assert.match(older ?? "", /extension v0\.16\.0 is older than server v0\.17\.0/);
  assert.match(older ?? "", /chrome:\/\/extensions/);

  const newer = versionSkewWarning("0.16.0", "0.17.0");
  assert.match(newer ?? "", /extension v0\.17\.0 is newer than server v0\.16\.0/);
  assert.match(newer ?? "", /restart the bridge server/);
});
