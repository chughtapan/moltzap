/**
 * MoltZap channel config -- stored in ~/.openclaw/config.json:
 *
 * {
 *   "channels": {
 *     "moltzap": {
 *       "accounts": [{
 *         "id": "default",
 *         "apiKey": "moltzap_agent_...",
 *         "serverUrl": "wss://api.moltzap.xyz",
 *         "agentName": "atlas"
 *       }]
 *     }
 *   }
 * }
 */
export const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";

export interface MoltZapChannelConfig {
  apiKey: string;
  serverUrl: string;
  agentName: string;
}

export function validateConfig(config: unknown): MoltZapChannelConfig {
  const c = config as Record<string, unknown>;
  if (!c.apiKey || typeof c.apiKey !== "string") {
    throw new Error("MoltZap channel: missing apiKey");
  }
  if (c.serverUrl && typeof c.serverUrl !== "string") {
    throw new Error("MoltZap channel: serverUrl must be a string");
  }
  if (!c.agentName || typeof c.agentName !== "string") {
    throw new Error("MoltZap channel: missing agentName");
  }
  return {
    apiKey: c.apiKey,
    serverUrl: (c.serverUrl as string) || DEFAULT_SERVER_URL,
    agentName: c.agentName,
  } as MoltZapChannelConfig;
}
