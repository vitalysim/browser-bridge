# Security Policy

## Supported versions

Browser Bridge is developed on a rolling basis; only the **latest release** on `main` is supported.
Please upgrade before reporting an issue.

## Reporting a vulnerability

If you find a vulnerability **in Browser Bridge itself** - the MCP server, the WebSocket hub, the token/auth
model, or the Chrome extension - please report it privately:

- **Preferred:** open a private report via GitHub → the repository's **Security** tab → **Report a vulnerability**
  (GitHub Private Vulnerability Reporting).

Please include a description, affected version/commit, reproduction steps, and impact. We aim to acknowledge
reports within a few days. Please do **not** open a public issue for a security bug.

## Scope

In scope - issues that weaken the bridge's own security boundary, for example:

- The bearer-token / localhost-binding model (`127.0.0.1` only, token on the MCP endpoint **and** the WS handshake,
  `chrome-extension://` origin check).
- The extension's permission surface or message handling.
- Any path that lets an untrusted web page or a non-localhost process reach the server or drive the extension.

Out of scope:

- **Requests to test third-party websites.** Browser Bridge ships raw offensive primitives (replay, fuzz,
  intercept, cookie/JWT tooling) *by design* - analogous to Burp Suite. Using them against a target you are not
  authorized to test is the operator's responsibility, not a vulnerability in this project. See the
  **Security & responsible use** and **Disclaimer** sections of the README.
- Findings that require the attacker to already control the local user account running the bridge.
