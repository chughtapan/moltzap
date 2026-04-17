import { Data, Effect } from "effect";
import {
  validators,
  type EventFrame,
  type ResponseFrame,
} from "@moltzap/protocol";
import { MalformedFrameError } from "./errors.js";

/** Decoded response frame — narrowed from the protocol's `ResponseFrame`. */
export interface DecodedResponse {
  readonly _tag: "Response";
  readonly id: string;
  readonly result?: unknown;
  readonly error?: ResponseFrame["error"];
}

/** Decoded event frame — forwarded to the service's onEvent callback. */
export interface DecodedEvent {
  readonly _tag: "Event";
  readonly frame: EventFrame;
}

export type DecodedFrame = DecodedResponse | DecodedEvent;

/** Wrap the raw payload so we keep it for logging on malformed decode. */
export class RawFrame extends Data.Class<{ readonly raw: string }> {}

/**
 * Central typed inbound frame decoder. JSON.parse + shape validation via the
 * protocol's pre-compiled AJV validators — no hand-rolled envelope checks.
 * Returns `Effect.fail(MalformedFrameError)` on parse or validation failure.
 */
export const decodeFrame = (
  raw: string,
): Effect.Effect<DecodedFrame, MalformedFrameError> =>
  Effect.gen(function* () {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return yield* Effect.fail(new MalformedFrameError({ raw, cause: err }));
    }

    if (validators.responseFrame(parsed)) {
      const frame = parsed as ResponseFrame;
      return {
        _tag: "Response" as const,
        id: frame.id,
        result: frame.result,
        error: frame.error,
      };
    }

    if (validators.eventFrame(parsed)) {
      return { _tag: "Event" as const, frame: parsed as EventFrame };
    }

    return yield* Effect.fail(new MalformedFrameError({ raw }));
  });
