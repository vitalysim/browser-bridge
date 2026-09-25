# Environment emulation

Drive a page as a specific device / network / locale / place. This is the same capability Chrome
DevTools and Playwright expose (mobile viewport, throttled 3G, a foreign timezone, a GPS coordinate),
implemented over the extension's existing `chrome.debugger` (CDP) session.

All of these tools **attach the debugger**, so the tab shows Chrome's *"started debugging this
browser"* banner while an override is live. They target a tab (`tabId`, or the active tab) and
auto-attach on first use, exactly like `net_capture_start` / `cdp_eval`.

## Lifecycle (read this)

Overrides are **in-memory, per tab, and transient**. They stay in effect while you keep using the tab,
and are dropped when the debugger detaches — which happens on `debugger_detach`, when the idle sweep
tears down an unused session (~5 min), if you open DevTools on the tab, or if the MV3 service worker is
evicted. Call `emulate_reset` to return a tab to normal explicitly. Emulation does **not** pin the
session open the way an active capture does, so a long idle gap will quietly revert it.

## Tools

### `emulate_device`

Set the viewport, DPR, mobile flag, touch emulation, and (optionally) a User-Agent string.

```jsonc
emulate_device({ preset: "iPhone 15" })
emulate_device({ width: 1440, height: 900, deviceScaleFactor: 2 })
emulate_device({ preset: "Pixel 8", width: 360 })   // explicit fields override the preset
```

Pass a `preset` (matched case/space/dash-insensitively) or explicit metrics; with no preset, `width`
and `height` are required. Explicit fields win over the preset. `touch` defaults to `true` when the
device is mobile.

| Preset | Viewport | DPR | Mobile |
|---|---|---|---|
| `iPhone 15` | 393 × 852 | 3 | ✓ |
| `iPhone 15 Pro Max` | 430 × 932 | 3 | ✓ |
| `iPhone SE` | 375 × 667 | 2 | ✓ |
| `Pixel 8` | 412 × 915 | 2.625 | ✓ |
| `Pixel 7` | 412 × 915 | 2.625 | ✓ |
| `Galaxy S23` | 360 × 780 | 3 | ✓ |
| `iPad` | 820 × 1180 | 2 | ✓ |
| `iPad Pro` | 1024 × 1366 | 2 | ✓ |
| `desktop` | 1280 × 800 | 1 | — |

Each mobile preset carries a matching UA string; `desktop` keeps the real UA.

**Client hints.** The UA string is applied via `Network.setUserAgentOverride`. A matching
`userAgentMetadata` (the `navigator.userAgentData` client-hints object) is **not** set: a partial
metadata object blanks the site's client-hint reads, which is worse than leaving the real one in place.
UA-string override + metrics is the standard fallback and covers the common cases. Full client-hints
metadata is a known refinement.

### `emulate_network`

Throttle bandwidth/latency or take the tab fully offline.

```jsonc
emulate_network({ preset: "slow-3g" })
emulate_network({ offline: true })
emulate_network({ downloadKbps: 5000, uploadKbps: 1000, latencyMs: 40 })
```

Use a `preset` or explicit fields (explicit wins). `downloadKbps`/`uploadKbps` are kilobits/second and
are converted to the bytes/second CDP wants.

| Preset | Download | Upload | Latency |
|---|---|---|---|
| `slow-3g` | 50 KB/s | 50 KB/s | 2000 ms |
| `fast-3g` | 180 KB/s | ~84 KB/s | ~563 ms |
| `wifi` | 3.75 MB/s | 1.88 MB/s | 2 ms |
| `offline` | — | — | offline |

Throttling only affects traffic sent *after* the call — reload the tab to see a page load under the new
conditions. (`slow-3g` / `fast-3g` match Puppeteer's predefined network conditions.)

### `emulate_cpu`

```jsonc
emulate_cpu({ rate: 4 })   // 4x slower; rate 1 = no throttle
```

`rate` is the slowdown multiplier passed to `Emulation.setCPUThrottlingRate`.

### `emulate_locale`

Override any of the tab's locale, timezone, and `Accept-Language`. Pass at least one.

```jsonc
emulate_locale({ locale: "fr-FR", timezoneId: "Europe/Paris", acceptLanguage: "fr-FR,fr;q=0.9" })
```

`locale` drives `Intl` / `navigator.language`, `timezoneId` (an IANA id) drives `Date`, and
`acceptLanguage` is sent as an extra request header.

### `emulate_geolocation`

```jsonc
emulate_geolocation({ latitude: 48.8566, longitude: 2.3522, accuracy: 50 })
emulate_geolocation({ clear: true })
```

Sets (or clears) the coordinate returned to `navigator.geolocation`. The page's geolocation
**permission still applies** — this overrides the *position*, it does not grant the page access.

### `emulate_reset`

```jsonc
emulate_reset({ tabId })
```

Clears **every** override above (device metrics, touch, UA, network, CPU, locale, timezone,
geolocation, Accept-Language) so the tab returns to normal. It issues all clears unconditionally, so it
is thorough even if the per-tab tracking was lost to a service-worker eviction; `wasApplied` reports
what this session had recorded. The debugger stays attached (banner remains) until the idle sweep or
`debugger_detach` removes it.

## Notes

- These are separate CDP overrides, so they compose: apply a device, a network profile, and a locale on
  the same tab and all three hold.
- Emulation tools are **not** part of `browser_batch`'s allowlist — like the other debugger-attaching
  tools, each keeps its own per-call approval.
