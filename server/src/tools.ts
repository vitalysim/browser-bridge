import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, readFileSync, renameSync, copyFileSync, unlinkSync, mkdirSync } from "fs";
import { writeFile as writeFileAsync } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ExtensionHub } from "./hub.js";
import { CaptureSink } from "./capture-sink.js";
import { inlineAssets } from "./rrweb-inline.js";

const MAX_TEXT_CHARS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Expand a leading ~/ to the home dir (Node fs doesn't do it). For playbook/record paths.
const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// Parse pixel dimensions from a PNG or JPEG buffer (header only).
function imageDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; // PNG IHDR
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = buf[o + 1];
      if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}

function textResult(value: unknown) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + `\n…[truncated at ${MAX_TEXT_CHARS} chars]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

const tabIdParam = z
  .number()
  .optional()
  .describe("Target tab id (from tabs_list). Defaults to the active tab.");

const withSnapshotParam = z
  .boolean()
  .optional()
  .describe("Also return a fresh shallow snapshot (as `snapshot`) after the action, to skip a separate follow-up snapshot call.");

const timeoutMsParam = z
  .number()
  .optional()
  .describe("Max ms to auto-wait for the element to become actionable (found + visible + enabled). Default 5000. On failure the result is {notActionable, reason: 'not-found-after…'|'hidden'|'disabled'|'covered'}.");

export function registerTools(server: McpServer, hub: ExtensionHub, version = "0.0.0") {
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: (args: any) => Promise<any>
  ) => {
    server.registerTool(name, { description, inputSchema }, async (args: any) => {
      try {
        return await handler(args);
      } catch (err) {
        return errorResult(err);
      }
    });
  };

  tool(
    "tabs_list",
    "List all open browser tabs with their id, title, url, and active state. Use short:true for a compact form (id, title, origin, active - no path/query) when you only need to identify tabs, e.g. by site.",
    {
      short: z
        .boolean()
        .optional()
        .describe("Return id, title, origin (scheme+host only), and active - omitting the full url's path/query, which can carry long opaque ids."),
    },
    async ({ short }) => textResult(await hub.call("tabs_list", { short }))
  );

  tool(
    "tab_new",
    "Open a new browser tab. Returns the new tab's id once the page finishes loading.",
    { url: z.string().describe("URL to open") },
    async ({ url }) => textResult(await hub.call("tab_new", { url }))
  );

  tool(
    "tab_activate",
    "Bring a tab to the foreground (focuses its window too).",
    { tabId: z.number().describe("Tab id from tabs_list") },
    async ({ tabId }) => textResult(await hub.call("tab_activate", { tabId }))
  );

  tool(
    "tab_close",
    "Close one or more tabs by id (from tabs_list). Pass tabId for a single tab or tabIds for several.",
    {
      tabId: z.number().optional().describe("Single tab id to close"),
      tabIds: z.array(z.number()).optional().describe("Multiple tab ids to close"),
    },
    async ({ tabId, tabIds }) => {
      const ids = [...(tabIds ?? []), ...(tabId !== undefined ? [tabId] : [])];
      if (ids.length === 0) throw new Error("Provide tabId or tabIds");
      return textResult(await hub.call("tab_close", { tabIds: ids }));
    }
  );

  tool(
    "navigate",
    "Navigate a tab to a URL and wait for the page to finish loading.",
    { url: z.string().describe("URL to navigate to"), tabId: tabIdParam },
    async ({ url, tabId }) => textResult(await hub.call("navigate", { url, tabId }))
  );

  tool(
    "get_page_text",
    "Get the visible text content of a page (title, url, and rendered body text). The primary tool for reading " +
      "pages, e.g. summarizing a feed. Reads `innerText` (rendered text) by default, which OMITS `display:none` / " +
      "collapsed content (e.g. un-expanded accordion bodies). Set includeHidden:true to read `textContent` instead, " +
      "capturing hidden-but-present DOM (loses some block line breaks). Truly virtualized/unmounted content still " +
      "needs a scroll/expand first.",
    { tabId: tabIdParam, includeHidden: z.boolean().optional().describe("Include display:none/collapsed text via textContent (default false = rendered innerText only)") },
    async ({ tabId, includeHidden }) => textResult(await hub.call("get_page_text", { tabId, includeHidden }))
  );

  tool(
    "snapshot",
    "List the interactive elements on the page (links, buttons, inputs), including inside iframes " +
      "and open shadow DOM. Each element gets a numeric ref usable with click/fill/hover/type " +
      "(pass ref as a number, or use a CSS selector instead). Set deep:true to also reach CLOSED " +
      "shadow roots via the debugger (shows the debugging banner; refs from a deep snapshot must be " +
      "used with trusted:true actions).",
    { tabId: tabIdParam, deep: z.boolean().optional().describe("Pierce closed shadow roots via chrome.debugger (shows banner)") },
    async ({ tabId, deep }) => textResult(await hub.call("snapshot", { tabId, deep }))
  );

  tool(
    "click",
    "Click an element, identified by a ref from snapshot or a CSS selector. Auto-waits for the element to be " +
      "actionable (found + visible + enabled, default 5s). If the element is covered by an overlay it " +
      "auto-escalates to a real trusted CDP click (via:'trusted', shows the banner) unless autoTrusted:false / " +
      "noEscalate:true. Set trusted:true to force the trusted path (also required for deep-snapshot refs). " +
      "Result reports via:'synthetic'|'trusted', or {notActionable, reason} on failure.",
    {
      ref: z.number().optional().describe("Element ref from a prior snapshot call"),
      selector: z.string().optional().describe("CSS selector (alternative to ref)"),
      trusted: z.boolean().optional().describe("Force a real trusted click via chrome.debugger (shows banner)"),
      autoTrusted: z.boolean().optional().describe("Escalate to a trusted click when the target is covered (default true)"),
      noEscalate: z.boolean().optional().describe("Never auto-escalate to trusted; report {notActionable} instead"),
      timeoutMs: timeoutMsParam,
      withSnapshot: withSnapshotParam,
      tabId: tabIdParam,
    },
    async ({ ref, selector, trusted, autoTrusted, noEscalate, timeoutMs, withSnapshot, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      return textResult(await hub.call("click", { ref, selector, trusted, autoTrusted, noEscalate, timeoutMs, withSnapshot, tabId }));
    }
  );

  tool(
    "fill",
    "Fill a text input, textarea, select, or contenteditable element with a value. Auto-waits for the element " +
      "to be actionable (default 5s). Uses React's native value setter (+ input/change) for inputs, and " +
      "execCommand('insertText') for contenteditable/rich editors (ProseMirror/Quill/CodeMirror) so the value " +
      "registers. Returns {filled, via?} or {notActionable, reason}.",
    {
      value: z.string().describe("Text value to set"),
      ref: z.number().optional().describe("Element ref from a prior snapshot call"),
      selector: z.string().optional().describe("CSS selector (alternative to ref)"),
      timeoutMs: timeoutMsParam,
      withSnapshot: withSnapshotParam,
      tabId: tabIdParam,
    },
    async ({ value, ref, selector, timeoutMs, withSnapshot, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      return textResult(await hub.call("fill", { value, ref, selector, timeoutMs, withSnapshot, tabId }));
    }
  );

  tool(
    "hover",
    "Hover an element (dispatches pointerover/mouseover/mouseenter/mousemove) to reveal " +
      "hover-triggered menus. Identify it by ref from snapshot or a CSS selector. Set trusted:true " +
      "for a real cursor move via the debugger (shows banner) that also triggers pure-CSS :hover styling.",
    {
      ref: z.number().optional().describe("Element ref from a prior snapshot call"),
      selector: z.string().optional().describe("CSS selector (alternative to ref)"),
      trusted: z.boolean().optional().describe("Use a real trusted mouse move via chrome.debugger (fires CSS :hover; shows banner)"),
      timeoutMs: timeoutMsParam,
      withSnapshot: withSnapshotParam,
      tabId: tabIdParam,
    },
    async ({ ref, selector, trusted, timeoutMs, withSnapshot, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      return textResult(await hub.call("hover", { ref, selector, trusted, timeoutMs, withSnapshot, tabId }));
    }
  );

  tool(
    "type",
    "Type text character-by-character into an element (dispatches real keydown/keypress/input/keyup " +
      "per character), for autocomplete/typeahead fields that ignore fill's single-shot value set. " +
      "Identify it by ref from snapshot or a CSS selector. Set trusted:true for real (isTrusted) " +
      "keystrokes with real timing via the debugger (shows banner).",
    {
      text: z.string().describe("Text to type"),
      ref: z.number().optional().describe("Element ref from a prior snapshot call"),
      selector: z.string().optional().describe("CSS selector (alternative to ref)"),
      trusted: z.boolean().optional().describe("Use real trusted keystrokes via chrome.debugger (shows banner)"),
      timeoutMs: timeoutMsParam,
      withSnapshot: withSnapshotParam,
      tabId: tabIdParam,
    },
    async ({ text, ref, selector, trusted, timeoutMs, withSnapshot, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      return textResult(await hub.call("type", { text, ref, selector, trusted, timeoutMs, withSnapshot, tabId }));
    }
  );

  tool(
    "press_key",
    "Send a keyboard key (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown') to the focused element. " +
      "Note: events are synthetic; some sites ignore them.",
    { key: z.string().describe("Key value, e.g. 'Enter'"), withSnapshot: withSnapshotParam, tabId: tabIdParam },
    async ({ key, withSnapshot, tabId }) => textResult(await hub.call("press_key", { key, withSnapshot, tabId }))
  );

  tool(
    "input",
    "Raw COORDINATE-level trusted input via CDP Input - for targets the element-based click/fill/type can't reach: " +
      "a <canvas> remote desktop (VNC/RDP/Amazon DCV), a game, a WebGL/drawing app. Coordinates are CSS VIEWPORT " +
      "pixels (top-left origin); since screenshots are DEVICE pixels, map them with the dpr the screenshot tool " +
      "returns: inputCoord = screenshotPixel / dpr. Trusted (isTrusted) events via chrome.debugger, so it shows the " +
      "banner. Actions: mouse_move · left_click/right_click/middle_click · double_click · left_mouse_down/left_mouse_up " +
      "(held drags) · left_click_drag (x,y → x2,y2) · scroll (dx/dy at x,y) · type (per-char keystrokes to the FOCUSED " +
      "element - click the field/canvas first) · key (a key or combo like 'Enter', 'Escape', 'ctrl+c', 'ctrl+shift+k'). " +
      "NOTE: input is delivered even when the tab is backgrounded, but its frame is throttled then so you can't OBSERVE " +
      "the result - use activate:true (or tab_activate) to foreground it. For ordinary DOM, prefer click/fill/type.",
    {
      action: z
        .enum(["mouse_move", "left_click", "right_click", "middle_click", "double_click", "left_mouse_down", "left_mouse_up", "left_click_drag", "scroll", "type", "key"])
        .describe("The input action"),
      x: z.number().optional().describe("X in CSS viewport pixels (required for mouse actions)"),
      y: z.number().optional().describe("Y in CSS viewport pixels (required for mouse actions)"),
      x2: z.number().optional().describe("Drag end X (left_click_drag)"),
      y2: z.number().optional().describe("Drag end Y (left_click_drag)"),
      dx: z.number().optional().describe("Horizontal wheel delta (scroll)"),
      dy: z.number().optional().describe("Vertical wheel delta (scroll; negative = up)"),
      text: z.string().optional().describe("Text to type char-by-char into the focused element (action:type)"),
      key: z.string().optional().describe("Key or combo (action:key), e.g. 'Enter', 'Escape', 'ArrowUp', 'ctrl+c'"),
      code: z.string().optional().describe("Explicit CDP key code escape hatch, e.g. 'KeyC' (with action:key)"),
      keyCode: z.number().optional().describe("Explicit Windows virtual key code escape hatch (with action:key)"),
      clickCount: z.number().optional().describe("Click count for a click action (default 1)"),
      activate: z.boolean().optional().describe("Foreground the tab first so you can observe the result (default false)"),
      tabId: tabIdParam,
    },
    async (args) => {
      if (["mouse_move", "left_click", "right_click", "middle_click", "double_click", "left_mouse_down", "left_mouse_up", "scroll", "left_click_drag"].includes(args.action) && (args.x === undefined || args.y === undefined))
        throw new Error(`input action '${args.action}' requires x and y (CSS viewport pixels)`);
      if (args.action === "type" && args.text === undefined) throw new Error("input action 'type' requires text");
      if (args.action === "key" && !args.key && !args.code) throw new Error("input action 'key' requires key or code");
      return textResult(await hub.call("input", args, 120_000));
    }
  );

  tool(
    "go_back",
    "Navigate the tab back in its history (like the browser Back button).",
    { tabId: tabIdParam },
    async ({ tabId }) => textResult(await hub.call("go_back", { tabId }))
  );

  tool(
    "go_forward",
    "Navigate the tab forward in its history (like the browser Forward button).",
    { tabId: tabIdParam },
    async ({ tabId }) => textResult(await hub.call("go_forward", { tabId }))
  );

  tool(
    "file_upload",
    "Set a file on an <input type=file> element, identified by ref or CSS selector. Provide EITHER " +
      "base64 (contents, keep under ~5 MB; banner-free) OR path (an absolute local file path Chrome " +
      "can read; uses the debugger's DOM.setFileInputFiles - most reliable, no size limit, shows banner).",
    {
      base64: z.string().optional().describe("File contents, base64-encoded (banner-free path)"),
      filename: z.string().optional().describe("File name to present to the page (with base64)"),
      path: z.string().optional().describe("Absolute local file path (uses chrome.debugger; shows banner)"),
      mimeType: z.string().optional().describe("MIME type, e.g. 'image/png'. Defaults to application/octet-stream."),
      ref: z.number().optional().describe("Element ref from a prior snapshot call"),
      selector: z.string().optional().describe("CSS selector (alternative to ref)"),
      tabId: tabIdParam,
    },
    async ({ base64, filename, path, mimeType, ref, selector, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      if (!base64 && !path) throw new Error("Provide either base64 (contents) or path (local file path)");
      return textResult(await hub.call("file_upload", { base64, filename, path, mimeType, ref, selector, tabId }));
    }
  );

  tool(
    "paste_image",
    "Paste a LOCAL IMAGE into a rich-text / contenteditable field that accepts pasted images (comment " +
      "boxes, compose editors, etc.). For an <input type=file> use file_upload instead. Target by ref or " +
      "CSS selector; give the image as base64 or an absolute local path. Banner-free (synthetic events); " +
      "method 'paste' (default), 'drop', or 'both' - some editors accept one but not the other. Set " +
      "trusted:true for STRICT editors that ignore synthetic events (e.g. YesWeHack): puts the image on the " +
      "real OS clipboard and sends a genuine Cmd/Ctrl+V via chrome.debugger (shows the banner; needs the " +
      "Chrome window focused/frontmost).",
    {
      base64: z.string().optional().describe("Image contents, base64-encoded"),
      path: z.string().optional().describe("Absolute local image path (read by the server)"),
      mimeType: z.string().optional().describe("e.g. image/png (inferred from a path's extension if omitted)"),
      method: z.enum(["paste", "drop", "both"]).optional().describe("Synthetic delivery: paste (default), drop, or both"),
      trusted: z.boolean().optional().describe("Real clipboard + trusted Cmd/Ctrl+V via chrome.debugger (for strict editors; shows banner)"),
      ref: z.number().optional().describe("Element ref from a prior snapshot call"),
      selector: z.string().optional().describe("CSS selector (alternative to ref)"),
      tabId: tabIdParam,
    },
    async ({ base64, path, mimeType, method, trusted, ref, selector, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      let b64 = base64;
      let mt = mimeType;
      if (path) {
        const buf = readFileSync(path);
        if (buf.length > 10 * 1024 * 1024) throw new Error("Image too large (>10 MB)");
        b64 = buf.toString("base64");
        if (!mt) {
          const ext = (path.toLowerCase().split(".").pop() || "");
          mt = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" } as Record<string, string>)[ext] || "application/octet-stream";
        }
      }
      if (!b64) throw new Error("Provide either base64 (image contents) or path (local image file)");
      return textResult(await hub.call("paste_image", { base64: b64, mimeType: mt ?? "image/png", method, trusted, ref, selector, tabId }, 45_000));
    }
  );

  tool(
    "scroll",
    "Scroll the page by a pixel delta, or scroll an element into view via selector.",
    {
      dy: z.number().optional().describe("Vertical pixels to scroll (positive = down). Default 600."),
      selector: z.string().optional().describe("If set, scroll this element into view instead"),
      withSnapshot: withSnapshotParam,
      tabId: tabIdParam,
    },
    async ({ dy, selector, withSnapshot, tabId }) => textResult(await hub.call("scroll", { dy, selector, withSnapshot, tabId }))
  );

  tool(
    "screenshot",
    "Screenshot a tab. Default: banner-free visible-viewport PNG. Options (these use chrome.debugger, " +
      "showing the banner): fullPage:true captures the ENTIRE scrollable page; scale (e.g. 2) renders at " +
      "high DPI/retina; format 'jpeg'+quality for smaller files; selector clips to one element; savePath " +
      "writes the image to that absolute path and returns metadata instead of the (possibly large) inline image.",
    {
      tabId: tabIdParam,
      fullPage: z.boolean().optional().describe("Capture the entire scrollable page (chrome.debugger)"),
      scale: z.number().optional().describe("Device scale factor, e.g. 2 for retina-crisp output"),
      format: z.enum(["png", "jpeg"]).optional().describe("Image format (default png)"),
      quality: z.number().optional().describe("JPEG quality 0-100 (default 90)"),
      selector: z.string().optional().describe("Clip to this CSS element instead of the page/viewport"),
      savePath: z.string().optional().describe("Absolute path to write the image to (returns metadata, not the image)"),
    },
    async ({ tabId, fullPage, scale, format, quality, selector, savePath }) => {
      const r = await hub.call("screenshot", { tabId, fullPage, scale, format, quality, selector }, 120_000);
      const buf = Buffer.from(r.base64, "base64");
      const dims = imageDims(buf);
      const mimeType = r.format === "jpeg" ? ("image/jpeg" as const) : ("image/png" as const);
      // Viewport/visibility metadata: dpr maps screenshot device-pixels → CSS input coords
      // (inputCoord = screenshotPixel / dpr); visibilityState + warning flag a throttled/stale frame.
      const view = { dpr: r.dpr, cssWidth: r.cssWidth, cssHeight: r.cssHeight, visibilityState: r.visibilityState, hidden: r.hidden, hasFocus: r.hasFocus };
      if (savePath) {
        writeFileSync(savePath, buf);
        return textResult({ path: savePath, bytes: buf.length, width: dims?.width, height: dims?.height, format: r.format, ...view, warning: r.warning });
      }
      const meta =
        `${dims?.width ?? "?"}×${dims?.height ?? "?"} ${r.format}, ${buf.length} bytes` +
        (r.dpr ? ` · dpr ${r.dpr} · css ${r.cssWidth}×${r.cssHeight} · ${r.visibilityState}` : "") +
        (r.warning ? `\n⚠ ${r.warning}` : "");
      return {
        content: [
          { type: "image" as const, data: r.base64, mimeType },
          { type: "text" as const, text: meta },
        ],
      };
    }
  );

  tool(
    "download_resource",
    "Download a resource (URL) to disk using Chrome's own download engine - reliably handles files " +
      "up to 100MB and well beyond (pass a larger maxBytes, or omit it, for bigger files), with correct " +
      "binary handling and the real browser session's cookies sent automatically. Banner-free (no " +
      "chrome.debugger involved). Cookie/Host/Origin/Referer/Content-Length headers are browser-forbidden " +
      "and ignored; Authorization works for token-gated downloads. Always uses the live browser session - " +
      "can't be pointed at a captured identity's snapshotted cookies.",
    {
      url: z.string().describe("URL of the resource to download"),
      savePath: z.string().optional().describe("Absolute destination path; if omitted, the file stays wherever Chrome's Downloads folder puts it"),
      filename: z.string().optional().describe("Initial relative filename/subpath within Chrome's Downloads directory"),
      headers: z.record(z.string()).optional().describe("Extra request headers, e.g. Authorization"),
      maxBytes: z.number().optional().describe("Cancel the download if size exceeds this (bytes). Default 100 MB; pass a bigger value or omit for unlimited."),
      timeoutMs: z.number().optional().describe("Max time to wait for completion (default 600000 = 10 min; large/slow downloads may need more)"),
    },
    async ({ url, savePath, filename, headers, maxBytes, timeoutMs }) => {
      const start = await hub.call("download_resource", { url, filename, headers }, 20_000);
      const cap = maxBytes ?? 100 * 1024 * 1024;
      const overallTimeout = timeoutMs ?? 600_000;
      const deadline = Date.now() + overallTimeout;
      let status: any;
      while (true) {
        status = await hub.call("download_status", { downloadId: start.downloadId }, 10_000);
        if (status.state === "complete") break;
        if (status.state === "interrupted") throw new Error(`Download interrupted: ${status.error ?? "unknown reason"}`);
        const seen = status.totalBytes > 0 ? status.totalBytes : status.bytesReceived;
        if (cap && seen > cap) {
          await hub.call("download_cancel", { downloadId: start.downloadId }, 10_000).catch(() => {});
          throw new Error(`Download exceeded maxBytes (${cap}); cancelled after ~${status.bytesReceived} bytes.`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${overallTimeout}ms waiting for download to complete (downloadId ${start.downloadId} may still be running - check chrome://downloads or retry).`
          );
        }
        await sleep(750);
      }
      let outPath = status.filename;
      if (savePath && savePath !== status.filename) {
        try {
          renameSync(status.filename, savePath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EXDEV") {
            copyFileSync(status.filename, savePath);
            unlinkSync(status.filename);
          } else throw e;
        }
        outPath = savePath;
      }
      return textResult({ path: outPath, bytes: status.fileSize ?? status.bytesReceived, mimeType: status.mime, url });
    }
  );

  tool(
    "eval_js",
    "Evaluate JavaScript in the page's main world and return its JSON-serialized result. Banner-free by " +
      "default (injected eval). On strict-CSP pages that forbid `unsafe-eval`, it **auto-falls back to CDP " +
      "`Runtime.evaluate`** (see cdp_eval), which bypasses the CSP but shows the debugger banner - the result " +
      "then includes `via:\"cdp-fallback\"`. Set `noFallback:true` to fail instead, or `cdp:true` to skip " +
      "straight to the CDP path. Use `awaitPromise:false` if you don't want to await a returned Promise.",
    {
      code: z.string().describe("JavaScript to evaluate (expression or statements)"),
      cdp: z.boolean().optional().describe("Force the CDP Runtime.evaluate path (bypasses CSP; shows the banner)"),
      noFallback: z.boolean().optional().describe("Do not fall back to CDP if the page CSP blocks in-page eval"),
      awaitPromise: z.boolean().optional().describe("Await a returned Promise (default true)"),
      timeoutMs: z.number().optional().describe("Max time to wait for the result (default 30000). Raise it if the code awaits/polls for longer than 30s."),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("eval_js", args, args.timeoutMs ?? 30_000))
  );

  tool(
    "cdp_eval",
    "Evaluate JavaScript in the page's real main-world context via CDP `Runtime.evaluate` - the DevTools-" +
      "console path, which **is not subject to the page's CSP `unsafe-eval`**, so it runs arbitrary code on " +
      "strict-CSP sites (Copilot, HackerOne, YesWeHack…) where `eval_js` is blocked. Unlike the isolated-world " +
      "read/interact tools, this reaches the page's live JS: in-memory state, framework internals, closures, and " +
      "the app's own functions. Uses `chrome.debugger`, so it **shows the debugging banner** (auto-detaches when " +
      "idle). `eval_js` already auto-falls back to this on CSP-blocked pages; call `cdp_eval` directly when you " +
      "want the CDP path unconditionally.",
    {
      code: z.string().describe("JavaScript to evaluate (expression or statements) in the page's main world"),
      awaitPromise: z.boolean().optional().describe("Await a returned Promise (default true)"),
      timeoutMs: z.number().optional().describe("Max time to wait for the result (default 30000). Raise it for a long await/poll inside the evaluated code (the fixed 30s cap otherwise kills it)."),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("cdp_eval", args, args.timeoutMs ?? 30_000))
  );

  tool(
    "wait_for",
    "Wait until a CSS selector appears on the page, or just sleep for a duration.",
    {
      selector: z.string().optional().describe("CSS selector to wait for"),
      timeoutMs: z.number().optional().describe("Max wait in ms (default 10000)"),
      tabId: tabIdParam,
    },
    async ({ selector, timeoutMs, tabId }) =>
      textResult(await hub.call("wait_for", { selector, timeoutMs, tabId }, (timeoutMs ?? 10_000) + 5_000))
  );

  // ---- chrome.debugger (CDP) mode: network capture. Attaching shows Chrome's
  // "started debugging this browser" banner and conflicts with open DevTools on that tab. ----

  tool(
    "net_capture_start",
    "Start capturing network traffic on a tab via chrome.debugger (shows the debugging banner). Then " +
      "navigate/reload the tab to capture its load traffic, and read it with net_get_requests. The in-memory " +
      "buffer is a ring capped at maxEntries (default 500). Set persist:true + savePath to ALSO stream each " +
      "finished request and WebSocket frame to a JSON-Lines file on disk - a DURABLE record that survives the " +
      "ring cap and (up to the last ~300ms batch) a service-worker crash. NOTE: persistence is durability, NOT " +
      "continuity - if the SW dies the debugger detaches and capture stops until you restart it; the file keeps " +
      "what was captured before that. persistBodies:true also writes response bodies (heavier).",
    {
      urlFilter: z.string().optional().describe("Only buffer requests whose URL contains this substring"),
      persist: z.boolean().optional().describe("Also stream finished requests/frames to savePath as JSON Lines (durable, survives ring cap + SW crash)"),
      savePath: z.string().optional().describe("Absolute path for the persist JSONL file (required when persist:true)"),
      persistBodies: z.boolean().optional().describe("Include response bodies in the persisted stream (heavier; fetched eagerly at load-finish)"),
      maxEntries: z.number().optional().describe("In-memory ring cap for requests (default 500, max 5000)"),
      tabId: tabIdParam,
    },
    async ({ urlFilter, persist, savePath, persistBodies, maxEntries, tabId }) => {
      if (!persist) {
        return textResult(await hub.call("net_capture_start", { urlFilter, maxEntries, tabId }));
      }
      if (!savePath) throw new Error("persist:true requires savePath");
      if (hub.captureSinkPathInUse(savePath)) throw new Error(`another active capture is already writing ${savePath}`);
      const sink = new CaptureSink(savePath); // opens the file now → a bad path fails THIS call, not mid-stream
      try {
        const r = await hub.call("net_capture_start", { urlFilter, persist: true, persistBodies: !!persistBodies, maxEntries, tabId });
        if (r?.tabId == null) throw new Error("extension did not return the captured tabId");
        hub.registerCaptureSink(r.tabId, sink);
        return textResult({ ...r, persist: true, savePath });
      } catch (e) {
        sink.close();
        throw e;
      }
    },
  );

  tool(
    "net_get_requests",
    "Return captured network requests (method, url, status, headers, timing). Set includeBodies:true " +
      "to also fetch response bodies (size-capped). Filter by urlFilter substring.",
    {
      urlFilter: z.string().optional().describe("Only return requests whose URL contains this substring"),
      includeBodies: z.boolean().optional().describe("Also fetch response bodies (slower, size-capped)"),
      limit: z.number().optional().describe("Max requests to return (default 100, newest kept)"),
      tabId: tabIdParam,
    },
    async ({ urlFilter, includeBodies, limit, tabId }) =>
      textResult(await hub.call("net_get_requests", { urlFilter, includeBodies, limit, tabId }, 60_000)),
  );

  tool(
    "net_get_body",
    "Fetch a single captured response body by requestId (from net_get_requests).",
    { requestId: z.string().describe("requestId from net_get_requests"), tabId: tabIdParam },
    async ({ requestId, tabId }) => textResult(await hub.call("net_get_body", { requestId, tabId })),
  );

  tool(
    "debugger_detach",
    "Detach the debugger from a tab (removes the debugging banner) and clears its capture buffer.",
    { tabId: tabIdParam },
    async ({ tabId }) => textResult(await hub.call("debugger_detach", { tabId })),
  );

  tool(
    "debugger_status",
    "Report debugger sessions: whether a tab is attached/capturing, buffered request count, idle time. " +
      "Omit tabId to list all sessions.",
    { tabId: z.number().optional().describe("Tab id; omit to list all sessions") },
    async ({ tabId }) => textResult(await hub.call("debugger_status", { tabId })),
  );

  // ---- web-security capabilities: WS frames, identities, in-session replay, authz diffing ----

  tool(
    "net_get_ws_frames",
    "Return captured WebSocket / EventSource frames (dir, opcode, payload) from the active capture. " +
      "Requires net_capture_start first.",
    {
      urlFilter: z.string().optional().describe("Only frames whose socket URL contains this substring"),
      limit: z.number().optional().describe("Max frames (default 200, newest kept)"),
      tabId: tabIdParam,
    },
    async ({ urlFilter, limit, tabId }) => textResult(await hub.call("net_get_ws_frames", { urlFilter, limit, tabId })),
  );

  tool(
    "identity_capture",
    "Snapshot the current tab's session as a named identity: cookies (incl. HttpOnly, via the debugger), " +
      "local/sessionStorage, and any Authorization bearer seen in the capture buffer. Log in as the account " +
      "first, then capture. Use the names with replay_request/authz_matrix. Shows the debugging banner.",
    {
      name: z.string().describe("Identity name, e.g. 'A', 'B', or 'admin'"),
      domain: z.string().optional().describe("Only keep cookies for this domain (e.g. 'example.com')"),
      tabId: tabIdParam,
    },
    async ({ name, domain, tabId }) => textResult(await hub.call("identity_capture", { name, domain, tabId })),
  );

  tool(
    "identity_list",
    "List captured identities (name, cookie count, whether a bearer was captured).",
    {},
    async () => textResult(await hub.call("identity_list", {})),
  );

  tool(
    "identity_purge",
    "Delete a captured identity from memory.",
    { name: z.string().describe("Identity name to remove") },
    async ({ name }) => textResult(await hub.call("identity_purge", { name })),
  );

  tool(
    "replay_request",
    "Re-issue a request from the tab's live session (an in-session Repeater). Give a requestId (from " +
      "net_get_requests) or an ad-hoc {url,method,headers,body}; optional overrides {url,method,headers,body}. " +
      "Set identity to send as a captured identity or 'anon' (strips cookies/bearer) - this uses the CDP Fetch " +
      "path to override forbidden headers like Cookie. Returns {status,headers,body}. Shows the banner when identity/forbidden headers are used.",
    {
      requestId: z.string().optional().describe("requestId from net_get_requests to replay"),
      url: z.string().optional().describe("Ad-hoc request URL (if no requestId)"),
      method: z.string().optional().describe("HTTP method (default GET)"),
      headers: z.record(z.string()).optional().describe("Ad-hoc request headers"),
      body: z.string().optional().describe("Request body"),
      overrides: z
        .object({ url: z.string().optional(), method: z.string().optional(), headers: z.record(z.string()).optional(), body: z.string().optional() })
        .optional()
        .describe("Fields to override on the base request"),
      identity: z.string().optional().describe("Send as this captured identity, or 'anon'"),
      viaAppClient: z.boolean().optional().describe("Replay through the PAGE'S OWN fetch (main world) so the app's CSRF tokens, auth interceptors, and service worker apply (practically same-origin; result via:'app-fetch'). Default uses the banner-free background fetch."),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("replay_request", args, 45_000)),
  );

  tool(
    "authz_matrix",
    "Access-control (BOLA/IDOR/BFLA) oracle: replay each captured request under each identity and diff the " +
      "responses. Flags when a non-baseline identity (or 'anon') reaches the same resource as the baseline. " +
      "Set mutateIds:true to also probe an id+1 neighbor. Shows the banner.",
    {
      requestIds: z.array(z.string()).describe("requestIds (from net_get_requests) to test"),
      identities: z.array(z.string()).describe("Identity names to replay as; first is the baseline. Include 'anon' to test unauthenticated."),
      mutateIds: z.boolean().optional().describe("Also replay an id+1 neighbor of each request"),
      tabId: tabIdParam,
    },
    async ({ requestIds, identities, mutateIds, tabId }) => {
      const res = await hub.call("authz_matrix", { requestIds, identities, mutateIds, tabId }, 90_000);
      // annotate cells with response_diff vs the baseline identity + access-control flags
      for (const row of res.rows ?? []) {
        const base = row.cells?.[0];
        for (const cell of row.cells ?? []) {
          if (!base || cell === base || cell.error) continue;
          cell.diff = responseDiff(base, cell);
          if (cell.status && cell.status < 400 && cell.diff.similarity > 0.6)
            cell.flag = "ACCESS-CONTROL: reached the same resource as the baseline identity";
          else if (cell.identity === "anon" && cell.status && cell.status < 400) cell.flag = "BROKEN-AUTH: anonymous access succeeded";
        }
      }
      return textResult(res);
    },
  );

  tool(
    "response_diff",
    "Structurally diff two responses (status equality, length delta, token-Jaccard similarity with " +
      "nonce/CSRF/timestamp noise suppressed). Pass a and b as {status, body}.",
    {
      a: z.object({ status: z.number().optional(), body: z.string().optional() }).describe("Baseline response"),
      b: z.object({ status: z.number().optional(), body: z.string().optional() }).describe("Comparison response"),
    },
    async ({ a, b }) => textResult(responseDiff(a as any, b as any)),
  );

  // ---- intercept (live request/response tampering via CDP Fetch) ----
  const interceptSet = z
    .object({
      url: z.string().optional(),
      method: z.string().optional(),
      headers: z.record(z.string()).optional(),
      postData: z.string().optional(),
      errorReason: z.string().optional(),
    })
    .optional();
  const interceptResponse = z
    .object({
      status: z.number().optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      bodyIsBase64: z.boolean().optional(),
    })
    .optional();

  tool(
    "intercept_start",
    "Begin live request/response interception on the tab (Burp-Proxy style, via CDP Fetch - shows the debugger " +
      "banner). Matching requests pause; a paused request that matches a `rules` entry is auto-resolved, otherwise " +
      "it queues for intercept_pending/intercept_resolve. WARNING: a paused request blocks the page until resolved.",
    {
      patterns: z
        .array(z.any())
        .optional()
        .describe("CDP Fetch patterns, e.g. [{urlPattern:'*://api.example.com/*'}]; add {requestStage:'Response'} for responses. Defaults from `stage`."),
      stage: z.enum(["Request", "Response", "both"]).optional().describe("Shortcut for default patterns (default Request)"),
      rules: z
        .array(
          z.object({
            match: z
              .object({
                urlContains: z.string().optional(),
                method: z.string().optional(),
                resourceType: z.string().optional(),
                stage: z.enum(["Request", "Response"]).optional(),
              })
              .optional(),
            action: z.enum(["continue", "fail", "fulfill", "modify"]).optional(),
            set: interceptSet,
            response: interceptResponse,
          }),
        )
        .optional()
        .describe("Auto-apply rules matched top-to-bottom against each paused request"),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("intercept_start", args)),
  );

  tool(
    "intercept_pending",
    "List requests/responses currently paused by interception, awaiting resolution. Set withBodies to also fetch " +
      "Response-stage bodies.",
    { withBodies: z.boolean().optional().describe("Fetch response bodies for Response-stage paused entries"), tabId: tabIdParam },
    async (args) => textResult(await hub.call("intercept_pending", args)),
  );

  tool(
    "intercept_resolve",
    "Resolve a paused request: continue (optionally mutating via `set`: url/method/headers/postData), fail " +
      "(block it), or fulfill/modify (synthesize/replace the response via `response`: status/headers/body). Pass a " +
      "requestId (from intercept_pending) or all:true.",
    {
      requestId: z.string().optional().describe("Paused requestId from intercept_pending"),
      all: z.boolean().optional().describe("Apply to every currently-paused entry"),
      action: z.enum(["continue", "fail", "fulfill", "modify"]).optional().describe("Default continue"),
      set: interceptSet,
      response: interceptResponse,
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("intercept_resolve", args)),
  );

  tool(
    "intercept_stop",
    "Stop interception, release any still-paused requests, and disable CDP Fetch (removes the banner after idle).",
    { tabId: tabIdParam },
    async (args) => textResult(await hub.call("intercept_stop", args)),
  );

  // ---- fuzz (intruder) ----
  tool(
    "fuzz",
    "Intruder-style fuzzer over a request template, fired from the live session (banner-free). Returns per-request " +
      "{status,length,timeMs,contentType,snippet} with anomalies (deviating status/length or errors) flagged first. " +
      "Modes: 'sniper' (default; one marker, payloads[]), 'pitchfork' (multiple markers, i-th of each payloadSets[]), " +
      "'clusterbomb' (all combinations of payloadSets[]), 'race' (fire raceCount identical requests together for " +
      "race-condition testing - best-effort single-packet via concurrent release). Pairs with response_diff/authz_matrix.",
    {
      template: z
        .union([
          z.string(),
          z.object({ url: z.string(), method: z.string().optional(), headers: z.record(z.string()).optional(), body: z.string().optional() }),
        ])
        .describe("URL string containing the marker(s), or {url,method,headers,body} with the marker(s) in any field"),
      mode: z.enum(["sniper", "pitchfork", "clusterbomb", "race"]).optional().describe("Attack type (default sniper)"),
      payloads: z.array(z.string()).optional().describe("sniper: payloads substituted for `marker` (one request each)"),
      payloadSets: z.array(z.array(z.string())).optional().describe("pitchfork/clusterbomb: one payload array per marker"),
      markers: z.array(z.string()).optional().describe("pitchfork/clusterbomb marker strings (default ['§1§','§2§',…])"),
      marker: z.string().optional().describe("sniper/race single marker (default §)"),
      payload: z.string().optional().describe("race: the single payload substituted into every request"),
      raceCount: z.number().optional().describe("race: number of simultaneous requests (default 20, max 50)"),
      method: z.string().optional().describe("Default method when template is a bare URL"),
      headers: z.record(z.string()).optional().describe("Extra/base request headers"),
      body: z.string().optional().describe("Request body when template is a bare URL"),
      concurrency: z.number().optional().describe("Parallel requests for non-race modes (default 10, max 30)"),
      identity: z.string().optional().describe("'anon' strips cookies; default uses the live session"),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("fuzz", args, 120_000)),
  );

  // ---- cookies (chrome.cookies - real flags incl. HttpOnly) ----
  tool(
    "cookies_get",
    "Read cookies from the real browser jar, including HttpOnly, with full flags (secure, sameSite, expirationDate, " +
      "path, domain). Filter by url and/or domain and/or name.",
    {
      url: z.string().optional().describe("Cookies readable for this URL"),
      domain: z.string().optional().describe("Cookies for this domain"),
      name: z.string().optional().describe("Only cookies with this name"),
    },
    async (args) => textResult(await hub.call("cookies_get", args)),
  );

  tool(
    "cookies_set",
    "Create or overwrite a cookie in the real browser jar (set/tamper flags: httpOnly, secure, sameSite, expiry).",
    {
      url: z.string().describe("URL the cookie applies to (scheme+host+path)"),
      name: z.string(),
      value: z.string().optional(),
      domain: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      sameSite: z.enum(["no_restriction", "lax", "strict", "unspecified"]).optional(),
      expirationDate: z.number().optional().describe("Unix seconds; omit for a session cookie"),
    },
    async (args) => textResult(await hub.call("cookies_set", args)),
  );

  tool(
    "cookies_delete",
    "Delete a cookie from the real browser jar.",
    { url: z.string().describe("URL the cookie applies to"), name: z.string() },
    async (args) => textResult(await hub.call("cookies_delete", args)),
  );

  // ---- web storage (localStorage / sessionStorage) ----
  tool(
    "storage_dump",
    "Dump this tab's origin web storage (localStorage + sessionStorage) as key/value maps.",
    { kinds: z.array(z.enum(["local", "session"])).optional().describe("Which stores (default both)"), tabId: tabIdParam },
    async (args) => textResult(await hub.call("storage_dump", args)),
  );

  tool(
    "storage_set",
    "Set a key in this tab's localStorage or sessionStorage.",
    { area: z.enum(["local", "session"]).optional().describe("Default local"), key: z.string(), value: z.string(), tabId: tabIdParam },
    async (args) => textResult(await hub.call("storage_set", args)),
  );

  tool(
    "storage_remove",
    "Remove a key from this tab's localStorage or sessionStorage.",
    { area: z.enum(["local", "session"]).optional().describe("Default local"), key: z.string(), tabId: tabIdParam },
    async (args) => textResult(await hub.call("storage_remove", args)),
  );

  tool(
    "storage_clear",
    "Clear this tab's localStorage or sessionStorage.",
    { area: z.enum(["local", "session"]).optional().describe("Default local"), tabId: tabIdParam },
    async (args) => textResult(await hub.call("storage_clear", args)),
  );

  // ---- console/log capture ----
  tool(
    "console_start",
    "Start buffering this tab's console output, uncaught exceptions, and CSP/log violations (via CDP; CSP-independent).",
    { tabId: tabIdParam },
    async (args) => textResult(await hub.call("console_start", args)),
  );

  tool(
    "console_get",
    "Return buffered console/log entries. Filter by `pattern` (regex on text) and/or `level`; `limit` caps the count (default 200).",
    {
      pattern: z.string().optional().describe("Case-insensitive regex over entry text"),
      level: z.string().optional().describe("Filter by level (e.g. error, warning, info, log)"),
      limit: z.number().optional().describe("Max entries to return (default 200)"),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("console_get", args)),
  );

  tool(
    "console_stop",
    "Stop console/log capture on this tab.",
    { tabId: tabIdParam },
    async (args) => textResult(await hub.call("console_stop", args)),
  );

  // ---- save_page (MHTML evidence snapshot) ----
  tool(
    "save_page",
    "Save the tab as a single self-contained .mhtml file (evidence snapshot; opens in Chrome). Writes to savePath.",
    { savePath: z.string().describe("Absolute path to write the .mhtml file"), tabId: tabIdParam },
    async ({ savePath, tabId }) => {
      const r = await hub.call("save_page", { tabId }, 60_000);
      if (!r?.mhtml) throw new Error("Empty page snapshot");
      writeFileSync(savePath, r.mhtml, "utf8");
      return textResult({ saved: savePath, bytes: Buffer.byteLength(r.mhtml), url: r.url, title: r.title });
    },
  );

  // ---- passive recon + JWT ----
  tool(
    "analyze",
    "One-call passive security analysis of a page: fetches the URL from the live session and grades its " +
      "response security headers (CSP weaknesses, HSTS, X-Frame-Options/frame-ancestors, CORS, Referrer-Policy, " +
      "X-Content-Type-Options, version leakage), the cookie flags (Secure/HttpOnly/SameSite), and sweeps the " +
      "response body for exposed secrets/API-keys/JWTs. Returns findings ranked by severity. No banner.",
    {
      url: z.string().optional().describe("URL to analyze (defaults to the tab's current URL)"),
      deep: z.boolean().optional().describe("Also fetch same-origin external <script src> bundles and sweep them for secrets (bounded to ~15 scripts). Default off (single fast request)."),
      tabId: tabIdParam,
    },
    async ({ url, deep, tabId }) => {
      let target = url;
      if (!target) {
        const pt = await hub.call("get_page_text", { tabId });
        target = pt?.url;
      }
      if (!target) throw new Error("No URL to analyze (provide url or a loaded tab)");
      const resp = await hub.call("replay_request", { url: target, method: "GET", tabId }, 45_000);
      if (resp?.error) throw new Error(`fetch failed: ${resp.error}`);
      const headers = resp.headers || {};
      let cookies: any[] = [];
      try {
        const cg = await hub.call("cookies_get", { url: target });
        cookies = cg?.cookies || [];
      } catch {
        /* cookies optional */
      }
      const isHttps = target.startsWith("https:");
      const findings = [
        ...analyzeHeaders(headers, isHttps),
        ...analyzeCookies(cookies, isHttps),
        ...scanSecrets(resp.body || ""),
      ];
      let scannedScripts = 0;
      if (deep && typeof resp.body === "string") {
        const scripts = extractSameOriginScripts(resp.body, target).slice(0, 15);
        for (const src of scripts) {
          try {
            const jr = await hub.call("replay_request", { url: src, method: "GET", tabId }, 30_000);
            if (typeof jr?.body === "string") {
              scannedScripts++;
              for (const f of scanSecrets(jr.body)) findings.push({ ...f, detail: `${f.detail} - external script`, evidence: `${f.evidence ?? ""} @ ${src}` });
            }
          } catch {
            /* unreachable/blocked script - skip */
          }
        }
      }
      findings.sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
      return textResult({
        url: target,
        status: resp.status,
        findings,
        summary: { total: findings.length, high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length },
        cookies: cookies.map((c) => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite })),
        note: deep
          ? `Swept the fetched response + ${scannedScripts} same-origin external script(s). Cross-origin bundles and lazy-loaded chunks aren't followed.`
          : "Body sweep covers the fetched response (inline HTML/JS). Pass deep:true to also fetch same-origin external <script src> bundles.",
      });
    },
  );

  tool(
    "jwt_decode",
    "Decode a JWT (accepts a raw token or a 'Bearer …' string) into its header + payload without verifying " +
      "the signature, and flag risks: alg:none, HS/RS alg-confusion exposure, and expiry (exp/nbf/iat).",
    { token: z.string().describe("The JWT (or 'Bearer <jwt>')") },
    async ({ token }) => textResult(decodeJwt(token)),
  );

  // ---- capture export ----
  tool(
    "export_har",
    "Write the tab's captured network traffic to a HAR 1.2 file (importable into Burp, DevTools, or Playwright) " +
      "for durable, portable captures. Requires an active net_capture_start on the tab; includes response bodies " +
      "by default.",
    {
      savePath: z.string().describe("Absolute path to write the .har file"),
      includeBodies: z.boolean().optional().describe("Include response bodies (default true)"),
      tabId: tabIdParam,
    },
    async ({ savePath, includeBodies, tabId }) => {
      const cap = await hub.call("net_get_requests", { tabId, includeBodies: includeBodies !== false, limit: 5000 }, 120_000);
      const rows: any[] = cap?.requests || [];
      const nowIso = new Date().toISOString();
      const har = { log: { version: "1.2", creator: { name: "browser-bridge", version }, entries: rows.map((r) => harEntry(r, nowIso)) } };
      writeFileSync(savePath, JSON.stringify(har, null, 2));
      return textResult({ saved: savePath, entries: rows.length, note: cap?.totalBuffered ? `${cap.totalBuffered} buffered on tab` : undefined });
    },
  );

  tool(
    "request_to_curl",
    "Emit a ready-to-run curl command that reproduces a request - from a captured requestId (reusing the REAL " +
      "sent headers incl. Cookie, plus the POST body) or an ad-hoc {url,method,headers,body}. For copying a request " +
      "out to a terminal / Burp workflow. Pure server-side assembly; values are shell-quoted; HTTP/2 pseudo-headers " +
      "and Content-Length are dropped (curl recomputes).",
    {
      requestId: z.string().optional().describe("requestId from net_get_requests (reuses its real headers + body)"),
      url: z.string().optional().describe("Ad-hoc request URL (if no requestId)"),
      method: z.string().optional().describe("HTTP method (default GET)"),
      headers: z.record(z.string()).optional().describe("Ad-hoc request headers"),
      body: z.string().optional().describe("Request body"),
      tabId: tabIdParam,
    },
    async (args) => {
      if (!args.requestId && !args.url) throw new Error("Provide a requestId or a url");
      const d = await hub.call("request_details", args);
      if (d?.error) throw new Error(d.error);
      return textResult({ curl: toCurl(d), url: d.url, method: (d.method || "GET").toUpperCase() });
    },
  );

  // ---- playbooks (saved, self-healing task recipes; see docs/PLAYBOOKS.md) ----
  tool(
    "playbook_record_start",
    "Start RECORD MODE: append every subsequent tool call (method + params, timestamped) to a JSON-Lines file as a " +
      "DRAFT SEED for a playbook. Perform the repeatable task once, then call playbook_record_stop. The draft is a raw " +
      "call log - you then DISTILL it into a durable playbook (docs/PLAYBOOKS.md): translate ephemeral refs/requestIds " +
      "into role/accessible-name locators, generalize concrete values into params, add checkpoints + 'understanding' " +
      "notes, and STRIP any secrets/cookies/bearers. Never ship the raw draft as the playbook.",
    { savePath: z.string().describe("Absolute path (or ~/…) for the draft .jsonl, e.g. ~/.browser-bridge/playbooks/<slug>.draft.jsonl") },
    async ({ savePath }) => {
      const p = expandHome(savePath);
      mkdirSync(dirname(p), { recursive: true });
      return textResult(hub.startRecording(p));
    }
  );

  tool(
    "playbook_record_stop",
    "Stop record mode and close the draft JSONL. Returns {saved, count} where count is the number of calls recorded.",
    {},
    async () => textResult(hub.stopRecording() ?? { recording: false, note: "was not recording" })
  );

  tool(
    "playbook_save",
    "Write a playbook's Markdown to disk server-side (so it lands in the global home regardless of the client's write " +
      "scope). Playbooks live at ~/.browser-bridge/playbooks/<slug>.md (global, cross-project) or ./playbooks/<slug>.md " +
      "(project-local, git-shareable). NEVER include secrets, cookies, bearers, refs, or requestIds - only descriptions, " +
      "role/text locators, checkpoints, and 'understanding' notes. Format + protocol: docs/PLAYBOOKS.md.",
    {
      savePath: z.string().describe("Absolute path (or ~/…) to write the .md playbook to"),
      markdown: z.string().describe("The full playbook Markdown (YAML frontmatter + steps), per docs/PLAYBOOKS.md"),
    },
    async ({ savePath, markdown }) => {
      const p = expandHome(savePath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, markdown, "utf8");
      return textResult({ saved: p, bytes: Buffer.byteLength(markdown) });
    }
  );

  // ---- session recording (rrweb -> self-contained HTML replay) ----
  // The tabId -> events-file path bookkeeping lives on the hub singleton (hub.setRecordingPath/…),
  // NOT a per-MCP-session closure, so session_record_stop resolves the path even if start and stop
  // are issued from different MCP sessions/clients (e.g. after a reconnect, or Claude Code + Codex).

  tool(
    "session_record_start",
    "Start recording the tab as a session replay (rrweb): captures the DOM + mutations + input/scroll/mouse over " +
      "time, BANNER-FREE (no debugger). Interact with the page, then call session_record_stop to get a self-contained " +
      "HTML file that plays the whole interaction back with a timeline/scrubber. allFrames:true also records " +
      "cross-origin iframes (a browser-bridge superpower over page-level rrweb). maskInputs:true redacts form values " +
      "(default OFF - the replay contains cleartext inputs/passwords). One recording per tab.",
    {
      tabId: tabIdParam,
      allFrames: z.boolean().optional().describe("Also record cross-origin iframes (default false = top frame + same-origin subframes)"),
      maskInputs: z.boolean().optional().describe("Redact form input values in the recording (default false)"),
      recordCanvas: z.boolean().optional().describe("Attempt to record <canvas>/WebGL (heavier; default false)"),
      eventsPath: z.string().optional().describe("Absolute path (or ~/…) for the raw events JSONL; default ~/.browser-bridge/recordings/session-<ts>.events.jsonl"),
    },
    async (args) => {
      const eventsPath = expandHome(
        args.eventsPath ||
          join(homedir(), ".browser-bridge", "recordings", `session-${new Date().toISOString().replace(/[:.]/g, "-")}.events.jsonl`)
      );
      mkdirSync(dirname(eventsPath), { recursive: true });
      if (hub.sessionSinkPathInUse(eventsPath)) throw new Error(`another recording is already writing ${eventsPath}`);
      const sink = new CaptureSink(eventsPath); // opens now -> a bad path fails THIS call
      try {
        const r = await hub.call("session_record_start", {
          tabId: args.tabId,
          allFrames: !!args.allFrames,
          maskInputs: !!args.maskInputs,
          recordCanvas: !!args.recordCanvas,
        });
        if (r?.tabId == null) throw new Error("extension did not return the recorded tabId");
        hub.registerSessionSink(r.tabId, sink);
        hub.setRecordingPath(r.tabId, eventsPath);
        return textResult({ ...r, eventsPath });
      } catch (e) {
        sink.close();
        throw e;
      }
    }
  );

  tool(
    "session_record_stop",
    "Stop the tab's session recording and assemble a SELF-CONTAINED, offline-faithful HTML replay at savePath. By " +
      "default it inlines every external asset - cross-origin stylesheets, fonts, images - fetched through the " +
      "extension (no CORS wall, session cookies), strips other extensions' injected nodes, and inlines rrweb-player. " +
      "Open the .html in any browser (offline) to replay with play/pause/scrub/speed. Returns {saved, htmlBytes, " +
      "eventCount, durationMs, inlined, skipped}.",
    {
      savePath: z.string().optional().describe("Absolute path (or ~/…) for the .html replay; default = the events file with .html"),
      title: z.string().optional().describe("Title shown on the replay page"),
      autoplay: z.boolean().optional().describe("Autoplay on open (default false)"),
      skipInactive: z.boolean().optional().describe("Fast-forward idle/scroll-only stretches in the player (default false = play everything in real time)"),
      inlineAssets: z.boolean().optional().describe("Inline external CSS/fonts/images for a self-contained offline file (default true)"),
      assetBudgetMB: z.number().optional().describe("Total inline budget in MB (default 50); oversized/over-budget assets are left live and reported in `skipped`"),
      perAssetMB: z.number().optional().describe("Per-asset size cap in MB (default 2); a single asset larger than this is left live and reported in `skipped`"),
      tabId: tabIdParam,
    },
    async (args) => {
      const r = await hub.call("session_record_stop", { tabId: args.tabId }, 30_000);
      const tabId = r?.tabId;
      hub.closeSessionSink(tabId); // usually already closed by the streamed `done`; idempotent
      const eventsPath = hub.getRecordingPath(tabId);
      hub.deleteRecordingPath(tabId);
      if (!eventsPath) throw new Error("no recording was active for this tab");
      const events = parseSessionEvents(readFileSync(eventsPath, "utf8"));
      if (!events.length) throw new Error(`recording had no events (${eventsPath}) - did you interact with the page?`);
      // Inline external assets so the replay is self-contained/offline-faithful (fetched via the extension).
      const perAssetMaxBytes = Math.round((args.perAssetMB ?? 2) * 1024 * 1024);
      let report: { inlined: number; bytesInlined: number; skipped: any[] } | undefined;
      if (args.inlineAssets !== false) {
        const fetchBatch = async (urls: string[]) => {
          // Forward the per-asset cap so the extension doesn't drop assets between 2MB and the cap.
          const res = await hub.call("fetch_resources", { urls, perAssetMaxBytes }, 120_000);
          const map: Record<string, any> = {};
          for (const it of res?.resources || []) map[it.url] = it;
          return map;
        };
        report = await inlineAssets(events, fetchBatch, {
          totalBudgetBytes: (args.assetBudgetMB ?? 50) * 1024 * 1024,
          perAssetMaxBytes,
        });
      }
      const savePath = expandHome(args.savePath || eventsPath.replace(/\.events\.jsonl$|\.jsonl$/, "") + ".html");
      mkdirSync(dirname(savePath), { recursive: true });
      const htmlBytes = await writeRrwebHtml(savePath, events, { title: args.title, autoplay: !!args.autoplay, skipInactive: !!args.skipInactive });
      let min = Infinity, max = 0;
      for (const e of events) {
        const t = e.timestamp || 0;
        if (t) {
          if (t < min) min = t;
          if (t > max) max = t;
        }
      }
      return textResult({
        saved: savePath,
        htmlBytes,
        eventCount: events.length,
        durationMs: max > min ? max - min : 0,
        inlined: report?.inlined ?? 0,
        inlinedBytes: report?.bytesInlined ?? 0,
        skipped: report?.skipped ?? [],
        eventsPath,
      });
    }
  );

  tool(
    "session_record_status",
    "List active session recordings (tab, events-file path, events written so far).",
    {},
    async () => textResult({ recordings: hub.sessionSinkList() })
  );

  tool(
    "bridge_status",
    "Check whether the Chrome extension is currently connected to the bridge.",
    {},
    async () => textResult({ extensionConnected: hub.connected, recording: hub.recording })
  );
}

