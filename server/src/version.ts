// Version-skew detection between the server and the connected extension. Pure and unit-tested: the
// extension announces its version in the `hello`, and a mismatch is a common, silent cause of "a tool
// exists on one side but not the other" - worth surfacing loudly rather than debugging live.

function parseVer(v?: string): number[] | null {
  if (!v) return null;
  const m = String(v).trim().match(/^\d+(?:\.\d+)*/);
  if (!m) return null;
  return m[0].split(".").map(Number);
}

/** -1 if a < b, 1 if a > b, 0 if equal, null if either is missing/unparseable. */
export function compareVersions(a?: string, b?: string): number | null {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A human-readable warning when the extension and server versions differ, or null when they match
 *  (or a version is unknown). Directional so the fix is obvious from the text alone. */
export function versionSkewWarning(serverVersion?: string, extVersion?: string): string | null {
  const c = compareVersions(extVersion, serverVersion);
  if (c === null || c === 0) return null;
  if (c < 0) return `extension v${extVersion} is older than server v${serverVersion} — reload it at chrome://extensions`;
  return `extension v${extVersion} is newer than server v${serverVersion} — restart the bridge server so it matches`;
}
