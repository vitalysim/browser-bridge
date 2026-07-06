/// <reference types="chrome" />

const tokenInput = document.getElementById("token") as HTMLInputElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const STATUS_TEXT: Record<string, string> = {
  connected: "Connected to bridge server",
  connecting: "Connecting…",
  disconnected: "Disconnected — is the server running?",
  "no-token": "No token set — paste the server token below",
};

async function refresh() {
  const { bbStatus, bbDetail } = await chrome.storage.local.get(["bbStatus", "bbDetail"]);
  const status = bbStatus ?? "unknown";
  statusEl.className = status;
  statusEl.textContent = (STATUS_TEXT[status] ?? `status: ${status}`) + (bbDetail ? ` — ${bbDetail}` : "");
}

async function load() {
  const { token, port } = await chrome.storage.local.get({ token: "", port: 8765 });
  tokenInput.value = token;
  portInput.value = String(port);
  refresh();
}

document.getElementById("save")!.addEventListener("click", async () => {
  await chrome.storage.local.set({ token: tokenInput.value.trim(), port: Number(portInput.value) || 8765 });
  chrome.runtime.sendMessage({ cmd: "reconnect" });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bbStatus || changes.bbDetail)) refresh();
});

load();