// ---- server-side response diffing (used by authz_matrix + the response_diff tool) ----

const NOISE = /("(?:csrf|token|nonce|_token|authenticity_token|timestamp|ts|time|date|expires|iat|exp|sid|requestid)"\s*:\s*"[^"]*")/gi;

function tokenize(s: string): Set<string> {
  return new Set((String(s || "").toLowerCase().replace(NOISE, "").match(/[a-z0-9_]+/g) || []).slice(0, 5000));
}

function jaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function responseDiff(a: { status?: number; body?: string; bytes?: number }, b: { status?: number; body?: string; bytes?: number }) {
  const aLen = a.bytes ?? (a.body ? a.body.length : 0);
  const bLen = b.bytes ?? (b.body ? b.body.length : 0);
  return {
    sameStatus: a.status === b.status,
    statusA: a.status,
    statusB: b.status,
    lenDelta: bLen - aLen,
    similarity: Number(jaccard(a.body || "", b.body || "").toFixed(3)),
  };
}

// ---- passive analysis helpers (pure) ----
type Finding = { severity: "high" | "medium" | "low" | "info"; id: string; detail: string; evidence?: string };
const sevRank = (s: string) => ({ high: 3, medium: 2, low: 1, info: 0 } as any)[s] ?? 0;
const hget = (h: Record<string, string>, k: string) => h[k] ?? h[k.toLowerCase()] ?? h[k.toUpperCase()];

