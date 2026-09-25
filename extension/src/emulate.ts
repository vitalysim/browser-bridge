/// <reference types="chrome" />
// Environment emulation via CDP (chrome.debugger). The SERVER resolves presets to concrete
// metrics/throughput and passes them here; this file only issues the CDP overrides. It remembers, per
// tab, which overrides are live so emulate_reset can report what it undid - but reset clears every
// override unconditionally regardless, so a lost map (service-worker eviction, which also detaches the
// debugger and drops the overrides anyway) can never strand one. Overrides also revert when the
// debugger detaches (idle sweep after ~5 min, DevTools opened, or debugger_detach).

// cmd(tabId, method, params) - the CDP sendCommand wrapper from background.ts, passed in to avoid a
// circular import. ensureAttached(tabId) is called by the dispatch case before these run.
type CmdFn = (tabId: number, method: string, params?: any) => Promise<any>;

interface Applied {
  device?: boolean;
  touch?: boolean;
  userAgent?: boolean;
  network?: boolean;
  cpu?: boolean;
  locale?: boolean;
  timezone?: boolean;
  acceptLanguage?: boolean;
  geolocation?: boolean;
}
const applied = new Map<number, Applied>();
function mark(tabId: number, ...keys: (keyof Applied)[]) {
  const a = applied.get(tabId) ?? {};
  for (const k of keys) a[k] = true;
  applied.set(tabId, a);
}

export interface DeviceParams {
  metrics: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  touch: boolean;
  userAgent?: string;
  preset?: string | null;
}

export async function emulateDevice(tabId: number, params: DeviceParams, cmd: CmdFn): Promise<any> {
  await cmd(tabId, "Emulation.setDeviceMetricsOverride", { ...params.metrics });
  await cmd(tabId, "Emulation.setTouchEmulationEnabled", { enabled: !!params.touch });
  if (params.userAgent) {
    await cmd(tabId, "Network.enable");
    await cmd(tabId, "Network.setUserAgentOverride", { userAgent: params.userAgent });
  }
  mark(tabId, "device", "touch");
  if (params.userAgent) mark(tabId, "userAgent");
  return {
    tabId,
    applied: "device",
    preset: params.preset ?? null,
    ...params.metrics,
    touch: !!params.touch,
    userAgent: params.userAgent ?? null,
  };
}

export interface NetworkParams {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
  preset?: string | null;
}

export async function emulateNetwork(tabId: number, params: NetworkParams, cmd: CmdFn): Promise<any> {
  await cmd(tabId, "Network.enable");
  await cmd(tabId, "Network.emulateNetworkConditions", {
    offline: !!params.offline,
    latency: params.latency,
    downloadThroughput: params.downloadThroughput,
    uploadThroughput: params.uploadThroughput,
  });
  mark(tabId, "network");
  return {
    tabId,
    applied: "network",
    preset: params.preset ?? null,
    offline: !!params.offline,
    latency: params.latency,
    downloadThroughput: params.downloadThroughput,
    uploadThroughput: params.uploadThroughput,
  };
}

export async function emulateCpu(tabId: number, rate: number, cmd: CmdFn): Promise<any> {
  await cmd(tabId, "Emulation.setCPUThrottlingRate", { rate });
  mark(tabId, "cpu");
  return { tabId, applied: "cpu", rate };
}

export interface LocaleParams {
  locale?: string;
  timezoneId?: string;
  acceptLanguage?: string;
}

export async function emulateLocale(tabId: number, params: LocaleParams, cmd: CmdFn): Promise<any> {
  if (params.locale != null) {
    await cmd(tabId, "Emulation.setLocaleOverride", { locale: params.locale });
    mark(tabId, "locale");
  }
  if (params.timezoneId != null) {
    await cmd(tabId, "Emulation.setTimezoneOverride", { timezoneId: params.timezoneId });
    mark(tabId, "timezone");
  }
  if (params.acceptLanguage != null) {
    await cmd(tabId, "Network.enable");
    await cmd(tabId, "Network.setExtraHTTPHeaders", { headers: { "Accept-Language": params.acceptLanguage } });
    mark(tabId, "acceptLanguage");
  }
  return {
    tabId,
    applied: "locale",
    locale: params.locale ?? null,
    timezoneId: params.timezoneId ?? null,
    acceptLanguage: params.acceptLanguage ?? null,
  };
}

export interface GeolocationParams {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  clear?: boolean;
}

export async function emulateGeolocation(tabId: number, params: GeolocationParams, cmd: CmdFn): Promise<any> {
  if (params.clear) {
    await cmd(tabId, "Emulation.clearGeolocationOverride");
    const a = applied.get(tabId);
    if (a) delete a.geolocation;
    return { tabId, applied: "geolocation", cleared: true };
  }
  const accuracy = params.accuracy ?? 100;
  await cmd(tabId, "Emulation.setGeolocationOverride", {
    latitude: params.latitude,
    longitude: params.longitude,
    accuracy,
  });
  mark(tabId, "geolocation");
  return { tabId, applied: "geolocation", latitude: params.latitude, longitude: params.longitude, accuracy };
}

// Clear ALL overrides unconditionally (each is a harmless no-op if it was never set), so a tab returns
// to normal even after the `applied` map was lost. `wasApplied` reports what this session had tracked.
export async function emulateReset(tabId: number, cmd: CmdFn): Promise<any> {
  const wasApplied = Object.keys(applied.get(tabId) ?? {});
  await cmd(tabId, "Emulation.clearDeviceMetricsOverride");
  await cmd(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
  await cmd(tabId, "Emulation.setCPUThrottlingRate", { rate: 1 });
  await cmd(tabId, "Emulation.clearGeolocationOverride");
  // Empty string / object clears these overrides (CDP restores the host default).
  await cmd(tabId, "Emulation.setLocaleOverride", {});
  await cmd(tabId, "Emulation.setTimezoneOverride", { timezoneId: "" });
  await cmd(tabId, "Network.enable");
  await cmd(tabId, "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cmd(tabId, "Network.setExtraHTTPHeaders", { headers: {} });
  await cmd(tabId, "Network.setUserAgentOverride", { userAgent: "" });
  applied.delete(tabId);
  return { tabId, reset: true, wasApplied };
}
