// Environment emulation (device / network / locale / geolocation) via CDP.
// Pure mapping lives here (preset name -> concrete metrics/throughput) so it is unit-testable and the
// extension side stays a thin CDP-command applier: the server resolves presets to numbers and hands
// the extension only concrete values. See docs/EMULATION.md.
import { z } from "zod";
import type { ExtensionHub } from "./hub.js";

// The tool() closure registerTools() hands us - same signature as the local helper there.
type ToolFn = (
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (args: any, extra?: any) => Promise<any>
) => void;

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const tabIdParam = z.number().optional().describe("Target tab id (from tabs_list). Defaults to the active tab.");

// ---- device presets ----
// Concrete metrics + a matching UA string. Client-hints userAgentMetadata is deliberately omitted
// (see docs/EMULATION.md "Client hints"): a partial metadata object blanks navigator.userAgentData,
// so we ship the UA string alone, which is the standard fallback.
export interface DevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const androidUA = (android: string, model: string) =>
  `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36`;

// Keys are already normalized (lowercase, alphanumeric only) so "iPhone 15", "iphone-15" and
// "iphone15" all resolve. Values chosen to match Chrome DevTools / Playwright device metrics.
export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  iphone15: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: IPHONE_UA },
  iphone15promax: { width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: IPHONE_UA },
  iphonese: {
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  },
  pixel8: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: androidUA("14", "Pixel 8") },
  pixel7: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: androidUA("13", "Pixel 7") },
  galaxys23: { width: 360, height: 780, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: androidUA("13", "SM-S911B") },
  ipad: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPAD_UA },
  ipadpro: { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPAD_UA },
  // A plain desktop viewport - no UA override, so the real desktop UA is kept.
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
};

// ---- network presets ----
// Throughput is bytes/second, latency milliseconds - the units Network.emulateNetworkConditions wants.
// slow-3g / fast-3g match Puppeteer's PredefinedNetworkConditions; wifi is a fast home connection.
export interface NetworkConditions {
  offline: boolean;
  latency: number;
  downloadThroughput: number; // bytes/s, -1 = unthrottled
  uploadThroughput: number; // bytes/s, -1 = unthrottled
}

