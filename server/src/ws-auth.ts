// Mutual challenge-response for the extension WebSocket, so the token never crosses the wire.
//
// Before: the extension opened ws://127.0.0.1:<port>/ws?token=<token> - i.e. it handed the secret to
// whatever process happened to be listening on that port. Any local program squatting 8765 while the
// bridge was down received the token and, with it, full control of the user's logged-in browser.
//
// Now (protocol v2):
//   ext  -> connects to /ws (no token)
//   srv  -> {type:"challenge", v:2, nonce:sNonce}
//   ext  -> {type:"auth", cNonce, mac: HMAC-SHA256(token, "ext|" + sNonce + "|" + cNonce)}
//   srv  -> verifies; {type:"auth-ok", mac: HMAC-SHA256(token, "srv|" + cNonce + "|" + sNonce)}
//   ext  -> verifies the server's mac BEFORE sending hello/outbox or running any command.
// Both sides prove knowledge of the token; neither reveals it; fresh nonces on both sides prevent
// replaying a recorded exchange in either direction. The domain prefixes ("ext"/"srv") stop a
// reflection attack (bouncing the extension's own MAC back as the server's).
import { createHmac, randomBytes, timingSafeEqual, createHash } from "crypto";

export const WS_AUTH_VERSION = 2;
/** The client nonce must be 16..64 bytes, hex-encoded. */
const NONCE_RE = /^[0-9a-f]{32,128}$/;
const MAC_RE = /^[0-9a-f]{64}$/;

export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

export function extMac(token: string, sNonce: string, cNonce: string): string {
  return createHmac("sha256", token).update(`ext|${sNonce}|${cNonce}`).digest("hex");
}

export function srvMac(token: string, cNonce: string, sNonce: string): string {
  return createHmac("sha256", token).update(`srv|${cNonce}|${sNonce}`).digest("hex");
}

/** Constant-time string comparison. Hashing both sides first makes the lengths equal, so neither the
 *  length nor the content of the secret leaks through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Validate the extension's `auth` reply against our challenge. */
export function verifyAuthReply(token: string, sNonce: string, msg: any): { ok: true; cNonce: string } | { ok: false; reason: string } {
  if (!msg || msg.type !== "auth") return { ok: false, reason: "expected an auth message" };
  const cNonce = msg.cNonce;
  const mac = msg.mac;
  if (typeof cNonce !== "string" || !NONCE_RE.test(cNonce)) return { ok: false, reason: "malformed client nonce" };
  if (cNonce === sNonce) return { ok: false, reason: "client nonce equals server nonce" };
  if (typeof mac !== "string" || !MAC_RE.test(mac)) return { ok: false, reason: "malformed mac" };
  const expected = Buffer.from(extMac(token, sNonce, cNonce), "hex");
  if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) return { ok: false, reason: "bad mac (token mismatch)" };
  return { ok: true, cNonce };
}
