/**
 * Unit tests for `moltzap messages list` handler. Spec test-coverage floor:
 * one success + one RPC-failure path.
 */
import { Effect } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { messagesListHandler } from "./messages.js";
import { Transport } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";

import { MessagesList } from "@moltzap/protocol";

describe("messages list", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls messages/list with { conversationId, limit? } and emits one line per message", async () => {
    // Fixture matches the `messages/list` result shape: every required
    // `MessageSchema` field is present (including `conversationId`).
    // `senderName` is the CLI display fallback the handler reads; it is
    // not part of `MessageSchema` itself (see WireMessage in messages.ts).
    const SENDER_A = "00000000-0000-4000-8000-0000000000a1";
    const SENDER_B = "00000000-0000-4000-8000-0000000000b1";
    const { calls, transport } = makeFakeTransport(() => ({
      messages: [
        {
          id: "00000000-0000-4000-8000-00000000000a",
          conversationId: "00000000-0000-4000-8000-00000000000c",
          senderId: SENDER_A,
          createdAt: "2026-04-24T00:00:00Z",
          parts: [{ type: "text", text: "hello" }],
        },
        {
          id: "00000000-0000-4000-8000-00000000000b",
          conversationId: "00000000-0000-4000-8000-00000000000c",
          senderId: SENDER_B,
          createdAt: "2026-04-24T00:00:01Z",
          parts: [{ type: "text", text: "hi" }],
        },
      ],
      hasMore: false,
    }));
    await Effect.runPromise(
      messagesListHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
        limit: 50,
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls[0]).toEqual({
      method: MessagesList.name,
      params: {
        conversationId: "00000000-0000-4000-8000-00000000000c",
        limit: 50,
      },
    });
    expect(stdout).toHaveBeenCalledTimes(2);
    // Regression #216: first column is `createdAt`, never `undefined`.
    // MessageSchema has no `seq` field; the previous output stringified
    // `m.seq` as the literal "undefined" in the leading column.
    const firstLine = String(stdout.mock.calls[0]?.[0] ?? "");
    expect(firstLine.startsWith("undefined\t")).toBe(false);
    expect(firstLine).toBe(`2026-04-24T00:00:00Z\t${SENDER_A}\thello`);
  });

  it("omits limit when absent", async () => {
    const { calls, transport } = makeFakeTransport(() => ({
      messages: [],
      hasMore: false,
    }));
    await Effect.runPromise(
      messagesListHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls[0]?.params).toEqual({
      conversationId: "00000000-0000-4000-8000-00000000000c",
    });
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("fail"));
    const result = await Effect.runPromiseExit(
      messagesListHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(result._tag).toBe("Failure");
  });
});
