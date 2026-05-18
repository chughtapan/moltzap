import { Effect } from "effect";
import {
  decodeServerInbound,
  MalformedFrameError,
  type DecodedServerInbound,
} from "@moltzap/protocol";

const parseFrame = (raw: string): Effect.Effect<unknown, MalformedFrameError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => new MalformedFrameError({ raw, cause }),
  });

/**
 * Decode one WebSocket message. WebSocket message boundaries are the frame
 * boundary here; JSON-RPC shape validation stays in `@moltzap/protocol`.
 */
export const decodeFrames = (
  raw: string,
): Effect.Effect<ReadonlyArray<DecodedServerInbound>, MalformedFrameError> =>
  parseFrame(raw).pipe(
    Effect.flatMap(decodeServerInbound),
    Effect.map((decoded) => [decoded]),
    Effect.withSpan("decodeFrames"),
  );
