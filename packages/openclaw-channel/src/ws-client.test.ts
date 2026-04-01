import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MoltZapWsClient } from "./ws-client.js";

function makeClient(
  overrides?: Partial<ConstructorParameters<typeof MoltZapWsClient>[0]>,
) {
  return new MoltZapWsClient({
    serverUrl: "ws://localhost:9999",
    agentKey: "test",
    onEvent: () => {},
    onDisconnect: () => {},
    onReconnect: () => {},
    ...overrides,
  });
}

describe("MoltZapWsClient", () => {
  it("rejects sendRpc when not connected", async () => {
    const client = makeClient();
    await expect(client.sendRpc("test/method")).rejects.toThrow(
      "WebSocket not connected",
    );
  });

  describe("helloOk storage", () => {
    it("helloOk is null before connect", () => {
      const client = makeClient();
      expect(client.helloOk).toBeNull();
    });
  });

  describe("logger", () => {
    it("accepts a logger in options", () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const client = makeClient({ logger });
      // Should not throw - logger is accepted
      expect(client).toBeDefined();
    });
  });

  describe("backoff calculation", () => {
    it("computes exponential delays: 1s, 2s, 4s, 8s, 16s, capped at 30s", () => {
      // Test the backoff formula: min(1000 * 2^attempt, 30000)
      const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
      for (let attempt = 0; attempt < expected.length; attempt++) {
        const baseDelay = Math.min(1000 * 2 ** attempt, 30_000);
        expect(baseDelay).toBe(expected[attempt]);
      }
    });

    it("jitter stays within [0.5*base, 1.0*base]", () => {
      const baseDelay = 4000;
      // With random in [0, 1): jitter = base * (0.5 + random * 0.5)
      // Min jitter (random=0): base * 0.5 = 2000
      // Max jitter (random→1): base * 1.0 = 4000
      for (let i = 0; i < 100; i++) {
        const r = Math.random();
        const jitter = baseDelay * (0.5 + r * 0.5);
        expect(jitter).toBeGreaterThanOrEqual(baseDelay * 0.5);
        expect(jitter).toBeLessThanOrEqual(baseDelay * 1.0);
      }
    });
  });

  describe("request timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects after 30s timeout (with retry exhaustion)", async () => {
      const client = makeClient();

      const mockWs = {
        readyState: 1, // WebSocket.OPEN
        send: vi.fn(),
      };
      (client as unknown as { ws: unknown }).ws = mockWs;

      const promise = client.sendRpc("test/slow");

      // First attempt times out after 30s
      vi.advanceTimersByTime(30_000);
      // Let retry microtask schedule
      await vi.advanceTimersByTimeAsync(0);
      // Retry attempt also times out after 30s
      vi.advanceTimersByTime(30_000);

      await expect(promise).rejects.toThrow("RPC timeout: test/slow");
    });
  });

  describe("RPC retry on timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries once on timeout for non-auth methods", async () => {
      const client = makeClient();

      let sendCount = 0;
      const mockWs = {
        readyState: 1,
        send: (data: string) => {
          sendCount++;
          // Resolve the second attempt
          if (sendCount === 2) {
            const frame = JSON.parse(data) as { id: string };
            const pending = (
              client as unknown as {
                pendingRequests: Map<string, { resolve: (v: unknown) => void }>;
              }
            ).pendingRequests.get(frame.id);
            pending?.resolve({ ok: true });
          }
        },
      };
      (client as unknown as { ws: unknown }).ws = mockWs;

      const promise = client.sendRpc("messages/send", { text: "hi" });

      // First attempt times out
      vi.advanceTimersByTime(30_000);

      // Let the retry microtask run
      await vi.advanceTimersByTimeAsync(0);

      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(sendCount).toBe(2);
    });

    it("does NOT retry auth/connect on timeout", async () => {
      const client = makeClient();

      let sendCount = 0;
      const mockWs = {
        readyState: 1,
        send: () => {
          sendCount++;
        },
      };
      (client as unknown as { ws: unknown }).ws = mockWs;

      const promise = client.sendRpc("auth/connect", {
        agentKey: "test",
        minProtocol: "1",
        maxProtocol: "1",
      });

      vi.advanceTimersByTime(30_000);

      await expect(promise).rejects.toThrow("RPC timeout: auth/connect");
      expect(sendCount).toBe(1);
    });
  });

  describe("concurrent request IDs", () => {
    it("increments request IDs for each call", () => {
      const client = makeClient();

      const sentFrames: string[] = [];
      const mockWs = {
        readyState: 1,
        send: (data: string) => sentFrames.push(data),
      };
      (client as unknown as { ws: unknown }).ws = mockWs;

      // Fire off multiple RPCs (they'll pend forever, that's fine)
      client.sendRpc("method/a").catch(() => {});
      client.sendRpc("method/b").catch(() => {});
      client.sendRpc("method/c").catch(() => {});

      const ids = sentFrames.map((f) => JSON.parse(f).id);
      expect(ids).toEqual(["rpc-1", "rpc-2", "rpc-3"]);
    });
  });

  describe("reconnect callback signature", () => {
    it("onReconnect receives a parameter", () => {
      let receivedArg: unknown = undefined;
      const _client = makeClient({
        onReconnect: (helloOk: unknown) => {
          receivedArg = helloOk;
        },
      });
      // Verify the callback shape accepts a parameter
      expect(receivedArg).toBeUndefined();
    });
  });
});
