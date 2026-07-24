# Third-Party Notices

Browser Bridge bundles the following third-party open-source components. Their license text is
reproduced below as required.

## rrweb / rrweb-player

- **rrweb** (v2.1.1) — the session recorder, bundled (built by `extension/build.mjs`) into
  `extension/vendor/rrweb-record.js`.
- **rrweb-player** (v2.1.1) — the replay player, vendored into `server/vendor/rrweb-player.umd.min.js`
  and `server/vendor/rrweb-player.css`.

Project: https://github.com/rrweb-io/rrweb · License: **MIT**

```
MIT License

Copyright (c) 2018 rrweb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Other server/extension dependencies (e.g. `@modelcontextprotocol/sdk`, `express`, `ws`, `zod`,
`esbuild`) are pulled from npm at build time and are **not** vendored into this repository; their
licenses live in their respective `node_modules` packages.
