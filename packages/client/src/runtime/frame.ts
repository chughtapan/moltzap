import { Effect } from "effect";
import {
  validators,
  type AnyAppCallbackRpcDefinition,
  type AnyNotificationDefinition,
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnSessionActive,
  appCallbackRpcGroup,
  decodeRpcRequest,
  isDecodedRpcRequest,
  isJsonRpcStringId,
  notificationGroup,
  type DecodedNotification as ProtocolDecodedNotification,
  type DecodedRpcRequest,
  type JsonRpcStringId,
  type NotificationFrame,
  type ResponseFrame,
} from "@moltzap/protocol";
import { MalformedFrameError } from "./errors.js";
import {
  LIFECYCLE_CONVERSATION_SENTINEL,
  type AppCallbackPartitionRoute,
} from "../internal/app-callback-partition-key.js";

/** Decoded response frame — narrowed from the protocol's `ResponseFrame`. */
export interface DecodedResponse {
  readonly _tag: "Response";
  readonly id: JsonRpcStringId;
  readonly result?: unknown;
  readonly error?: Extract<ResponseFrame, { error: unknown }>["error"];
}

/** Decoded notification frame. */
export type DecodedNotification<
  D extends AnyNotificationDefinition = AnyNotificationDefinition,
> = ProtocolDecodedNotification<D> & {
  readonly _tag: "Notification";
};

/**
 * Decoded server-initiated (appCallback) request frame. The client routes these to
 * its per-method handler registry; the server is the originator and awaits
 * a matching JSON-RPC response with the same id.
 */
export type DecodedServerRequest<
  D extends AnyAppCallbackRpcDefinition = AnyAppCallbackRpcDefinition,
> = DecodedRpcRequest<D> & {
  readonly _tag: "ServerRequest";
  readonly partition: AppCallbackPartitionRoute;
};

export type DecodedFrame =
  | DecodedResponse
  | DecodedNotification
  | DecodedServerRequest;

const isFramePadding = (char: string): boolean =>
  char === "\u0000" || char === "\ufeff" || /\s/u.test(char);

const toDecodedFrame = (
  parsed: unknown,
): Effect.Effect<DecodedFrame, MalformedFrameError> => {
  const raw = JSON.stringify(parsed);
  if (validators.responseFrame(parsed)) {
    if (!isJsonRpcStringId(parsed.id)) {
      return Effect.fail(new MalformedFrameError({ raw }));
    }
    return Effect.succeed({
      _tag: "Response" as const,
      id: parsed.id,
      result: "result" in parsed ? parsed.result : undefined,
      error: "error" in parsed ? parsed.error : undefined,
    });
  }

  if (validators.requestFrame(parsed)) {
    return decodeRpcRequest(appCallbackRpcGroup, parsed).pipe(
      Effect.mapError((cause) => new MalformedFrameError({ raw, cause })),
      Effect.flatMap((request) =>
        appCallbackPartitionRoute(request).pipe(
          Effect.map((partition) => ({
            _tag: "ServerRequest" as const,
            ...request,
            partition,
          })),
        ),
      ),
    );
  }

  if (validators.notificationFrame(parsed)) {
    return toDecodedNotification(parsed);
  }

  return Effect.fail(new MalformedFrameError({ raw }));
};

const PASSTHROUGH_PARAMS_SCHEMA = Object.freeze({});

function makePassthroughNotificationDefinition(
  method: NotificationFrame["method"],
): AnyNotificationDefinition {
  const validate = (data: unknown): data is unknown => data === data;
  const def = {
    name: method,
    paramsSchema: PASSTHROUGH_PARAMS_SCHEMA,
    validateParams: validate,
    Params: undefined,
  };
  return passthroughCast(def);
}

// Single chokepoint for the runtime-only widening cast on a passthrough
// notification definition. ACG's `as-unknown-as` rule and the
// `sloppy-code-guard.sh` pragma check both opt out here; everywhere else
// in the package keeps the strict ban.
function passthroughCast(def: object): AnyNotificationDefinition {
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- passthrough definition for unknown-method notifications; structurally compatible with NotificationDefinition but TypeScript can't narrow the literal `Name` union
  return def as unknown as AnyNotificationDefinition; // #ignore-sloppy-code[as-unknown-as]: passthrough for unknown-method notifications
}

const toDecodedNotification = (
  parsed: NotificationFrame,
): Effect.Effect<DecodedNotification> => {
  // Wire decoder is payload-opaque: it routes by method name and attaches
  // the protocol definition (when known) so subscribers can opt into
  // `definition.validateParams` for drift detection. Strict per-payload
  // validation lives at the typed-handler boundary, not here — conformance
  // payload-opacity (#200 §5 C3) and fuzz-liveness (E2) require the
  // subscriber stream to surface arbitrary params byte-identically.
  const definition: AnyNotificationDefinition =
    notificationGroup.byName.get(parsed.method) ??
    makePassthroughNotificationDefinition(parsed.method);
  const decoded: Record<string, unknown> = {
    jsonrpc: parsed.jsonrpc,
    method: definition.name,
  };
  if (parsed.params !== undefined) decoded["params"] = parsed.params;
  Object.defineProperty(decoded, "_tag", {
    value: "Notification",
    enumerable: false,
  });
  Object.defineProperty(decoded, "definition", {
    value: definition,
    enumerable: false,
  });
  return Effect.succeed(decoded as DecodedNotification);
};

const lifecycleRoute = (taskId: string): AppCallbackPartitionRoute => ({
  taskId,
  conversationId: LIFECYCLE_CONVERSATION_SENTINEL,
});

const appCallbackPartitionRoute = (
  request: DecodedRpcRequest<AnyAppCallbackRpcDefinition>,
): Effect.Effect<AppCallbackPartitionRoute, MalformedFrameError> => {
  if (isDecodedRpcRequest(AppsOnBeforeDispatch, request)) {
    return Effect.succeed({
      taskId: request.params.taskId,
      conversationId: request.params.conversationId,
    });
  }
  if (isDecodedRpcRequest(AppsOnBeforeMessageDelivery, request)) {
    return Effect.succeed({
      taskId: request.params.taskId,
      conversationId: request.params.conversationId,
    });
  }
  if (isDecodedRpcRequest(AppsOnSessionActive, request)) {
    return Effect.succeed(lifecycleRoute(request.params.taskId));
  }
  if (isDecodedRpcRequest(AppsOnClose, request)) {
    return Effect.succeed(lifecycleRoute(request.params.taskId));
  }
  return Effect.fail(
    new MalformedFrameError({
      raw: "unroutable app-callback request descriptor",
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

      const decoded = yield* toDecodedFrame(parsed).pipe(
        Effect.mapError(
          (cause) => new MalformedFrameError({ raw: frameText, cause }),
        ),
      );
      decodedFrames.push(decoded);
    }

    return decodedFrames;
  });
