// MAIN-world watch shim loader: vendor/bb-watch-main.js, registered by watch_start as a content script
// with world:"MAIN", runAt:"document_start", allFrames - so it runs before ANY page script.
//
// Why document_start matters: the relay channel to the isolated watcher is authenticated by a
// per-document secret. If the shim were injected after page scripts ran (as an executeScript func),
// a page that had already patched CustomEvent / dispatchEvent / JSON.stringify / Function.prototype.call
// would see the secret in transit and could then forge timeline lines. Here we capture pristine copies
// first, and receive the secret through a handshake that also completes before page scripts run.
//
// Handshake (fixed event names on `document`, string details; both content scripts run at
// document_start in an unspecified order, and DOM event dispatch is synchronous across worlds):
//   - this script listens for ONE "bb-wm-hello" (detail = secret), then dispatches "bb-wm-ask";
//   - the isolated watcher dispatches "bb-wm-hello" on start; if nobody acked it synchronously it
//     answers ONE "bb-wm-ask" with another hello;
//   - whoever receives the hello dispatches "bb-wm-ack"; every fixed-name listener is removed after
//     its single use. Page scripts start only after both scripts ran, by which point no listener that
//     would reveal or accept a secret is left on a fixed name.
// After pairing, the watcher arms this shim through an event whose NAME contains the secret.
import { bbWatchMainShim, type WatchMainPristine } from "./watch-main-shim";

(() => {
  const P: WatchMainPristine = {
    Ev: CustomEvent,
    dispatch: EventTarget.prototype.dispatchEvent,
    apply: Reflect.apply,
    stringify: JSON.stringify,
    create: Object.create,
    defineProperty: Object.defineProperty,
    win: window,
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const doc = document;
  const fire = (type: string, detail: string) => {
    P.apply(P.dispatch, doc, [new P.Ev(type, { bubbles: false, cancelable: false, composed: false, detail })]);
  };

  let nonce: string | null = null;
  const onHello = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (nonce !== null || typeof d !== "string" || d.length < 16) return;
    nonce = d;
    P.apply(remove, doc, ["bb-wm-hello", onHello]);
    fire("bb-wm-ack", "");
    // Armed later by the isolated watcher, on a name only it and we know.
    const onArm = (ev: Event) => {
      const mode = (ev as CustomEvent).detail;
      try {
        bbWatchMainShim(typeof mode === "string" ? mode : "passive", nonce!, P);
      } catch {
        /* never break the page */
      }
    };
    P.apply(add, doc, ["bb-wm-arm:" + nonce, onArm]);
  };
  P.apply(add, doc, ["bb-wm-hello", onHello]);
  fire("bb-wm-ask", "");
  // If the watcher has not run yet, its own start-up hello will reach onHello (still registered).
})();
