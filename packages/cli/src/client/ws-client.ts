import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@moltzap/protocol";
import type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
  HelloOk,
} from "@moltzap/protocol";
import { getServerUrl } from "./config.js";

type EventHandler = (event: EventFrame) => void;

export interface WsClientOptions {
  autoReconnect?: boolean;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >();
  private eventHandlers: EventHandler[] = [];
  private closed = false;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 30_000;
  private auth: { jwt?: string; agentKey?: string } | null = null;
  private options: WsClientOptions;

  constructor(options?: WsClientOptions) {
    this.options = options ?? {};
  }

  async connect(auth: { jwt?: string; agentKey?: string }): Promise<HelloOk> {
    this.auth = auth;
    const url = getServerUrl() + "/ws";
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        const connectParams = auth.jwt
          ? {
              jwt: auth.jwt,
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
            }
          : {
              agentKey: auth.agentKey!,
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
            };

        this.rpc<HelloOk>("auth/connect", connectParams)
          .then((result) => {
            this.reconnectAttempt = 0;
            resolve(result);
          })
          .catch(reject);
      });

      this.ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as ResponseFrame | EventFrame;
        if (frame.type === "response") {
          const p = this.pending.get(frame.id);
          if (p) {
            this.pending.delete(frame.id);
            if (frame.error) {
              p.reject(
                new Error(`${frame.error.code}: ${frame.error.message}`),
              );
            } else {
              p.resolve(frame.result);
            }
          }
        } else if (frame.type === "event") {
          for (const handler of this.eventHandlers) {
            handler(frame);
          }
        }
      });

      this.ws.on("error", (err) => {
        reject(err);
      });

      this.ws.on("close", () => {
        for (const [, p] of this.pending) {
          p.reject(new Error("Connection closed"));
        }
        this.pending.clear();

        if (this.options.autoReconnect && !this.closed && this.auth) {
          this.scheduleReconnect();
        }
      });

      this.ws.on("ping", () => {
        this.ws?.pong();
      });
    });
  }

  async rpc<T>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const id = String(++this.requestId);
    const frame: RequestFrame = {
      jsonrpc: "2.0",
      type: "request",
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    const baseDelay = Math.min(
      1000 * 2 ** this.reconnectAttempt,
      this.maxReconnectDelay,
    );
    const jitter = baseDelay * (0.5 + Math.random() * 0.5);
    this.reconnectAttempt++;

    console.error(
      `Connection lost. Reconnecting in ${Math.round(jitter / 1000)}s...`,
    );

    setTimeout(async () => {
      if (this.closed || !this.auth) return;
      try {
        await this.connect(this.auth);
        console.error("Reconnected.");
      } catch {
        // connect failure triggers close, which schedules another reconnect
      }
    }, jitter);
  }
}
