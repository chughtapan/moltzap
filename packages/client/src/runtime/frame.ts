import { Effect } from "effect";
import {
  decodeServerInbound,
  MalformedFrameError,
  TaskAuthorizeDispatch,
  type AnyTaskCallbackRpcDefinition,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type DecodedResponseSuccess,
  type DecodedResponseError,
  type DecodedServerInbound,
  type JsonRpcId,
  type ParamsOf,
} from "@moltzap/protocol";
import { type AppCallbackPartitionRoute } from "../internal/app-callback-partition-key.js";

export type { DecodedNotification };

/** Decoded response frame — XOR success | error, mirrors the protocol-level
 * discriminated arms. */
export type DecodedResponse = DecodedResponseSuccess | DecodedResponseError;

/**
 * Decoded server-initiated (taskCallback) request frame. The client
 * routes these to its per-method handler registry; the server is the
 * originator and awaits a matching JSON-RPC response with the same id.
 *
 * Carries the partition route alongside the protocol-level decoded request.
 */
export type DecodedServerRequest<
  D extends AnyTaskCallbackRpcDefinition = AnyTaskCallbackRpcDefinition,
> = {
  readonly _tag: "ServerRequest";
  readonly id: JsonRpcId;
  readonly definition: D;
  readonly params: ParamsOf<D>;
  readonly partition: AppCallbackPartitionRoute;
};

export type DecodedFrame =
  | DecodedResponse
  | DecodedNotification<AnyNotificationDefinition>
  | DecodedServerRequest;

const isFramePadding = (char: string): boolean =>
  char === "\u0000" || char === "\ufeff" || /\s/u.test(char);

const liftServerInbound = (
  decoded: DecodedServerInbound,
  raw: string,
): Effect.Effect<DecodedFrame, MalformedFrameError> => {
  if (decoded._tag === "ResponseSuccess") return Effect.succeed(decoded);
  if (decoded._tag === "ResponseError") return Effect.succeed(decoded);
  if (decoded._tag === "Notification") return Effect.succeed(decoded);
  return appCallbackPartitionRoute(decoded.definition, decoded.params).pipe(
    Effect.map(
      (partition): DecodedServerRequest => ({
        _tag: "ServerRequest",
        id: decoded.id,
        definition: decoded.definition,
        params: decoded.params,
        partition,
      }),
    ),
    Effect.mapError((cause) => new MalformedFrameError({ raw, cause })),
  );
};

const appCallbackPartitionRoute = (
  definition: AnyTaskCallbackRpcDefinition,
  params: unknown,
): Effect.Effect<AppCallbackPartitionRoute, MalformedFrameError> => {
  if (
    definition === TaskAuthorizeDispatch &&
    TaskAuthorizeDispatch.validateParams(params)
  ) {
    return Effect.succeed({
      taskId: params.taskId,
      conversationId: params.conversationId,
    });
  }
  return Effect.fail(
    new MalformedFrameError({
      raw: "unroutable task-callback request descriptor",
    }),
  );
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

      const decoded = yield* decodeServerInbound(parsed).pipe(
        Effect.flatMap((d) => liftServerInbound(d, frameText)),
        Effect.mapError((cause) =>
          cause instanceof MalformedFrameError
            ? cause
            : new MalformedFrameError({ raw: frameText, cause }),
        ),
      );
      decodedFrames.push(decoded);
    }

    return decodedFrames;
  });
