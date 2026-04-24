import { Context, Effect, Layer, Ref } from "effect";
import type { Message } from "@moltzap/protocol";

export interface TraceMessageEvent {
  readonly _tag: "Message";
  readonly message: Message;
  readonly channelKey: string;
  readonly senderDisplayName: string;
  readonly recipientAgentIds: readonly string[];
  readonly deliveredAgentIds: readonly string[];
}

export type TraceEvent = TraceMessageEvent;

export interface TraceCapture {
  record(event: TraceEvent): Effect.Effect<void, never, never>;
  snapshot(): Effect.Effect<readonly TraceEvent[], never, never>;
  clear(): Effect.Effect<void, never, never>;
}

export class TraceCaptureTag extends Context.Tag("moltzap/TraceCapture")<
  TraceCaptureTag,
  TraceCapture
>() {}

const NOOP_TRACE_CAPTURE: TraceCapture = {
  record: () => Effect.void,
  snapshot: () => Effect.succeed([]),
  clear: () => Effect.void,
};

export const NoopTraceCaptureLive = Layer.succeed(
  TraceCaptureTag,
  NOOP_TRACE_CAPTURE,
);

export const InMemoryTraceCaptureLive = Layer.effect(
  TraceCaptureTag,
  Effect.gen(function* () {
    const ref = yield* Ref.make<readonly TraceEvent[]>([]);
    return {
      record(event) {
        return Ref.update(ref, (events) => [...events, event]);
      },
      snapshot() {
        return Ref.get(ref);
      },
      clear() {
        return Ref.set(ref, []);
      },
    } satisfies TraceCapture;
  }),
);
