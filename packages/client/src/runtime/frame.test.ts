import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeFrames } from "./frame.js";

describe("decodeFrames", () => {
  it("decodes padded chunks that contain both an event and a response", async () => {
    const raw =
      JSON.stringify({
        jsonrpc: "2.0",
        type: "event",
        event: "messages/received",
        data: { message: { id: "m-1", conversationId: "c-1" } },
      }) +
      "\u0000\n" +
      JSON.stringify({
        jsonrpc: "2.0",
        type: "response",
        direction: "c2s",
        id: "rpc-7",
        result: { ok: true },
      });

    const decoded = await Effect.runPromise(decodeFrames(raw));

    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({
      _tag: "Event",
      frame: { event: "messages/received" },
    });
    expect(decoded[1]).toMatchObject({
      _tag: "Response",
      id: "rpc-7",
      result: { ok: true },
    });
  });

  it("decodes traceparent from inbound s2c request frames", async () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      type: "request",
      direction: "s2c",
      id: "srv-trace-1",
      method: "apps/onJoin",
      params: { sessionId: "sess-trace" },
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });

    const decoded = await Effect.runPromise(decodeFrames(raw));

    expect(decoded).toEqual([
      {
        _tag: "ServerRequest",
        id: "srv-trace-1",
        method: "apps/onJoin",
        params: { sessionId: "sess-trace" },
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    ]);
  });
});
