import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type RequestFrame,
  type EventFrame,
} from "@moltzap/protocol";

export interface WsClientLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface MoltZapWsClientOptions {
  serverUrl: string;
  agentKey: string;
  onEvent: (event: EventFrame) => void;
  onDisconnect: () => void;
  onReconnect: (helloOk: unknown) => void;
  logger?: WsClientLogger;
}

/**
 * WebSocket connection lifecycle:
 *
 *   connect -> auth/connect -> HelloOk -> active
 *       | (disconnect)
 *   backoff (1s, 2s, 4s, 8s, max 30s with jitter) -> reconnect -> auth/connect -> ...
 */
export class MoltZapWsClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 30_000;
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private requestCounter = 0;
  private closed = false;
  private _helloOk: unknown = null;

  constructor(private options: MoltZapWsClientOptions) {}

  get helloOk(): unknown {
    return this._helloOk;
  }

  async connect(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = this.options.serverUrl.replace(/^http/, "ws") + "/ws";
      this.ws = new WebSocket(url);

      this.ws.on("open", async () => {
        try {
          const helloOk = await this.sendRpc("auth/connect", {
            agentKey: this.options.agentKey,
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          });
          this._helloOk = helloOk;
          this.reconnectAttempt = 0;
          resolve(helloOk);
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame.type === "response" && frame.id) {
            const pending = this.pendingRequests.get(frame.id as string);
            if (pending) {
              this.pendingRequests.delete(frame.id as string);
              if (frame.error) {
                const err = frame.error as { message?: string };
                pending.reject(new Error(err.message ?? "RPC error"));
              } else {
                pending.resolve(frame.result);
              }
            }
          } else if (frame.type === "event") {
            this.options.onEvent(frame as unknown as EventFrame);
          }
        } catch {
          this.options.logger?.warn("Malformed frame:", data.toString());
        }
      });

      this.ws.on("close", () => {
        this.options.onDisconnect();
        if (!this.closed) this.scheduleReconnect();
      });

      this.ws.on("error", () => {
        // error is followed by close
      });
    });
  }

  async sendRpc(method: string, params?: unknown): Promise<unknown> {
    const attempt = () =>
      new Promise<unknown>((resolve, reject) => {
        const id = `rpc-${++this.requestCounter}`;
        const frame: RequestFrame = {
          jsonrpc: "2.0",
          type: "request",
          id,
          method,
          params,
        };

        this.pendingRequests.set(id, { resolve, reject });

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.pendingRequests.delete(id);
          reject(new Error("WebSocket not connected"));
          return;
        }

        this.ws.send(JSON.stringify(frame));

        setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`RPC timeout: ${method}`));
          }
        }, 30_000);
      });

    try {
      return await attempt();
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("RPC timeout:") &&
        method !== "auth/connect"
      ) {
        return attempt();
      }
      throw err;
    }
  }

  /** Close the socket permanently (no reconnection). */
  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  /** Close the socket without marking as permanently closed, triggering reconnection. */
  disconnect(): void {
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    const baseDelay = Math.min(
      1000 * 2 ** this.reconnectAttempt,
      this.maxReconnectDelay,
    );
    const jitter = baseDelay * (0.5 + Math.random() * 0.5);
    this.reconnectAttempt++;

    setTimeout(async () => {
      try {
        const helloOk = await this.connect();
        this.options.onReconnect(helloOk);
      } catch {
        // connect failed, will retry on close event
      }
    }, jitter);
  }
}