function analyzeHeaders(h: Record<string, string>, isHttps: boolean): Finding[] {
  const f: Finding[] = [];
  const csp = hget(h, "content-security-policy");
  if (!csp) f.push({ severity: "medium", id: "csp-missing", detail: "No Content-Security-Policy header" });
  else {
    if (/'unsafe-inline'/.test(csp)) f.push({ severity: "medium", id: "csp-unsafe-inline", detail: "CSP allows 'unsafe-inline'" });
    if (/'unsafe-eval'/.test(csp)) f.push({ severity: "low", id: "csp-unsafe-eval", detail: "CSP allows 'unsafe-eval'" });
    if (/(?:script-src|default-src)[^;]*\s\*(?:\s|;|$)/.test(csp)) f.push({ severity: "medium", id: "csp-wildcard", detail: "Wildcard * source in script-src/default-src" });
    if (!/object-src/.test(csp)) f.push({ severity: "low", id: "csp-no-object-src", detail: "No object-src (plugin/embed) restriction" });
    if (!/base-uri/.test(csp)) f.push({ severity: "low", id: "csp-no-base-uri", detail: "No base-uri (base-tag injection risk)" });
    if (!/frame-ancestors/.test(csp)) f.push({ severity: "info", id: "csp-no-frame-ancestors", detail: "No frame-ancestors (relies on X-Frame-Options)" });
  }
  if (isHttps && !hget(h, "strict-transport-security")) f.push({ severity: "low", id: "no-hsts", detail: "No Strict-Transport-Security (HSTS) header" });
  const xfo = hget(h, "x-frame-options");
  if (!xfo && !(csp && /frame-ancestors/.test(csp))) f.push({ severity: "medium", id: "clickjacking", detail: "No X-Frame-Options and no CSP frame-ancestors - page is framable (clickjacking)" });
  const acao = hget(h, "access-control-allow-origin");
  const acac = hget(h, "access-control-allow-credentials");
  const corsCreds = String(acac).toLowerCase() === "true";
  if (acao === "*" && corsCreds) f.push({ severity: "high", id: "cors-wildcard-creds", detail: "CORS ACAO:* with Allow-Credentials:true (invalid+dangerous combo)" });
  else if ((acao || "").toLowerCase() === "null" && corsCreds) f.push({ severity: "high", id: "cors-null-creds", detail: "CORS ACAO:null with Allow-Credentials:true - any sandboxed/opaque origin (e.g. a data: or sandboxed iframe) can read credentialed responses", evidence: acao });
  else if (acao && acao !== "*" && /^https?:\/\//.test(acao) && corsCreds) f.push({ severity: "medium", id: "cors-reflect-creds", detail: `CORS reflects an origin (${acao}) with credentials - verify allow-list`, evidence: acao });
  if (!hget(h, "x-content-type-options")) f.push({ severity: "low", id: "no-nosniff", detail: "No X-Content-Type-Options: nosniff" });
  if (!hget(h, "referrer-policy")) f.push({ severity: "info", id: "no-referrer-policy", detail: "No Referrer-Policy header" });
  const server = hget(h, "server");
  const xpb = hget(h, "x-powered-by");
  if (server && /\d/.test(server)) f.push({ severity: "info", id: "server-version", detail: `Server header leaks version: ${server}`, evidence: server });
  if (xpb) f.push({ severity: "info", id: "x-powered-by", detail: `X-Powered-By leaks stack: ${xpb}`, evidence: xpb });
  return f;
}

function analyzeCookies(cookies: any[], isHttps: boolean): Finding[] {
  const f: Finding[] = [];
  for (const c of cookies) {
    const name = c.name;
    const sessiony = /sess|token|auth|sid|jwt|csrf/i.test(name);
    if (isHttps && !c.secure) f.push({ severity: sessiony ? "medium" : "low", id: "cookie-not-secure", detail: `Cookie '${name}' missing Secure flag` });
    if (sessiony && !c.httpOnly) f.push({ severity: "medium", id: "cookie-not-httponly", detail: `Session-like cookie '${name}' missing HttpOnly` });
    const ss = String(c.sameSite || "").toLowerCase();
    if ((ss === "none" || ss === "no_restriction") && !c.secure) f.push({ severity: "medium", id: "cookie-samesite-none-insecure", detail: `Cookie '${name}' SameSite=None without Secure` });
    if (!c.sameSite || ss === "unspecified") f.push({ severity: "info", id: "cookie-no-samesite", detail: `Cookie '${name}' has no explicit SameSite` });
  }
  return f;
}

const SECRET_PATTERNS: { id: string; severity: Finding["severity"]; re: RegExp }[] = [
  { id: "aws-akia", severity: "high", re: /AKIA[0-9A-Z]{16}/g },
  { id: "google-api-key", severity: "high", re: /AIza[0-9A-Za-z_\-]{35}/g },
  { id: "slack-token", severity: "high", re: /xox[baprs]-[0-9A-Za-z\-]{10,}/g },
  { id: "github-token", severity: "high", re: /gh[pousr]_[0-9A-Za-z]{20,}/g },
  { id: "private-key", severity: "high", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: "jwt", severity: "medium", re: /eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}/g },
  { id: "generic-secret", severity: "medium", re: /["']?(?:api[_-]?key|secret|client[_-]?secret|password|passwd|access[_-]?token)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/gi },
];
function redact(s: string): string {
  return s.length <= 12 ? s.slice(0, 3) + "…" : s.slice(0, 6) + "…" + s.slice(-4);
}
function scanSecrets(body: string): Finding[] {
  const f: Finding[] = [];
  const seen = new Set<string>();
  for (const p of SECRET_PATTERNS) {
    const m = body.match(p.re);
    if (m) {
      for (const hit of Array.from(new Set(m)).slice(0, 5)) {
        const key = p.id + ":" + hit;
        if (seen.has(key)) continue;
        seen.add(key);
        f.push({ severity: p.severity, id: `secret-${p.id}`, detail: `Possible ${p.id} in response body`, evidence: redact(hit) });
      }
    }
  }
  return f;
}

// Extract absolute same-origin <script src> URLs from an HTML body (for analyze deep sweep).
function extractSameOriginScripts(html: string, pageUrl: string): string[] {
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let abs: string;
    try {
      abs = new URL(m[1], pageUrl).href;
    } catch {
      continue;
    }
    try {
      if (new URL(abs).origin !== origin) continue;
    } catch {
      continue;
    }
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

// ---- curl generation (pure) ----
function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function toCurl(d: { url: string; method?: string; headers?: Record<string, string>; body?: string }): string {
  const parts = ["curl", shq(d.url)];
  const method = (d.method || "GET").toUpperCase();
  if (method !== "GET") parts.push("-X", method);
  for (const [k, v] of Object.entries(d.headers || {})) {
    if (k.startsWith(":") || /^content-length$/i.test(k)) continue; // HTTP/2 pseudo-headers / auto-computed
    parts.push("-H", shq(`${k}: ${v}`));
  }
  if (d.body != null && d.body !== "") parts.push("--data-raw", shq(d.body));
  return parts.join(" ");
}

// ---- JWT decode (pure) ----
function b64urlToStr(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b.padEnd(Math.ceil(b.length / 4) * 4, "="), "base64").toString("utf8");
}
function decodeJwt(raw: string): any {
  const token = raw.trim().replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Not a JWT (expected header.payload[.signature])");
  const parse = (s: string) => {
    try {
      return JSON.parse(b64urlToStr(s));
    } catch {
      return { __undecodable: s.slice(0, 24) + "…" };
    }
  };
  const header = parse(parts[0]);
  const payload = parse(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  const findings: Finding[] = [];
  const alg = header?.alg;
  if (alg === "none" || alg === "None") findings.push({ severity: "high", id: "alg-none", detail: "alg:none - signature not verified; forgeable if the server accepts it" });
  if (typeof alg === "string" && /^HS/.test(alg)) findings.push({ severity: "info", id: "hmac-alg", detail: `HMAC (${alg}) - check for RS↔HS alg-confusion if the server also accepts RS* verified with the public key as HMAC secret` });
  if (payload?.exp && payload.exp < now) findings.push({ severity: "info", id: "expired", detail: `Token expired ${now - payload.exp}s ago` });
  if (payload?.nbf && payload.nbf > now) findings.push({ severity: "info", id: "not-yet-valid", detail: "Token not valid yet (nbf in the future)" });
  return {
    header,
    payload,
    alg,
    signaturePresent: parts.length === 3 && !!parts[2],
    expiresInSec: payload?.exp ? payload.exp - now : null,
    expired: payload?.exp ? payload.exp < now : null,
    findings,
  };
}

// ---- HAR export (pure) ----
function harHeaders(obj: Record<string, string> | undefined): { name: string; value: string }[] {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}
function harEntry(r: any, nowIso: string): any {
  let query: { name: string; value: string }[] = [];
  try {
    query = [...new URL(r.url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    /* relative/invalid url */
  }
  const reqHeaders = r.requestHeaders || {};
  const ct = hget(reqHeaders, "content-type") || "application/octet-stream";
  const entry: any = {
    startedDateTime: nowIso,
    time: 0,
    request: {
      method: r.method || "GET",
      url: r.url || "",
      httpVersion: "HTTP/1.1",
      headers: harHeaders(reqHeaders),
      queryString: query,
      cookies: [],
      headersSize: -1,
      bodySize: r.requestBody ? r.requestBody.length : 0,
    },
    response: {
      status: r.status || 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: harHeaders(r.responseHeaders),
      cookies: [],
      content: { size: r.responseBody ? r.responseBody.length : 0, mimeType: r.mimeType || "", ...(r.responseBody ? { text: r.responseBody, encoding: r.responseBodyBase64 ? "base64" : undefined } : {}) },
      redirectURL: hget(r.responseHeaders || {}, "location") || "",
      headersSize: -1,
      bodySize: r.responseBody ? r.responseBody.length : -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
  if (r.requestBody) entry.request.postData = { mimeType: ct, text: r.requestBody };
  return entry;
}

// ---- session replay: assemble a self-contained rrweb-player HTML (pure) ----
// Vendored rrweb-player (MIT), read once. Path is relative to the compiled dist/tools.js.
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
let PLAYER_JS = "";
let PLAYER_CSS = "";
try {
  PLAYER_JS = readFileSync(join(VENDOR_DIR, "rrweb-player.umd.min.js"), "utf8");
  PLAYER_CSS = readFileSync(join(VENDOR_DIR, "rrweb-player.css"), "utf8");
} catch {
  /* vendored player missing - writeRrwebHtml throws a clear error */
}
const htmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// Write one offline HTML file that inlines the player + events, opening with play/scrub controls.
// The replay FILLS the viewer window at the RECORDED page's exact aspect ratio (fit-to-viewport):
// the player box is sized to the recorded viewport's aspect scaled to fit the window, so there is no
// internal letterbox - the only empty space is the dark page background around the replay. It rescales
// on window/visualViewport resize and honors mid-session viewport changes via the Replayer 'resize'.
async function writeRrwebHtml(savePath: string, events: any[], meta: { title?: string; autoplay?: boolean; skipInactive?: boolean }): Promise<number> {
  if (!PLAYER_JS) throw new Error("vendored rrweb-player not found in server/vendor/ - build/vendor it first");
  const title = htmlEsc(meta.title || "Session replay");
  // Escape '<' in the events JSON so a captured "</script>" can't close our inline <script> block.
  const json = JSON.stringify(events).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${PLAYER_CSS}</style>
<style>
  /* ===== FRACTURE // DS-1 - replay chrome. Monochrome stage; chroma = live/severity, never decoration. ===== */
  :root{
    --ink:#000;--ink-2:#050506;--surface:#0a0a0b;--surface-2:#101012;--surface-3:#17171a;
    --white:#fff;--text:#ededee;--text-2:#a2a2a7;--text-3:#6c6c73;--text-4:#3b3b41;
    --line:rgba(255,255,255,.09);--line-2:rgba(255,255,255,.17);--line-hair:rgba(255,255,255,.045);
    --live:#4ade80;--live-line:rgba(74,222,128,.42);--live-bg:rgba(74,222,128,.10);
    --font-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
    --font-disp:"Inter Tight","Helvetica Neue",Helvetica,Arial,sans-serif;
    --bar-top:46px;--bar-bot:78px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--ink);color:var(--text);font-family:var(--font-mono);overflow:hidden}
  body::after{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;background:radial-gradient(130% 92% at 50% 0%,transparent 0,transparent 44%,rgba(0,0,0,.72) 100%)}
  /* stage: the replay is centered in the band between the top metabar and the bottom control bar.
     Do NOT touch .rr-player__frame width or .replayer-wrapper transform - it breaks the computed scale. */
  #bb-player{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;width:100vw;height:100vh;padding:var(--bar-top) 0 var(--bar-bot);overflow:hidden}
  #bb-player .rr-player{float:none;border-radius:2px;background:var(--ink);box-shadow:0 0 0 1px var(--line),0 40px 90px rgba(0,0,0,.62);margin-bottom:-80px}
  /* ^ .rr-player still reserves the HIDDEN 80px controller at its bottom (frame + 80); negate it via
     CSS (the player only ever sets inline width/height, never margin, so this persists) so the visible
     FRAME - not the frame+controller box - is what centers in the band between the metabar and the bar. */
  #bb-player .rr-player__frame{border-radius:2px}
  #bb-player .rr-controller{display:none!important} /* hidden: still mounts + emits ui-update time/state to our bar */

  /* ---- top metabar ---- */
  #bb-meta{position:fixed;top:0;left:0;right:0;z-index:30;height:var(--bar-top);display:flex;align-items:center;gap:18px;padding:0 22px;background:rgba(0,0,0,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--text-3)}
  #bb-meta .mark{color:var(--white);font-weight:700;letter-spacing:.26em}
  #bb-meta .sep{color:var(--text-4)}
  #bb-meta .ttl{font-family:var(--font-disp);font-weight:600;font-size:12px;letter-spacing:-.01em;text-transform:none;color:var(--text)}
  #bb-meta .spacer{flex:1}
  #bb-meta .stat b{color:var(--white);font-weight:600}
  #bb-meta .live{display:inline-flex;align-items:center;gap:7px;color:var(--live)}
  #bb-meta .live .d{width:5px;height:5px;border-radius:50%;background:var(--live);box-shadow:0 0 8px var(--live)}
  @media(max-width:720px){#bb-meta .hide-sm{display:none}}

  /* ---- bottom control bar ---- */
  #bb-bar{position:fixed;left:0;right:0;bottom:0;z-index:30;height:var(--bar-bot);display:flex;align-items:center;gap:16px;padding:0 22px;background:rgba(5,5,6,.86);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-top:1px solid var(--line);font-family:var(--font-mono)}
  .bb-ic{width:38px;height:38px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--line-2);border-radius:3px;background:transparent;color:var(--text);cursor:pointer;transition:border-color .16s,color .16s,opacity .16s,background .16s}
  .bb-ic:hover{border-color:var(--white);color:var(--white)}
  .bb-ic svg{width:15px;height:15px}
  #bb-play{border-color:var(--white);background:var(--white);color:var(--ink)} /* the single solid mark */
  #bb-play:hover{opacity:.82}
  .bb-time{font-size:11px;letter-spacing:.06em;color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums}
  .bb-time b{color:var(--white);font-weight:600}
  .bb-track{position:relative;flex:1;min-width:80px;height:26px;display:flex;align-items:center;cursor:pointer;touch-action:none}
  .bb-track .rail{position:absolute;left:0;right:0;height:2px;background:var(--line-2);transition:height .12s}
  .bb-track .fill{position:absolute;left:0;height:2px;background:var(--white);width:0;transition:height .12s}
  .bb-track .knob{position:absolute;left:0;width:3px;height:13px;background:var(--white);transform:translateX(-50%)}
  .bb-track:hover .rail,.bb-track:hover .fill{height:3px}
  .bb-chips{display:flex;gap:6px;align-items:center}
  .bb-chip{font-family:var(--font-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:7px 12px;border-radius:999px;border:1px solid var(--line);color:var(--text-3);background:transparent;cursor:pointer;transition:border-color .14s,color .14s,background .14s;white-space:nowrap}
  .bb-chip:hover{border-color:var(--line-2);color:var(--text)}
  .bb-chip.on{background:var(--white);border-color:var(--white);color:var(--ink);font-weight:600}
  .bb-chip.live.on{background:var(--live);border-color:var(--live);color:var(--ink)}
  .bb-div{width:1px;height:26px;background:var(--line);flex:none}
  @media(max-width:820px){#bb-bar{gap:10px;padding:0 12px}.bb-hide-sm{display:none}}

  /* ---- interaction overlay: smooth "live" comet trail + click ripples + keystroke HUD ---- */
  .bb-trail{position:absolute;left:0;top:0;pointer-events:none}
  .bb-click{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;border:1.5px solid var(--live);background:var(--live-bg);pointer-events:none;animation:bb-ripple .6s ease-out forwards}
  @keyframes bb-ripple{0%{transform:scale(.3);opacity:.95}100%{transform:scale(2.7);opacity:0}}
  .bb-hud{position:fixed;left:50%;bottom:calc(var(--bar-bot) + 16px);transform:translateX(-50%);z-index:29;display:flex;gap:5px;align-items:center;flex-wrap:wrap;justify-content:center;max-width:80vw;padding:8px 10px;border-radius:8px;background:rgba(5,5,6,.9);border:1px solid var(--line);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-shadow:0 12px 34px rgba(0,0,0,.55);opacity:0;transition:opacity .2s;pointer-events:none}
  .bb-hud.show{opacity:1}
  .bb-key{font-family:var(--font-mono);font-size:12px;letter-spacing:.02em;padding:3px 8px;border-radius:3px;background:var(--surface-3);border:1px solid var(--line-2);color:var(--text);white-space:pre}
  .bb-key.mod{color:var(--live);border-color:var(--live-line);background:var(--live-bg)}
</style>
</head><body>
<div id="bb-meta"><span class="mark">FRACTURE</span><span class="sep">//</span><span class="ttl">${title}</span><span class="spacer"></span><span class="stat hide-sm">EVENTS <b id="bb-ev">0</b></span><span class="stat hide-sm">DUR <b id="bb-dur">0:00</b></span><span class="live"><span class="d"></span>REPLAY</span></div>
<div id="bb-player"></div>
<div id="bb-bar">
  <button id="bb-play" class="bb-ic" title="Play / pause"></button>
  <div class="bb-time"><b id="bb-cur">0:00</b> / <span id="bb-total">0:00</span></div>
  <div id="bb-track" class="bb-track"><div class="rail"></div><div class="fill"></div><div class="knob"></div></div>
  <div class="bb-div bb-hide-sm"></div>
  <div id="bb-speeds" class="bb-chips"><button class="bb-chip on" data-s="1">1&#215;</button><button class="bb-chip" data-s="2">2&#215;</button><button class="bb-chip" data-s="4">4&#215;</button><button class="bb-chip" data-s="8">8&#215;</button></div>
  <div class="bb-div bb-hide-sm"></div>
  <button id="bb-skip" class="bb-chip${meta.skipInactive ? " on" : ""} bb-hide-sm" title="Skip idle stretches">Skip idle</button>
  <button id="bb-keys" class="bb-chip live on" title="Show clicks &amp; keystrokes">Keys</button>
  <button id="bb-full" class="bb-ic" title="Fullscreen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
</div>
<script id="bb-events" type="application/json">${json}</script>
<script>${PLAYER_JS}</script>
<script>
(function(){
  var events = JSON.parse(document.getElementById('bb-events').textContent);
  var g = window.rrwebPlayer || {};
  var P = g.default || g.Player || g;
  // Recorded viewport (CSS pixels) from the first Meta (type 4) event; the viewer window is also in CSS
  // pixels, so the fit math is DPR-correct by construction - never multiply by devicePixelRatio.
  var m = events.find(function(e){ return e.type === 4; });
  var vw = (m && m.data && m.data.width) || 1024, vh = (m && m.data && m.data.height) || 576;
  var CTRL = 46 + 78; // reserve the top metabar (46) + bottom control bar (78) so the replay fits between them
  var player = new P({ target: document.getElementById('bb-player'),
    props: { events: events, showController: true, autoPlay: ${meta.autoplay ? "true" : "false"},
             skipInactive: ${meta.skipInactive ? "true" : "false"}, speedOption: [1,2,4,8],
             width: vw, height: vh,
             mouseTail: false, /* disable rrweb's red, hard-cornered trail; we draw a smooth one below */
             maxScale: 0 /* uncap scaling so small/mobile recordings upscale to fill; relies on the vendored player's "a && push(a)" falsy-guard */ } });
  function fit(){
    var s = Math.min(window.innerWidth / vw, (window.innerHeight - CTRL) / vh);
    if (!(s > 0)) s = 0.1;
    try { player.$set({ width: Math.round(vw * s), height: Math.round(vh * s) }); } catch(e){}
    try { if (player.triggerResize) player.triggerResize(); } catch(e){}
    // (the hidden controller's 80px reserve is negated in CSS via .rr-player margin-bottom, so the
    // frame centers in the band; doing it here in JS gets wiped by the player's async re-render)
  }
  var t; function refit(){ clearTimeout(t); t = setTimeout(fit, 100); }
  window.addEventListener('resize', refit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);
  // Mid-session viewport changes (reload/resize during the recording): re-fit to each new aspect.
  try {
    var rp = player.getReplayer && player.getReplayer();
    if (rp && rp.on) rp.on('resize', function(d){ if (d && d.width && d.height){ vw = d.width; vh = d.height; fit(); } });
  } catch(e){}
  requestAnimationFrame(fit);

  // ---- interaction overlay: smooth mouse trail (always on) + click ripples + keystroke HUD (toggle, default ON) ----
  (function(){
    var replayer = null;
    try { replayer = player.getReplayer(); } catch(e){}
    if (!replayer || !replayer.on) return;
    var hasKeys = false;
    for (var i=0;i<events.length;i++){ var e=events[i]; if(e && e.type===5 && e.data && e.data.tag==='bb-key'){ hasKeys=true; break; } }
    var show = true;              // interactions overlay default ON
    var pts = [];                 // {x,y,t} recent mouse points for the smooth trail
    var LIFE = 700;               // trail fade window (ms)
    var wrap=null, trail=null, ctx=null, hud=null, mouseEl=null;
    var lastVal = {};             // per-input last value (typed-text fallback / paste detection)
    var hudTokens = [], hudTimer=null;

    function ensure(){
      wrap = document.querySelector('.replayer-wrapper'); // the single scaled element; recorded x/y map into it
      if(!wrap){ requestAnimationFrame(ensure); return; }
      trail = document.createElement('canvas');
      trail.className = 'bb-trail';
      trail.width = vw; trail.height = vh;
      mouseEl = wrap.querySelector('.replayer-mouse');
      if(mouseEl) wrap.insertBefore(trail, mouseEl); else wrap.appendChild(trail); // above iframe, below cursor
      ctx = trail.getContext('2d');
      hud = document.createElement('div');
      hud.className = 'bb-hud';
      document.getElementById('bb-player').appendChild(hud);
      replayer.on('event-cast', onCast);
      requestAnimationFrame(draw);
      buildBar();
    }
    function fmt(ms){ var s=Math.max(0,Math.round(ms/1000)); var m=Math.floor(s/60); s=s%60; return m+':'+(s<10?'0':'')+s; }
    var ICON_PLAY='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    var ICON_PAUSE='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
    function buildBar(){
      var play=document.getElementById('bb-play');
      if(!play){ requestAnimationFrame(buildBar); return; }
      var total=1; try{ total=(player.getMetaData()||{}).totalTime||1; }catch(e){}
      var evEl=document.getElementById('bb-ev'); if(evEl) evEl.textContent=String(events.length);
      var durEl=document.getElementById('bb-dur'); if(durEl) durEl.textContent=fmt(total);
      var totEl=document.getElementById('bb-total'); if(totEl) totEl.textContent=fmt(total);
      var curEl=document.getElementById('bb-cur');
      var fill=document.querySelector('#bb-track .fill'), knob=document.querySelector('#bb-track .knob'), track=document.getElementById('bb-track');
      var dragging=false;
      function setProg(ms){ var f=total>0?Math.max(0,Math.min(1,ms/total)):0; fill.style.width=(f*100)+'%'; knob.style.left=(f*100)+'%'; if(curEl) curEl.textContent=fmt(ms); }
      // play / pause
      play.innerHTML = ${meta.autoplay ? "ICON_PAUSE" : "ICON_PLAY"};
      play.addEventListener('click', function(){ try{ player.toggle(); }catch(e){} });
      // time + state (the hidden vendored controller still dispatches these)
      player.addEventListener('ui-update-current-time', function(d){ if(!dragging) setProg((d&&d.payload)||0); });
      player.addEventListener('ui-update-player-state', function(d){ var pl=(d&&d.payload)==='playing'; play.innerHTML=pl?ICON_PAUSE:ICON_PLAY; });
      // scrub
      function seekAt(cx){ var r=track.getBoundingClientRect(); var f=r.width>0?(cx-r.left)/r.width:0; f=Math.max(0,Math.min(1,f)); setProg(f*total); try{ player.goto(f*total); }catch(e){} }
      track.addEventListener('pointerdown', function(ev){ dragging=true; try{ track.setPointerCapture(ev.pointerId); }catch(e){} seekAt(ev.clientX); });
      track.addEventListener('pointermove', function(ev){ if(dragging) seekAt(ev.clientX); });
      window.addEventListener('pointerup', function(){ dragging=false; });
      // speed
      var chips=document.querySelectorAll('#bb-speeds .bb-chip');
      for(var i=0;i<chips.length;i++){ (function(c){ c.addEventListener('click', function(){ var sp=parseInt(c.getAttribute('data-s'),10)||1; try{ player.setSpeed(sp); }catch(e){} for(var j=0;j<chips.length;j++) chips[j].classList.remove('on'); c.classList.add('on'); }); })(chips[i]); }
      // skip idle
      var skip=document.getElementById('bb-skip');
      if(skip) skip.addEventListener('click', function(){ try{ player.toggleSkipInactive(); }catch(e){} skip.classList.toggle('on'); });
      // clicks + keystrokes toggle (default ON)
      var keys=document.getElementById('bb-keys');
      if(keys) keys.addEventListener('click', function(){ show=!show; keys.classList.toggle('on', show); if(!show){ hud.classList.remove('show'); hudTokens=[]; } });
      // fullscreen
      var full=document.getElementById('bb-full');
      if(full) full.addEventListener('click', function(){ var el=document.getElementById('bb-player'); try{ if(document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen(); }catch(e){} });
    }
    function catmull(p0,p1,p2,p3,t){ // centripetal-ish Catmull-Rom: a smooth curve THROUGH the points
      var t2=t*t, t3=t2*t;
      return { x:0.5*(2*p1.x+(p2.x-p0.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(3*p1.x-p0.x-3*p2.x+p3.x)*t3),
               y:0.5*(2*p1.y+(p2.y-p0.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(3*p1.y-p0.y-3*p2.y+p3.y)*t3) };
    }
    function draw(){
      requestAnimationFrame(draw);
      if(!ctx) return;
      if(trail.width!==vw || trail.height!==vh){ trail.width=vw; trail.height=vh; } // track mid-session viewport
      var now = performance.now();
      // Sample the CURSOR's live position each frame so the trail TRAILS the mouse. (Feeding it from
      // batched MouseMove events made the trail jump ahead of the still-animating cursor - it led the
      // mouse instead of following it.) The head point is thus always exactly at the cursor.
      if(mouseEl){
        var lx=parseFloat(mouseEl.style.left), ly=parseFloat(mouseEl.style.top);
        if(!isNaN(lx) && !isNaN(ly)){
          var last = pts.length ? pts[pts.length-1] : null;
          var far = last ? (Math.abs(last.x-lx)>400 || Math.abs(last.y-ly)>400) : false; // seek jump: reset
          if(far) pts.length = 0;
          if(!last || Math.abs(last.x-lx)>0.5 || Math.abs(last.y-ly)>0.5) pts.push({x:lx,y:ly,t:now});
        }
      }
      while(pts.length && now - pts[0].t > LIFE) pts.shift();
      ctx.clearRect(0,0,trail.width,trail.height);
      var n = pts.length;
      if(n < 2) return;
      ctx.lineCap='round'; ctx.lineJoin='round';
      // Draw a Catmull-Rom spline through the points, finely resampled (SEG sub-steps per span) into a
      // tapered, fading comet - fluid and rounded even when the recorded samples are sparse.
      var SEG = 18;
      for(var i=0;i<n-1;i++){
        var p0=pts[i>0?i-1:0], p1=pts[i], p2=pts[i+1], p3=pts[i<n-2?i+2:n-1];
        var prev=p1;
        for(var s=1;s<=SEG;s++){
          var pt=catmull(p0,p1,p2,p3,s/SEG);
          var frac=(i+s/SEG)/(n-1);        // 0 = oldest tail .. 1 = newest head
          ctx.strokeStyle='rgba(74,222,128,'+(0.12+0.62*frac).toFixed(3)+')'; // FRACTURE "live" green
          ctx.lineWidth=1.2+3.3*frac;      // taper: thin faint tail -> thick bright head
          ctx.beginPath(); ctx.moveTo(prev.x,prev.y); ctx.lineTo(pt.x,pt.y); ctx.stroke();
          prev=pt;
        }
      }
    }
    function ripple(x,y){
      if(!show || !wrap) return;
      var el=document.createElement('span');
      el.className='bb-click';
      el.style.left=x+'px'; el.style.top=y+'px';
      wrap.appendChild(el);
      setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 650);
    }
    function renderHud(){
      hud.textContent='';
      for(var i=0;i<hudTokens.length;i++){
        var c=document.createElement('span');
        c.className='bb-key'+(hudTokens[i].mod?' mod':'');
        c.textContent=hudTokens[i].text; // textContent, not innerHTML: the recording's own text stays inert
        hud.appendChild(c);
      }
    }
    function hudPush(text, mod){
      if(!show || !text) return;
      hudTokens.push({text:text, mod:!!mod});
      if(hudTokens.length>16) hudTokens.shift();
      renderHud();
      hud.classList.add('show');
      clearTimeout(hudTimer);
      hudTimer=setTimeout(function(){ hud.classList.remove('show'); hudTokens=[]; }, 1400);
    }
    var SPECIAL={Enter:'↵',Tab:'⇥',Escape:'⎋',Backspace:'⌫',Delete:'⌦',ArrowLeft:'←',ArrowUp:'↑',ArrowRight:'→',ArrowDown:'↓',' ':'␣',CapsLock:'⇪',PageUp:'PgUp',PageDown:'PgDn',Home:'Home',End:'End'};
    function fmtKey(p){
      var k=p.key;
      if(k==='Shift'||k==='Control'||k==='Alt'||k==='Meta'||k==='Dead') return null; // lone modifier: skip
      var parts=[];
      if(p.meta) parts.push('⌘'); if(p.ctrl) parts.push('⌃'); if(p.alt) parts.push('⌥');
      if(p.shift && (!k || k.length>1)) parts.push('⇧'); // shift shown for non-printables; printables already cased
      parts.push(SPECIAL[k] || k);
      return { text: parts.join(' '), mod: !!(p.meta||p.ctrl||p.alt) };
    }
    function onInput(d){
      var prev = lastVal[d.id]!=null ? lastVal[d.id] : '';
      var cur = d.text!=null ? String(d.text) : '';
      lastVal[d.id]=cur;
      var delta;
      if(cur.length>=prev.length && cur.slice(0,prev.length)===prev) delta=cur.slice(prev.length);
      else delta=cur; // replaced / backspaced: show the current value
      if(!delta) return;
      if(hasKeys && delta.length<2) return; // physical keys already cover single chars; keep pastes/autofill
      hudPush(delta, false);
    }
    function onCast(e){
      if(!e || !e.data) return;
      if(e.type===3){
        var d=e.data;
        // (mouse trail is fed by sampling the cursor in draw(), not from these MouseMove batches)
        if(d.source===2 && (d.type===2||d.type===4||d.type===7) && d.x!=null){ ripple(d.x,d.y); } // Click/DblClick/TouchStart
        else if(d.source===5){ onInput(d); }
      } else if(e.type===5 && e.data.tag==='bb-key'){
        var tk=fmtKey(e.data.payload||{});
        if(tk) hudPush(tk.text, tk.mod);
      }
    }
    ensure();
  })();
})();
</script>
</body></html>`;
  await writeFileAsync(savePath, html, "utf8"); // off the shared event loop (replay can be 50MB+)
  return Buffer.byteLength(html);
}

// Parse a session events JSONL (rows {kind:"rrweb", event}) into a timestamp-sorted rrweb event array.
function parseSessionEvents(jsonl: string): any[] {
  const events: any[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.kind === "rrweb" && row.event) events.push(row.event);
    } catch {
      /* skip a torn last line */
    }
  }
  events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return events;
}
