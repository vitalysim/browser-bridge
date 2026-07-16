# Contributing to Browser Bridge

Thanks for your interest! Browser Bridge is two packages - a Node/TypeScript **MCP server** (`server/`) and a
**Manifest V3 Chrome extension** (`extension/`) - bridged by a single WebSocket. This guide gets you building and
testing changes.

## Prerequisites

- **Node.js 18+**
- **Chrome, Chromium, or Edge** (Chromium-based)
- A local checkout of this repo

## Build

There is no root package - build each package in its own directory:

```bash
# MCP server (TypeScript → dist/, via tsc)
cd server && npm install && npm run build

# Extension (bundled to background.js/options.js via esbuild)
cd ../extension && npm install && npm run build      # runs build.mjs
npm run typecheck                                     # tsc --noEmit
```

`extension/build.mjs` reads the version from `extension/package.json`, injects it into the bundle
(`__BB_VERSION__`), and keeps `manifest.json`'s version in sync.

## The dev loop (important MV3 gotcha)

After you rebuild the extension, reload it in `chrome://extensions`. **Toggle the extension Off then On** -
the ↻ reload button often keeps a *cached service worker*, so your new `background.js` may not actually run.
Confirm the new worker is live: the extension logs its version on connect, visible in the server log
(`~/.browser-bridge/server.log` → `[hub] extension hello: vX.Y.Z`).

After a server change, restart the server (or your autostart service) so the new `dist/` is served.

## Versioning

Bump **one** number: the `version` in `server/package.json` and/or `extension/package.json`. The server reads
its own `package.json` at startup; the extension build stamps `manifest.json` and the bundle. Don't hand-edit
`manifest.json`'s version.

## Adding a tool

Each MCP tool is a thin server-side registration that calls into the extension:

1. **Server** - register it in `server/src/tools.ts` with a Zod input schema (`tool(name, desc, schema, handler)`),
   forwarding to `hub.call("<method>", params)`.
2. **Extension** - handle `<method>` in the `dispatch()` switch in `extension/src/background.ts`, doing the actual
   browser work (via `chrome.scripting` injection, `chrome.debugger`/CDP, or a `chrome.*` API).
3. Update the **tool reference** table and the tool count in `README.md`.

Injected page functions must be **self-contained** (they're serialized into the page) and must signal failure by
**returning `{ error }`**, never by throwing - Chrome swallows exceptions inside `executeScript`.

## Style & testing

- TypeScript stays **strict**; keep `npm run typecheck` clean before you push.
- Match the surrounding code's style and comment density.
- Test live where you can: drive a real tab through the MCP tools and confirm the behavior end-to-end. Use a
  throwaway tab / neutral site - not your personal logged-in tabs.

## Pull requests

Open a PR against `main` with a clear description of what changed and why, and how you verified it. For anything
touching the auth/token model, the extension permission surface, or the debugger layer, call that out explicitly.

Security issues: please **don't** open a public PR/issue - see [SECURITY.md](SECURITY.md).
