// What to do when the HTTP server cannot bind. Without a handler the 'error' event is unhandled, the
// process dies with a stack trace, and launchd's KeepAlive relaunches it at once - the real log held
// ~104,000 EADDRINUSE crash dumps from exactly that loop. Instead: log ONE clear line, then exit
// non-zero after a delay so a supervisor relaunches slowly rather than spinning.

export const PORT_IN_USE_EXIT_DELAY_MS = 30_000;

export interface ListenErrorDeps {
  port: number;
  host: string;
  log: (msg: string) => void;
  exit: (code: number) => void;
  /** Resolves true when a browser-bridge already answers /health on the port. */
  probe?: (host: string, port: number) => Promise<boolean>;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/** GET /health and check it looks like a browser-bridge ({ok:true, extensionConnected:boolean}). */
export async function probeBridgeHealth(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body: any = await res.json();
    return body?.ok === true && typeof body?.extensionConnected === "boolean";
  } catch {
    return false;
  }
}

export async function handleListenError(err: NodeJS.ErrnoException, deps: ListenErrorDeps): Promise<void> {
  const { port, host, log, exit } = deps;
  const delayMs = deps.delayMs ?? PORT_IN_USE_EXIT_DELAY_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  if (err?.code !== "EADDRINUSE") {
    log(`[browser-bridge] cannot listen on ${host}:${port}: ${err?.code ?? ""} ${err?.message ?? err}`.trim());
    setTimer(() => exit(1), delayMs);
    return;
  }
  const healthy = await (deps.probe ?? probeBridgeHealth)(host, port);
  log(
    healthy
      ? `[browser-bridge] port ${port} is already in use by a healthy browser-bridge server; this instance is redundant - exiting in ${Math.round(delayMs / 1000)}s`
      : `[browser-bridge] port ${port} is already in use - another browser-bridge server is probably running (or another program holds the port; check: lsof -nP -iTCP:${port} -sTCP:LISTEN); exiting in ${Math.round(delayMs / 1000)}s`
  );
  setTimer(() => exit(1), delayMs);
}
