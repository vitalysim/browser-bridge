import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, readFileSync, renameSync, copyFileSync, unlinkSync } from "fs";
import type { ExtensionHub } from "./hub.js";

const MAX_TEXT_CHARS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export function registerTools(server: McpServer, hub: ExtensionHub) {
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
    "List all open browser tabs with their id, title, url, and active state.",
    {},
    async () => textResult(await hub.call("tabs_list"))
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
    "Get the visible text content of a page (title, url, and rendered body text). " +
      "This is the primary tool for reading pages, e.g. summarizing a feed.",
    { tabId: tabIdParam },
    async ({ tabId }) => textResult(await hub.call("get_page_text", { tabId }))
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
      "can read; uses the debugger's DOM.setFileInputFiles — most reliable, no size limit, shows banner).",
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
      "method 'paste' (default), 'drop', or 'both' — some editors accept one but not the other. Set " +
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
      quality: z.number().optional().describe("JPEG quality 0–100 (default 90)"),
      selector: z.string().optional().describe("Clip to this CSS element instead of the page/viewport"),
      savePath: z.string().optional().describe("Absolute path to write the image to (returns metadata, not the image)"),
    },
    async ({ tabId, fullPage, scale, format, quality, selector, savePath }) => {
      const r = await hub.call("screenshot", { tabId, fullPage, scale, format, quality, selector }, 120_000);
      const buf = Buffer.from(r.base64, "base64");
      const dims = imageDims(buf);
      const mimeType = r.format === "jpeg" ? ("image/jpeg" as const) : ("image/png" as const);
      if (savePath) {
        writeFileSync(savePath, buf);
        return textResult({ path: savePath, bytes: buf.length, width: dims?.width, height: dims?.height, format: r.format });
      }
      return {
        content: [
          { type: "image" as const, data: r.base64, mimeType },
          { type: "text" as const, text: `${dims?.width ?? "?"}×${dims?.height ?? "?"} ${r.format}, ${buf.length} bytes` },
        ],
      };
    }
  );

  tool(
    "download_resource",
    "Download a resource (URL) to disk using Chrome's own download engine — reliably handles files " +
      "up to 100MB and well beyond (pass a larger maxBytes, or omit it, for bigger files), with correct " +
      "binary handling and the real browser session's cookies sent automatically. Banner-free (no " +
      "chrome.debugger involved). Cookie/Host/Origin/Referer/Content-Length headers are browser-forbidden " +
      "and ignored; Authorization works for token-gated downloads. Always uses the live browser session — " +
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
            `Timed out after ${overallTimeout}ms waiting for download to complete (downloadId ${start.downloadId} may still be running — check chrome://downloads or retry).`
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
      "`Runtime.evaluate`** (see cdp_eval), which bypasses the CSP but shows the debugger banner — the result " +
      "then includes `via:\"cdp-fallback\"`. Set `noFallback:true` to fail instead, or `cdp:true` to skip " +
      "straight to the CDP path. Use `awaitPromise:false` if you don't want to await a returned Promise.",
    {
      code: z.string().describe("JavaScript to evaluate (expression or statements)"),
      cdp: z.boolean().optional().describe("Force the CDP Runtime.evaluate path (bypasses CSP; shows the banner)"),
      noFallback: z.boolean().optional().describe("Do not fall back to CDP if the page CSP blocks in-page eval"),
      awaitPromise: z.boolean().optional().describe("Await a returned Promise (default true)"),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("eval_js", args))
  );

  tool(
    "cdp_eval",
    "Evaluate JavaScript in the page's real main-world context via CDP `Runtime.evaluate` — the DevTools-" +
      "console path, which **is not subject to the page's CSP `unsafe-eval`**, so it runs arbitrary code on " +
      "strict-CSP sites (Copilot, HackerOne, YesWeHack…) where `eval_js` is blocked. Unlike the isolated-world " +
      "read/interact tools, this reaches the page's live JS: in-memory state, framework internals, closures, and " +
      "the app's own functions. Uses `chrome.debugger`, so it **shows the debugging banner** (auto-detaches when " +
      "idle). `eval_js` already auto-falls back to this on CSP-blocked pages; call `cdp_eval` directly when you " +
      "want the CDP path unconditionally.",
    {
      code: z.string().describe("JavaScript to evaluate (expression or statements) in the page's main world"),
      awaitPromise: z.boolean().optional().describe("Await a returned Promise (default true)"),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("cdp_eval", args))
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
    "Start capturing network traffic on a tab via chrome.debugger (shows the debugging banner). " +
      "Then navigate/reload the tab to capture its load traffic, and read it with net_get_requests.",
    {
      urlFilter: z.string().optional().describe("Only buffer requests whose URL contains this substring"),
      tabId: tabIdParam,
    },
    async ({ urlFilter, tabId }) => textResult(await hub.call("net_capture_start", { urlFilter, tabId })),
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
      "Set identity to send as a captured identity or 'anon' (strips cookies/bearer) — this uses the CDP Fetch " +
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
      viaAppClient: z.boolean().optional().describe("Route through the page's own fetch (reserved)"),
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
    "Begin live request/response interception on the tab (Burp-Proxy style, via CDP Fetch — shows the debugger " +
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
    "Intruder-style fuzzer: substitute each payload for the marker in a request template, fire them (concurrently) " +
      "from the live session, and return per-payload {status,length,timeMs,contentType,snippet} with anomalies " +
      "(deviating status/length or errors) flagged and sorted first. Banner-free (background fetch). Pairs with response_diff/authz_matrix.",
    {
      template: z
        .union([
          z.string(),
          z.object({ url: z.string(), method: z.string().optional(), headers: z.record(z.string()).optional(), body: z.string().optional() }),
        ])
        .describe("URL string containing the marker, or {url,method,headers,body} with the marker in any field"),
      payloads: z.array(z.string()).describe("Payloads substituted for the marker (one request each)"),
      marker: z.string().optional().describe("Placeholder to replace (default §)"),
      method: z.string().optional().describe("Default method when template is a bare URL"),
      headers: z.record(z.string()).optional().describe("Extra/base request headers"),
      body: z.string().optional().describe("Request body when template is a bare URL"),
      concurrency: z.number().optional().describe("Parallel requests (default 10, max 30)"),
      identity: z.string().optional().describe("'anon' strips cookies; default uses the live session"),
      tabId: tabIdParam,
    },
    async (args) => textResult(await hub.call("fuzz", args, 120_000)),
  );

  // ---- cookies (chrome.cookies — real flags incl. HttpOnly) ----
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

  tool(
    "bridge_status",
    "Check whether the Chrome extension is currently connected to the bridge.",
    {},
    async () => textResult({ extensionConnected: hub.connected })
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
