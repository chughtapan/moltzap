import { Cause, Effect, Exit } from "effect";
import type { TSchema } from "@sinclair/typebox";
import {
  decodeRpcParams,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "./method.js";
import {
  JSON_RPC_RESERVED_CODES,
  isRegisteredErrorInstance,
  type RpcErrorClass,
} from "./wire-errors.js";
import type { JsonRpcMethod } from "./wire.js";
import {
  responseFrame,
  type RequestFrame,
  type ResponseFrame,
} from "./wire.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;
type HandlerMap<Ctx, R> = ReadonlyMap<JsonRpcMethod, RpcHandler<Ctx, R>>;
type WireError = {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
};

export interface RpcHandler<Ctx = unknown, R = never> {
  readonly definition: AnyRpcDefinition;
  readonly handle: (
    params: unknown,
    ctx: Ctx,
  ) => Effect.Effect<unknown, unknown, R>;
}

/**
 * Builds an `RpcHandler&lt;Ctx&gt;` with definition-typed params/result. The
 * cast erases to `unknown` for storage; `decodeRpcParams` produces a
 * `ParamsOf&lt;D&gt;`-shaped value at runtime, so the erasure is safe.
 */
export const handler = <D extends AnyRpcDefinition, Ctx, R = never>(
  definition: D,
  handle: (
    params: ParamsOf<D>,
    ctx: Ctx,
  ) => Effect.Effect<ResultOf<D>, unknown, R>,
): RpcHandler<Ctx, R> => ({
  definition,
  handle: handle as RpcHandler<Ctx, R>["handle"],
});

/**
 * Responder side of a JSON-RPC connection. `handle` validates params,
 * dispatches the handler, and maps the Effect to a wire `ResponseFrame`.
 */
export interface JsonRpcServer<Ctx = unknown, R = never> {
  readonly handle: (
    frame: RequestFrame,
    ctx: Ctx,
  ) => Effect.Effect<ResponseFrame, never, R>;
}

export const makeJsonRpcServer = <Ctx = unknown, R = never>(
  handlers: ReadonlyArray<RpcHandler<Ctx, R>>,
): JsonRpcServer<Ctx, R> => {
  const handlerByMethod = buildHandlerMap(handlers);

  return {
    handle: (frame, ctx) => handleJsonRpcRequest(handlerByMethod, frame, ctx),
  };
};

const buildHandlerMap = <Ctx, R>(
  handlers: ReadonlyArray<RpcHandler<Ctx, R>>,
): HandlerMap<Ctx, R> => {
  const handlerByMethod = new Map<JsonRpcMethod, RpcHandler<Ctx, R>>();
  for (const h of handlers) {
    handlerByMethod.set(h.definition.name, h);
  }
  return handlerByMethod;
};

const handleJsonRpcRequest = <Ctx, R>(
  handlerByMethod: HandlerMap<Ctx, R>,
  frame: RequestFrame,
  ctx: Ctx,
): Effect.Effect<ResponseFrame, never, R> =>
  Effect.gen(function* () {
    const rpcHandler = handlerByMethod.get(frame.method);
    if (rpcHandler === undefined) {
      return methodNotFoundResponse(frame);
    }

    const paramsResult = yield* Effect.exit(
      decodeRpcParams(rpcHandler.definition, frame.params),
    );
    if (Exit.isFailure(paramsResult)) {
      return invalidParamsResponse(frame);
    }

    const startMs = Date.now();
    const handlerExit = yield* Effect.exit(
      rpcHandler.handle(paramsResult.value, ctx),
    );
    const durationMs = Date.now() - startMs;

    if (Exit.isSuccess(handlerExit)) {
      return yield* successResponse(frame, durationMs, handlerExit.value);
    }

    return yield* failureResponse(frame, durationMs, handlerExit.cause);
  }).pipe(Effect.withSpan("makeJsonRpcServer"));

const methodNotFoundResponse = (frame: RequestFrame): ResponseFrame =>
  responseFrame(frame.id, {
    error: {
      code: JSON_RPC_RESERVED_CODES.MethodNotFound,
      message: `Method not found: ${frame.method}`,
    },
  });

const invalidParamsResponse = (frame: RequestFrame): ResponseFrame =>
  responseFrame(frame.id, {
    error: {
      code: JSON_RPC_RESERVED_CODES.InvalidParams,
      message: `Invalid params for method: ${frame.method}`,
    },
  });

const successResponse = (
  frame: RequestFrame,
  durationMs: number,
  result: unknown,
): Effect.Effect<ResponseFrame> =>
  Effect.logInfo("RPC request completed").pipe(
    Effect.annotateLogs({
      requestId: frame.id,
      method: frame.method,
      durationMs,
    }),
    Effect.as(responseFrame(frame.id, { result })),
  );

const failureResponse = (
  frame: RequestFrame,
  durationMs: number,
  cause: Cause.Cause<unknown>,
): Effect.Effect<ResponseFrame> => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") {
    const wireError = wireErrorFromInstance(failure.value);
    if (wireError !== null) {
      return knownWireErrorResponse(frame, durationMs, wireError);
    }
  }
  return internalErrorResponse(frame, durationMs, cause);
};

const knownWireErrorResponse = (
  frame: RequestFrame,
  durationMs: number,
  wireError: WireError,
): Effect.Effect<ResponseFrame> =>
  Effect.logWarning(wireError.message).pipe(
    Effect.annotateLogs({
      requestId: frame.id,
      method: frame.method,
      errorCode: wireError.code,
      durationMs,
    }),
    Effect.as(responseFrame(frame.id, { error: wireError })),
  );

const internalErrorResponse = (
  frame: RequestFrame,
  durationMs: number,
  cause: Cause.Cause<unknown>,
): Effect.Effect<ResponseFrame> =>
  Effect.logError("RPC handler error").pipe(
    Effect.annotateLogs({
      requestId: frame.id,
      method: frame.method,
      cause: Cause.pretty(cause),
      durationMs,
    }),
    Effect.as(
      responseFrame(frame.id, {
        error: {
          code: JSON_RPC_RESERVED_CODES.InternalError,
          message: "Internal error",
        },
      }),
    ),
  );

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  value !== null && typeof value === "object";

const stringProperty = (
  value: Record<PropertyKey, unknown>,
  key: PropertyKey,
): string | undefined => {
  const property = value[key];
  return typeof property === "string" ? property : undefined;
};

const wireErrorPayload = (
  cls: RpcErrorClass,
  message: string,
  data: unknown,
): WireError => {
  if (data === undefined) {
    return {
      code: cls.code,
      message,
    };
  }
  return {
    code: cls.code,
    message,
    data,
  };
};

/**
 * Reads wire metadata (code/message/data) off an `RpcErrorClass` instance.
 * Returns `null` when the failure isn't a registered wire-error class
 * (caller routes to InternalError).
 */
export function wireErrorFromInstance(value: unknown): WireError | null {
  if (!isRecord(value) || !isRegisteredErrorInstance(value)) {
    return null;
  }
  const cls = value.constructor as RpcErrorClass;
  const message = stringProperty(value, "message") ?? cls.message;
  return wireErrorPayload(cls, message, value.data);
}
