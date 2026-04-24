/**
 * Unit tests for `moltzap messages list` handler. Spec test-coverage floor:
 * one success + one RPC-failure path.
 */
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { messagesListHandler } from "./messages.js";
import {
  Transport,
  TransportRpcError,
  type Transport as TransportSurface,
  type TransportError,
} from "../transport.js";

type Call = { method: string; params: Record<string, unknown> };

const makeFakeTransport = (
  respond: (call: Call) => unknown | Error,
): { calls: Array<Call>; transport: TransportSurface } => {
  const calls: Array<Call> = [];
  const transport: TransportSurface = {
    kind: "test",
    rpc: <Result>(
      method: string,
      params: Record<string, unknown>,
    ): Effect.Effect<Result, TransportError> => {
      calls.push({ method, params });
      const out = respond({ method, params });
      if (out instanceof Error) {
        return Effect.fail(
          new TransportRpcError({ method, code: -32000, message: out.message }),
        );
      }
      return Effect.succeed(out as Result);
    },
  };
  return { calls, transport };
};

describe("messages list", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls messages/list with { conversationId, limit? } and emits one line per message", async () => {
    const { calls, transport } = makeFakeTransport(() => ({
      messages: [
        {
          id: "m1",
          seq: 1,
          senderId: "a1",
          senderName: "alice",
          createdAt: "2026-04-24T00:00:00Z",
          parts: [{ type: "text", text: "hello" }],
        },
        {
          id: "m2",
          seq: 2,
          senderId: "b1",
          senderName: "bob",
          createdAt: "2026-04-24T00:00:01Z",
          parts: [{ type: "text", text: "hi" }],
        },
      ],
      hasMore: false,
    }));
    await Effect.runPromise(
      messagesListHandler({ conversationId: "c1", limit: 50 }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: "messages/list",
      params: { conversationId: "c1", limit: 50 },
    });
    expect(stdout).toHaveBeenCalledTimes(2);
  });

  it("omits limit when absent", async () => {
    const { calls, transport } = makeFakeTransport(() => ({
      messages: [],
      hasMore: false,
    }));
    await Effect.runPromise(
      messagesListHandler({ conversationId: "c1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]?.params).toEqual({ conversationId: "c1" });
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("fail"));
    const result = await Effect.runPromiseExit(
      messagesListHandler({ conversationId: "c1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});
