// Client half of the v2 WebSocket handshake (server half: server/src/ws-auth.ts).
//
// The token never goes on the wire. The server challenges with a nonce; we answer with
// HMAC-SHA256(token, "ext|" + sNonce + "|" + cNonce) and a fresh nonce of our own; the server must
// answer with HMAC-SHA256(token, "srv|" + cNonce + "|" + sNonce). Until that proof checks out the
// socket is treated as untrusted: no hello, no outbox, no command is executed. A process squatting
// the port while the real server is down learns nothing and can do nothing.

export const WS_AUTH_VERSION = 2;
export const WS_AUTH_FAILED_CLOSE_CODE = 4001;
const NONCE_RE = /^[0-9a-f]{32,128}$/;
const MAC_RE = /^[0-9a-f]{64}$/;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function newNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hmacHex(token: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time over equal-length hex strings (the lengths are fixed by MAC_RE, not secret). */
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** One handshake attempt. Feed it every frame received before authentication. */
export class WsAuthClient {
  readonly cNonce = newNonce();
  private sNonce = "";
  constructor(private token: string) {}

  /**
   * Returns the frame to send (the auth reply), "ok" once the server proved itself, or throws with a
   * reason when the peer misbehaves - the caller then closes the socket without sending anything else.
   */
  async step(msg: any): Promise<string | "ok"> {
    if (msg?.type === "challenge" && !this.sNonce) {
      if (typeof msg.nonce !== "string" || !NONCE_RE.test(msg.nonce) || msg.nonce === this.cNonce) throw new Error("malformed challenge");
      this.sNonce = msg.nonce;
      const mac = await hmacHex(this.token, `ext|${this.sNonce}|${this.cNonce}`);
      return JSON.stringify({ type: "auth", v: WS_AUTH_VERSION, cNonce: this.cNonce, mac });
    }
    if (msg?.type === "auth-ok" && this.sNonce) {
      if (typeof msg.mac !== "string" || !MAC_RE.test(msg.mac)) throw new Error("malformed server proof");
      const expected = await hmacHex(this.token, `srv|${this.cNonce}|${this.sNonce}`);
      if (!equalHex(expected, msg.mac)) throw new Error("server proof does not match the token");
      return "ok";
    }
    throw new Error(`unexpected ${typeof msg?.type === "string" ? msg.type : "frame"} before authentication`);
  }
}
