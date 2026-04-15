import WebSocket from "ws";
import type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
} from "./schema/frames.js";

let requestCounter = 0;

export class MoltZapTestClient {
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    {
      resolve: (v: ResponseFrame) => void;
      reject: (e: Error) => void;
    }
  >();
  private events: EventFrame[] = [];
  private eventWaiters: Array<{
    eventName: string;
    resolve: (v: EventFrame) => void;
    reject: (e: Error) => void;
  }> = [];

  constructor(
    private baseUrl: string,
    private wsUrl: string,
  ) {}

  /** Register a new agent via HTTP. */
  async register(
    name: string,
    opts?: { description?: string; inviteCode?: string },
  ): Promise<{
    agentId: string;
    apiKey: string;
    claimUrl: string;
    claimToken: string;
  }> {
    const body: Record<string, string> = { name };
    if (opts?.description) body.description = opts.description;
    if (opts?.inviteCode) body.inviteCode = opts.inviteCode;

    const res = await fetch(`${this.baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Register failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{
      agentId: string;
      apiKey: string;
      claimUrl: string;
      claimToken: string;
    }>;
  }

  /** Open a WebSocket and send auth/connect with an API key. */
  async connect(apiKey: string): Promise<unknown> {
    return this.connectWithParams({
      agentKey: apiKey,
      minProtocol: "0.1.0",
      maxProtocol: "0.1.0",
    });
  }

  /** Open a WebSocket and send auth/connect with a JWT. */
  async connectJwt(jwt: string): Promise<unknown> {
    return this.connectWithParams({
      jwt,
      minProtocol: "0.1.0",
      maxProtocol: "0.1.0",
    });
  }

  private async connectWithParams(
    params: Record<string, string>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);

      ws.on("open", async () => {
        this.ws = ws;
        try {
          const result = await this.rpc("auth/connect", params);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === "response" && msg.id) {
          const waiter = this.pending.get(msg.id);
          if (waiter) {
            this.pending.delete(msg.id);
            waiter.resolve(msg as ResponseFrame);
          }
        } else if (msg.type === "event") {
          const event = msg as EventFrame;

          // Deliver to first matching waiter, or buffer if none
          let consumed = false;
          for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
            if (this.eventWaiters[i]!.eventName === event.event) {
              this.eventWaiters[i]!.resolve(event);
              this.eventWaiters.splice(i, 1);
              consumed = true;
              break;
            }
          }
          if (!consumed) {
            this.events.push(event);
          }
        }
      });

      ws.on("error", (err) => {
        reject(err);
      });

      ws.on("close", () => {
        // Reject all pending requests
        for (const [, waiter] of this.pending) {
          waiter.reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
        this.ws = null;
      });
    });
  }

  /** Send a JSON-RPC request and wait for the response. */
  async rpc(method: string, params?: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    const id = `req-${++requestCounter}`;
    const frame: RequestFrame = {
      jsonrpc: "2.0",
      type: "request",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, 10_000);

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          if (resp.error) {
            const err = new Error(resp.error.message) as Error & {
              code: number;
              data?: unknown;
            };
            err.code = resp.error.code;
            if (resp.error.data !== undefined) {
              err.data = resp.error.data;
            }
            reject(err);
          } else {
            resolve(resp.result);
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  /** Wait for a specific event type. */
  async waitForEvent(eventName: string, timeoutMs = 5000): Promise<EventFrame> {
    // Check already-collected events
    const idx = this.events.findIndex((e) => e.event === eventName);
    if (idx !== -1) {
      return this.events.splice(idx, 1)[0]!;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.eventWaiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) this.eventWaiters.splice(i, 1);
        reject(new Error(`Timeout waiting for event: ${eventName}`));
      }, timeoutMs);

      this.eventWaiters.push({
        eventName,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /** Return all collected events and clear the buffer. */
  drainEvents(): EventFrame[] {
    const events = [...this.events];
    this.events = [];
    return events;
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
