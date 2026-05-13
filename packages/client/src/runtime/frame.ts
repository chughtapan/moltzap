import { Effect } from "effect";
import {
  decodeServerInbound,
  DispatchAuthorize,
  MalformedFrameError,
  type AnyTaskCallbackRpcDefinition,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type DecodedResponseSuccess,
  type DecodedResponseError,
  type DecodedServerInbound,
  type JsonRpcId,
  type ParamsOf,
} from "@moltzap/protocol";

export type { DecodedNotification };

/** Decoded response frame — XOR success | error, mirrors the protocol-level
 * discriminated arms. */
type DecodedResponse = DecodedResponseSuccess | DecodedResponseError;

/**
 * Decoded server-initiated (taskCallback) request frame. The client
 * routes these to its per-method handler registry; the server is the
 * originator and awaits a matching JSON-RPC response with the same id.
 *
 * The `D extends AnyTaskCallbackRpcDefinition ? ... : never` distribution
 * is load-bearing: when the union widens (e.g. a future task-callback
 * descriptor lands alongside `DispatchAuthorize`), the per-arm pairing
 * of `{definition, params}` must stay distinct so downstream consumers
 * see a discriminated union, not a merged
 * `{Definition, params: ParamsA | ParamsB}` shape that conflates
 * incompatible param schemas.
 */
type DecodedServerRequest<
  D extends AnyTaskCallbackRpcDefinition = AnyTaskCallbackRpcDefinition,
> = D extends AnyTaskCallbackRpcDefinition
  ? {
      readonly _tag: "ServerRequest";
      readonly id: JsonRpcId;
      readonly definition: D;
      readonly params: ParamsOf<D>;
    }
  : never;

export type DecodedFrame =
  | DecodedResponse
  | DecodedNotification<AnyNotificationDefinition>
  | DecodedServerRequest;

const isFramePadding = (char: string): boolean =>
  char === "\u0000" || char === "\ufeff" || /\s/u.test(char);

interface FrameScanState {
  readonly frames: string[];
  start: number;
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function scanBeforeFrame(raw: string, char: string, index: number): number {
  if (isFramePadding(char)) return -1;
  if (char !== "{") {
    throw new MalformedFrameError({ raw });
  }
  return index;
}

function scanStringChar(state: FrameScanState, char: string): void {
  if (state.escaped) {
    state.escaped = false;
    return;
  }
  if (char === "\\") {
    state.escaped = true;
    return;
  }
  if (char === '"') {
    state.inString = false;
  }
}

function scanStructuralChar(
  raw: string,
  state: FrameScanState,
  char: string,
  index: number,
): void {
  if (char === '"') {
    state.inString = true;
    return;
  }
  if (char === "{") {
    state.depth += 1;
    return;
  }
  if (char !== "}") return;
  state.depth -= 1;
  if (state.depth !== 0) return;
  state.frames.push(raw.slice(state.start, index + 1));
  state.start = -1;
}

function scanRawFrameChar(
  raw: string,
  state: FrameScanState,
  index: number,
): void {
  const char = raw[index]!;
  if (state.start === -1) {
    state.start = scanBeforeFrame(raw, char, index);
    state.depth = state.start === -1 ? 0 : 1;
    return;
  }
  if (state.inString) {
    scanStringChar(state, char);
    return;
  }
  scanStructuralChar(raw, state, char, index);
}

function scanRawFrames(raw: string): ReadonlyArray<string> {
  const state: FrameScanState = {
    frames: [],
    start: -1,
    depth: 0,
    inString: false,
    escaped: false,
  };
  for (let index = 0; index < raw.length; index += 1) {
    scanRawFrameChar(raw, state, index);
  }
  if (state.start !== -1 || state.frames.length === 0) {
    throw new MalformedFrameError({ raw });
  }
  return state.frames;
}

const liftServerInbound = (
  decoded: DecodedServerInbound,
  raw: string,
): Effect.Effect<DecodedFrame, MalformedFrameError> => {
  if (decoded._tag === "ResponseSuccess") return Effect.succeed(decoded);
  if (decoded._tag === "ResponseError") return Effect.succeed(decoded);
  if (decoded._tag === "Notification") return Effect.succeed(decoded);
  return liftAppCallbackRequest(decoded, raw);
};

/**
 * Per-descriptor lift of an app-callback request to a typed
 * `DecodedServerRequest`. Each branch is guarded by the descriptor's
 * `validateParams` predicate so `decoded.definition` + `decoded.params`
 * narrow together, preserving the per-arm pairing required by the
 * distributive `DecodedServerRequest<D>` type. Adding a new
 * task-callback descriptor adds one branch here.
 */
const liftAppCallbackRequest = (
  decoded: Extract<DecodedServerInbound, { readonly _tag: "ServerRequest" }>,
  raw: string,
): Effect.Effect<DecodedFrame, MalformedFrameError> => {
  if (
    decoded.definition === DispatchAuthorize &&
    DispatchAuthorize.validateParams(decoded.params)
  ) {
    return Effect.succeed<DecodedServerRequest<typeof DispatchAuthorize>>({
      _tag: "ServerRequest",
      id: decoded.id,
      definition: DispatchAuthorize,
      params: decoded.params,
    });
  }
  return Effect.fail(
    new MalformedFrameError({
      raw,
      cause: "unroutable task-callback request descriptor",
    }),
  );
};

const splitRawFrames = (
  raw: string,
): Effect.Effect<ReadonlyArray<string>, MalformedFrameError> =>
  Effect.try({
    try: () => scanRawFrames(raw),
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
  }).pipe(Effect.withSpan("decodeFrames"));
