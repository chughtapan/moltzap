import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { expect } from "vitest";

import {
  InMemoryTraceCaptureLive,
  NoopTraceCaptureLive,
  TraceCaptureTag,
  type TraceEvent,
} from "./trace-capture.js";

const sampleEvent: TraceEvent = {
  _tag: "Message",
  message: {
    id: "message-1",
    conversationId: "conversation-1",
    senderId: "agent-1",
    parts: [{ type: "text", text: "hello" }],
    createdAt: "2026-04-22T00:00:00.000Z",
  },
  recipientAgentIds: ["agent-2"],
  deliveredAgentIds: ["agent-2"],
};

it.effect("NoopTraceCaptureLive ignores writes and snapshots empty", () =>
  Effect.gen(function* () {
    const capture = Context.get(
      yield* Effect.scoped(Layer.build(NoopTraceCaptureLive)),
      TraceCaptureTag,
    );
    yield* capture.record(sampleEvent);
    expect(yield* capture.snapshot()).toEqual([]);
  }),
);

it.effect("InMemoryTraceCaptureLive buffers and clears events", () =>
  Effect.gen(function* () {
    const capture = Context.get(
      yield* Effect.scoped(Layer.build(InMemoryTraceCaptureLive)),
      TraceCaptureTag,
    );
    yield* capture.record(sampleEvent);
    expect(yield* capture.snapshot()).toEqual([sampleEvent]);
    yield* capture.clear();
    expect(yield* capture.snapshot()).toEqual([]);
  }),
);
