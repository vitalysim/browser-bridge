// A stand-in for McpServer + ExtensionHub so registerTools() can be driven without a browser, socket
// or the MCP transport. The fake hub answers each extension method from a per-method responder.
import { registerTools, type RegisterOptions } from "../../src/tools.js";

export interface Registered {
  description: string;
  inputSchema: Record<string, any>;
  cb: (args: any, extra?: any) => Promise<any>;
}

export function fakeBridge(
  responders: Record<string, (params: any) => any> = {},
  opts: RegisterOptions = {}
) {
  const tools = new Map<string, Registered>();
  const calls: { method: string; params: any }[] = [];
  const server = {
    registerTool(name: string, cfg: { description: string; inputSchema: any }, cb: any) {
      tools.set(name, { description: cfg.description, inputSchema: cfg.inputSchema, cb });
    },
  };
  const hub = {
    connected: true,
    async call(method: string, params: any = {}) {
      calls.push({ method, params });
      const r = responders[method];
      if (!r) throw new Error(`fake hub: no responder for '${method}'`);
      return r(params);
    },
  };
  registerTools(server as any, hub as any, "0.0.0-test", opts);
  const invoke = async (name: string, args: any = {}) => {
    const t = tools.get(name);
    if (!t) throw new Error(`tool '${name}' not registered`);
    return t.cb(args, {});
  };
  return { tools, calls, invoke };
}

/** Run fn with console.error captured (the per-call log goes there); returns the captured lines. */
export async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: any[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = orig;
  }
}
