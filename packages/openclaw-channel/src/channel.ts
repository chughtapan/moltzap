import { MoltZapWsClient } from "./ws-client.js";
import { validateConfig, type MoltZapChannelConfig } from "./config.js";
import { extractMessage, mapMessageToEnvelope } from "./mapping.js";
import type { EventFrame } from "@moltzap/protocol";

/**
 * OpenClaw Channel Plugin for MoltZap.
 *
 * Lifecycle:
 *   1. Gateway loads plugin, calls setup() with channel config
 *   2. Plugin connects to MoltZap server via WebSocket
 *   3. Incoming MoltZap messages are converted to InboundEnvelopes
 *   4. Outgoing OpenClaw responses are sent via messages/send RPC
 *   5. On disconnect, auto-reconnects with exponential backoff
 *
 * Config: ~/.openclaw/config.json -> channels.moltzap.accounts[].{apiKey,serverUrl,agentName}
 */
export class MoltZapChannelPlugin {
  private client: MoltZapWsClient | null = null;
  private config: MoltZapChannelConfig | null = null;
  private onInboundMessage:
    | ((envelope: ReturnType<typeof mapMessageToEnvelope>) => void)
    | null = null;

  get channelId() {
    return "moltzap";
  }

  async setup(
    rawConfig: unknown,
    onInbound: (envelope: ReturnType<typeof mapMessageToEnvelope>) => void,
  ) {
    this.config = validateConfig(rawConfig);
    this.onInboundMessage = onInbound;

    this.client = new MoltZapWsClient({
      serverUrl: this.config.serverUrl,
      agentKey: this.config.apiKey,
      onEvent: (event: EventFrame) => this.handleEvent(event),
      onDisconnect: () => {
        // Logged by ws-client, gateway handles presence
      },
      onReconnect: () => {
        // Logged by ws-client
      },
    });

    await this.client.connect();
  }

  async send(conversationId: string, text: string): Promise<void> {
    if (!this.client) throw new Error("MoltZap channel not connected");

    await this.client.sendRpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text }],
    });
  }

  async teardown(): Promise<void> {
    this.client?.close();
  }

  private handleEvent(event: EventFrame) {
    const message = extractMessage(event);
    if (message && this.onInboundMessage) {
      const envelope = mapMessageToEnvelope(message);
      this.onInboundMessage(envelope);
    }
  }
}
