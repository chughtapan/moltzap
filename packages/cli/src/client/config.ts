import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface MoltZapConfig {
  serverUrl: string;
  apiKey?: string;
  agentName?: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".moltzap");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: MoltZapConfig = {
  serverUrl: "wss://api.moltzap.xyz",
};

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function readConfig(): MoltZapConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as MoltZapConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(config: MoltZapConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function updateConfig(
  updater: (config: MoltZapConfig) => MoltZapConfig,
): void {
  const config = readConfig();
  writeConfig(updater(config));
}

export function getServerUrl(): string {
  return process.env.MOLTZAP_SERVER_URL ?? readConfig().serverUrl;
}

export function getHttpUrl(): string {
  const wsUrl = getServerUrl();
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

/** Resolve agent API key: MOLTZAP_API_KEY env var → config → fail. */
export function resolveAuth(): { agentKey: string } {
  const envKey = process.env.MOLTZAP_API_KEY;
  if (envKey) return { agentKey: envKey };
  const config = readConfig();
  if (config.apiKey) return { agentKey: config.apiKey };
  throw new Error("No agent registered. Run `moltzap register` first.");
}
