import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExtensionHub } from "./hub.js";

const MAX_TEXT_CHARS = 60_000;

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
    "Click an element, identified by a ref from snapshot or a CSS selector. Set trusted:true for a " +
      "real (isTrusted) mouse click via the debugger (shows the debugging banner) — needed for a few " +
      "sites that reject synthetic clicks, and required for refs from a deep snapshot.",
    {
      ref: z.number().optional().describe("Element ref from a prior snapshot call"),
      selector: z.string().optional().describe("CSS selector (alternative to ref)"),
      trusted: z.boolean().optional().describe("Use a real trusted click via chrome.debugger (shows banner)"),
      tabId: tabIdParam,
    },
    async ({ ref, selector, trusted, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      return textResult(await hub.call("click", { ref, selector, trusted, tabId }));
    }
  );

  tool(
    "fill",
    "Fill a text input, textarea, select, or contenteditable element with a value " +
      "(dispatches input/change events so frameworks like React notice).",
    {
      value: z.string().describe("Text value to set"),
      ref: z.number().optional().describe("Element ref from a prior snapshot call"),
      selector: z.string().optional().describe("CSS selector (alternative to ref)"),
      tabId: tabIdParam,
    },
    async ({ value, ref, selector, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      return textResult(await hub.call("fill", { value, ref, selector, tabId }));
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
      tabId: tabIdParam,
    },
    async ({ ref, selector, trusted, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      return textResult(await hub.call("hover", { ref, selector, trusted, tabId }));
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
      tabId: tabIdParam,
    },
    async ({ text, ref, selector, trusted, tabId }) => {
      if (ref === undefined && !selector) throw new Error("Provide either ref or selector");
      return textResult(await hub.call("type", { text, ref, selector, trusted, tabId }));
    }
  );

  tool(
    "press_key",
    "Send a keyboard key (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown') to the focused element. " +
      "Note: events are synthetic; some sites ignore them.",
    { key: z.string().describe("Key value, e.g. 'Enter'"), tabId: tabIdParam },
    async ({ key, tabId }) => textResult(await hub.call("press_key", { key, tabId }))
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
    "scroll",
    "Scroll the page by a pixel delta, or scroll an element into view via selector.",
    {
      dy: z.number().optional().describe("Vertical pixels to scroll (positive = down). Default 600."),
      selector: z.string().optional().describe("If set, scroll this element into view instead"),
      tabId: tabIdParam,
    },
    async ({ dy, selector, tabId }) => textResult(await hub.call("scroll", { dy, selector, tabId }))
  );

  tool(
    "screenshot",
    "Take a PNG screenshot of a tab's visible viewport (activates the tab first).",
    { tabId: tabIdParam },
    async ({ tabId }) => {
      const result = await hub.call("screenshot", { tabId });
      return {
        content: [{ type: "image" as const, data: result.base64, mimeType: "image/png" }],
      };
    }
  );

  tool(
    "eval_js",
    "Evaluate a JavaScript expression in the page's main world and return its JSON-serialized " +
      "result. May fail on pages whose CSP forbids eval.",
    { code: z.string().describe("JavaScript expression to evaluate"), tabId: tabIdParam },
    async ({ code, tabId }) => textResult(await hub.call("eval_js", { code, tabId }))
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
