import { Effect } from "effect";
import {
  validators,
  type EventFrame,
  type RequestFrame,
  type ResponseFrame,
} from "@moltzap/protocol";
import { MalformedFrameError } from "./errors.js";

/** Decoded c2s response frame — narrowed from the protocol's `ResponseFrame`. */
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

/**
 * Decoded server-initiated (s2c) request frame. The client routes these to
 * its per-method handler registry; the server is the originator and awaits
 * a matching `direction: "s2c"` response.
 */
export interface DecodedServerRequest {
  readonly _tag: "ServerRequest";
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
  readonly traceparent?: string;
}

export type DecodedFrame =
  | DecodedResponse
  | DecodedEvent
  | DecodedServerRequest;

const isFramePadding = (char: string): boolean =>
  char === "\u0000" || char === "\ufeff" || /\s/u.test(char);

const toDecodedFrame = (
  parsed: unknown,
): DecodedFrame | MalformedFrameError => {
  if (validators.responseFrame(parsed)) {
    const frame = parsed as ResponseFrame;
    // Defense-in-depth: a `direction: "s2c"` response inbound on the
    // client would correspond to a client-originated server reply — but
    // the client never originates s2c requests, so route as malformed.
    if (frame.direction !== "c2s") {
      return new MalformedFrameError({ raw: JSON.stringify(parsed) });
    }
    return {
      _tag: "Response" as const,
      id: frame.id,
      result: frame.result,
      error: frame.error,
    };
  }

  if (validators.requestFrame(parsed)) {
    const frame = parsed as RequestFrame;
    // Symmetric defense: a `direction: "c2s"` request inbound on the
    // client would mean the server is acting as a client — never legal.
    if (frame.direction !== "s2c") {
      return new MalformedFrameError({ raw: JSON.stringify(parsed) });
    }
    return {
      _tag: "ServerRequest" as const,
      id: frame.id,
      method: frame.method,
      params: frame.params,
      traceparent: frame.traceparent,
    };
  }

  if (validators.eventFrame(parsed)) {
    return { _tag: "Event" as const, frame: parsed as EventFrame };
  }

  return new MalformedFrameError({ raw: JSON.stringify(parsed) });
};

export const splitRawFrames = (
  raw: string,
): Effect.Effect<ReadonlyArray<string>, MalformedFrameError> =>
  Effect.try({
    try: () => {
      const frames: string[] = [];
      let start = -1;
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index]!;

        if (start === -1) {
          if (isFramePadding(char)) {
            continue;
          }
          if (char !== "{") {
            throw new MalformedFrameError({ raw });
          }
          start = index;
          depth = 1;
          continue;
        }

        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\") {
            escaped = true;
            continue;
          }
          if (char === '"') {
            inString = false;
          }
          continue;
        }

        if (char === '"') {
          inString = true;
          continue;
        }
        if (char === "{") {
          depth += 1;
          continue;
        }
        if (char !== "}") {
          continue;
        }

        depth -= 1;
        if (depth !== 0) {
          continue;
        }

        frames.push(raw.slice(start, index + 1));
        start = -1;
      }

      if (start !== -1 || frames.length === 0) {
        throw new MalformedFrameError({ raw });
      }

      return frames;
    },
    catch: (cause) =>
      cause instanceof MalformedFrameError
        ? cause
        : new MalformedFrameError({ raw, cause }),
  });

/**
 * Central typed inbound frame decoder. JSON.parse + shape validation via the
 * protocol's pre-compiled AJV validators. The raw socket chunk may contain
 * padding bytes or more than one JSON object; split and validate each object
 * before handing frames to the client runtime.
 */
export const decodeFrames = (
  raw: string,
): Effect.Effect<ReadonlyArray<DecodedFrame>, MalformedFrameError> =>
  Effect.gen(function* () {
    const frameTexts = yield* splitRawFrames(raw);
    const decodedFrames: DecodedFrame[] = [];

    for (const frameText of frameTexts) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frameText);
      } catch (err) {
        return yield* Effect.fail(
          new MalformedFrameError({ raw: frameText, cause: err }),
        );
      }

      const decoded = toDecodedFrame(parsed);
      if (decoded instanceof MalformedFrameError) {
        return yield* Effect.fail(new MalformedFrameError({ raw: frameText }));
      }
      decodedFrames.push(decoded);
    }

    return decodedFrames;
  });