export const NETWORK_PRESETS: Record<string, NetworkConditions> = {
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  slow3g: { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  fast3g: { offline: false, latency: 562.5, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  wifi: { offline: false, latency: 2, downloadThroughput: 3_750_000, uploadThroughput: 1_875_000 },
};

/** Normalize a preset name for lookup: lowercase, strip everything but a-z0-9. */
export function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** kilobits/second -> bytes/second (kilo = 1000, as network tooling reports it). */
export function kbpsToBytesPerSec(kbps: number): number {
  return Math.round((kbps * 1000) / 8);
}

export interface DeviceInput {
  preset?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  userAgent?: string;
  touch?: boolean;
}

export interface ResolvedDevice {
  metrics: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  touch: boolean;
  userAgent?: string;
  preset: string | null;
}

/** Merge a named preset with explicit fields (explicit wins). Throws on an unknown preset or when
 *  width/height are missing with no preset to supply them. */
export function resolveDevice(input: DeviceInput): ResolvedDevice {
  let preset: DevicePreset | undefined;
  let presetName: string | null = null;
  if (input.preset != null && input.preset !== "") {
    const key = normalizeKey(input.preset);
    preset = DEVICE_PRESETS[key];
    if (!preset) throw new Error(`Unknown device preset "${input.preset}". Known: ${Object.keys(DEVICE_PRESETS).join(", ")}.`);
    presetName = key;
  }
  const width = input.width ?? preset?.width;
  const height = input.height ?? preset?.height;
  if (width == null || height == null) {
    throw new Error("emulate_device needs width and height (or a preset that provides them).");
  }
  const mobile = input.mobile ?? preset?.mobile ?? false;
  return {
    metrics: {
      width,
      height,
      deviceScaleFactor: input.deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1,
      mobile,
    },
    // A mobile device is touch by default; explicit touch always wins.
    touch: input.touch ?? preset?.touch ?? mobile,
    userAgent: input.userAgent ?? preset?.userAgent,
    preset: presetName,
  };
}

export interface NetworkInput {
  preset?: string;
  offline?: boolean;
  downloadKbps?: number;
  uploadKbps?: number;
  latencyMs?: number;
}

export interface ResolvedNetwork extends NetworkConditions {
  preset: string | null;
}

/** Resolve a preset and/or explicit throttle fields to concrete Network.emulateNetworkConditions
 *  params. Explicit fields override the preset. With no preset the base is "unthrottled". Throws on an
 *  unknown preset, or when nothing at all was specified. */
export function resolveNetwork(input: NetworkInput): ResolvedNetwork {
  let base: NetworkConditions;
  let presetName: string | null = null;
  if (input.preset != null && input.preset !== "") {
    const key = normalizeKey(input.preset);
    const p = NETWORK_PRESETS[key];
    if (!p) throw new Error(`Unknown network preset "${input.preset}". Known: ${Object.keys(NETWORK_PRESETS).join(", ")}.`);
    base = { ...p };
    presetName = key;
  } else {
    base = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  }
  const hasExplicit =
    input.offline !== undefined ||
    input.downloadKbps !== undefined ||
    input.uploadKbps !== undefined ||
    input.latencyMs !== undefined;
  if (!presetName && !hasExplicit) {
    throw new Error("emulate_network needs a preset or at least one of offline/downloadKbps/uploadKbps/latencyMs.");
  }
  if (input.offline !== undefined) base.offline = input.offline;
  if (input.downloadKbps !== undefined) base.downloadThroughput = kbpsToBytesPerSec(input.downloadKbps);
  if (input.uploadKbps !== undefined) base.uploadThroughput = kbpsToBytesPerSec(input.uploadKbps);
  if (input.latencyMs !== undefined) base.latency = input.latencyMs;
  return { ...base, preset: presetName };
}

export function registerEmulateTools(tool: ToolFn, hub: ExtensionHub) {
  tool(
    "emulate_device",
    'Emulate a device viewport on a tab via CDP (shows the debugging banner): sets width/height/DPR/mobile, touch, and a User-Agent override when given. Pass a preset (e.g. "iPhone 15", "Pixel 8", "iPad") or explicit metrics; explicit fields override the preset.',
    {
      preset: z.string().optional().describe('Named device (e.g. "iPhone 15", "Pixel 8", "iPad", "desktop"); explicit fields below override it'),
      width: z.number().optional().describe("Viewport CSS width (required if no preset)"),
      height: z.number().optional().describe("Viewport CSS height (required if no preset)"),
      deviceScaleFactor: z.number().optional().describe("Device pixel ratio (default 1)"),
      mobile: z.boolean().optional().describe("Mobile viewport/meta handling (default from preset, else false)"),
      userAgent: z.string().optional().describe("User-Agent string override (applied via Network.setUserAgentOverride)"),
      touch: z.boolean().optional().describe("Touch event emulation (default: true when mobile)"),
      tabId: tabIdParam,
    },
    async ({ preset, width, height, deviceScaleFactor, mobile, userAgent, touch, tabId }) => {
      const r = resolveDevice({ preset, width, height, deviceScaleFactor, mobile, userAgent, touch });
      return ok(await hub.call("emulate_device", { ...r, tabId }));
    }
  );

  tool(
    "emulate_network",
    "Throttle or take a tab offline via CDP (shows the banner). Use a preset (slow-3g, fast-3g, wifi, offline) or explicit offline/downloadKbps/uploadKbps/latencyMs; explicit values override the preset.",
    {
      preset: z.string().optional().describe("slow-3g | fast-3g | wifi | offline"),
      offline: z.boolean().optional().describe("Take the tab fully offline"),
      downloadKbps: z.number().optional().describe("Download cap in kilobits/second"),
      uploadKbps: z.number().optional().describe("Upload cap in kilobits/second"),
      latencyMs: z.number().optional().describe("Added latency (RTT) in milliseconds"),
      tabId: tabIdParam,
    },
    async ({ preset, offline, downloadKbps, uploadKbps, latencyMs, tabId }) => {
      const r = resolveNetwork({ preset, offline, downloadKbps, uploadKbps, latencyMs });
      return ok(await hub.call("emulate_network", { ...r, tabId }));
    }
  );

  tool(
    "emulate_cpu",
    "Throttle a tab's CPU via CDP (shows the banner). rate is the slowdown multiplier (1 = no throttle, 4 = 4x slower).",
    { rate: z.number().min(1).describe("CPU slowdown multiplier (1 = none, 4 = 4x slower)"), tabId: tabIdParam },
    async ({ rate, tabId }) => ok(await hub.call("emulate_cpu", { rate, tabId }))
  );

  tool(
    "emulate_locale",
    "Override a tab's locale, timezone, and/or Accept-Language via CDP (shows the banner). Pass at least one of locale, timezoneId, acceptLanguage.",
    {
      locale: z.string().optional().describe('ICU locale, e.g. "fr-FR" or "ja_JP"'),
      timezoneId: z.string().optional().describe('IANA timezone, e.g. "Europe/Paris"'),
      acceptLanguage: z.string().optional().describe('Accept-Language header, e.g. "fr-FR,fr;q=0.9"'),
      tabId: tabIdParam,
    },
    async ({ locale, timezoneId, acceptLanguage, tabId }) => {
      if (locale == null && timezoneId == null && acceptLanguage == null) {
        throw new Error("emulate_locale needs at least one of locale, timezoneId, acceptLanguage.");
      }
      return ok(await hub.call("emulate_locale", { locale, timezoneId, acceptLanguage, tabId }));
    }
  );

  tool(
    "emulate_geolocation",
    "Override a tab's geolocation via CDP (shows the banner), or clear:true to remove the override. The page's own geolocation permission still applies.",
    {
      latitude: z.number().min(-90).max(90).optional().describe("Latitude (-90..90)"),
      longitude: z.number().min(-180).max(180).optional().describe("Longitude (-180..180)"),
      accuracy: z.number().optional().describe("Accuracy in meters (default 100)"),
      clear: z.boolean().optional().describe("Remove the geolocation override instead of setting it"),
      tabId: tabIdParam,
    },
    async ({ latitude, longitude, accuracy, clear, tabId }) => {
      if (!clear && (latitude == null || longitude == null)) {
        throw new Error("emulate_geolocation needs latitude and longitude (or clear:true).");
      }
      return ok(await hub.call("emulate_geolocation", { latitude, longitude, accuracy, clear, tabId }));
    }
  );

  tool(
    "emulate_reset",
    "Clear all environment emulation on a tab (device metrics, touch, UA, network, CPU, locale, timezone, geolocation), returning it to normal.",
    { tabId: tabIdParam },
    async ({ tabId }) => ok(await hub.call("emulate_reset", { tabId }))
  );
}
