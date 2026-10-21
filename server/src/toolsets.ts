// Opt-in tool-surface trimming. Every registered tool's description + schema is sent to the agent on
// every session, so a client that never fuzzes or records pays for those tools anyway. BRIDGE_TOOLSETS
// (comma list) registers only the chosen groups; unset (or "all") keeps every tool, which is the
// default so existing setups see no change. Behaviour of a registered tool is never altered.

export const TOOLSETS = ["core", "devtools", "security", "watch", "record", "emulate"] as const;
export type Toolset = (typeof TOOLSETS)[number];

// The ONE classification table. A tool missing from it falls into "core" (so a newly added tool is
// never silently hidden); a test asserts every currently registered tool is listed here explicitly.
export const TOOL_GROUPS: Readonly<Record<string, Toolset>> = {
  // core: tabs, navigation, reading, interaction, page-level utilities
  tabs_list: "core",
  tab_new: "core",
  tab_activate: "core",
  tab_close: "core",
  navigate: "core",
  go_back: "core",
  go_forward: "core",
  get_page_text: "core",
  snapshot: "core",
  ax_snapshot: "core",
  click: "core",
  fill: "core",
  hover: "core",
  type: "core",
  press_key: "core",
  input: "core",
  scroll: "core",
  wait_for: "core",
  file_upload: "core",
  paste_html: "core",
  paste_image: "core",
  screenshot: "core",
  download_resource: "core",
  save_page: "core",
  eval_js: "core",
  cdp_eval: "core",
  debugger_detach: "core",
  debugger_status: "core",
  bridge_status: "core",
  browser_batch: "core",
  // devtools: network/console capture, cookies, storage, HAR/curl export
  net_capture_start: "devtools",
  net_get_requests: "devtools",
  net_get_body: "devtools",
  net_get_ws_frames: "devtools",
  console_start: "devtools",
  console_get: "devtools",
  console_stop: "devtools",
  cookies_get: "devtools",
  cookies_set: "devtools",
  cookies_delete: "devtools",
  storage_dump: "devtools",
  storage_set: "devtools",
  storage_remove: "devtools",
  storage_clear: "devtools",
  export_har: "devtools",
  request_to_curl: "devtools",
  // security: identities, replay, authz, interception, fuzzing, passive analysis
  identity_capture: "security",
  identity_list: "security",
  identity_purge: "security",
  replay_request: "security",
  authz_matrix: "security",
  response_diff: "security",
  intercept_start: "security",
  intercept_pending: "security",
  intercept_resolve: "security",
  intercept_stop: "security",
  fuzz: "security",
  analyze: "security",
  jwt_decode: "security",
  // watch mode
  watch_start: "watch",
  watch_read: "watch",
  watch_status: "watch",
  watch_stop: "watch",
  watch_detail: "watch",
  // recording + playbooks
  playbook_record_start: "record",
  playbook_record_stop: "record",
  playbook_save: "record",
  session_record_start: "record",
  session_record_stop: "record",
  session_record_status: "record",
  render_recording_video: "record",
  // environment emulation
  emulate_device: "emulate",
  emulate_network: "emulate",
  emulate_cpu: "emulate",
  emulate_locale: "emulate",
  emulate_geolocation: "emulate",
  emulate_reset: "emulate",
};

export function groupOf(tool: string): Toolset {
  return TOOL_GROUPS[tool] ?? "core";
}

export interface ToolsetSelection {
  /** null = every group (the default). */
  enabled: ReadonlySet<Toolset> | null;
  unknown: string[];
}

/**
 * Parse BRIDGE_TOOLSETS. Unset, empty or "all" selects everything. "core" is always included: without
 * tabs/navigation/snapshot no other group is usable. Unknown names are reported, not fatal.
 */
export function parseToolsets(raw: string | undefined): ToolsetSelection {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!names.length || names.includes("all")) return { enabled: null, unknown: [] };
  const enabled = new Set<Toolset>(["core"]);
  const unknown: string[] = [];
  for (const n of names) {
    if ((TOOLSETS as readonly string[]).includes(n)) enabled.add(n as Toolset);
    else unknown.push(n);
  }
  return { enabled, unknown };
}

export function isToolEnabled(tool: string, sel: ToolsetSelection): boolean {
  return sel.enabled === null || sel.enabled.has(groupOf(tool));
}
