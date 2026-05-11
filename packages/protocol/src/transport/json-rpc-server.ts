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

/**
 * `R` is the handler's Effect requirement environment — the union of
 * service Tags the body pulls via `yield*`. Defaults to `never` so the
 * existing `RpcHandler<Ctx>` shape continues to compile against
 * pre-Phase-2A handlers (R=never). Phase 2A r2 §3 widens this so
 * downstream handlers can carry service Tags structurally; the
 * dispatcher's `ManagedRuntime` resolves R at request time.
 */
export interface RpcHandler<Ctx = unknown, R = never> {
  readonly definition: AnyRpcDefinition;
  readonly handle: (
    params: unknown,
    ctx: Ctx,
  ) => Effect.Effect<unknown, unknown, R>;
}

/** Build an `RpcHandler<Ctx, R>` with definition-typed params/result. The
 * cast erases A and E to `unknown` for storage; `decodeRpcParams` produces
 * a `ParamsOf<D>`-shaped value at runtime, so the erasure is safe. R is
 * preserved through the storage type so the dispatcher's runtime can
 * resolve it. */
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

/** Pino-shaped logger; pass `null` for silent dispatch. */
export interface RpcLogger {
  readonly info: (ctx: Record<string, unknown>, message: string) => void;
  readonly warn: (ctx: Record<string, unknown>, message: string) => void;
  readonly error: (ctx: Record<string, unknown>, message: string) => void;
}

/** Responder side of a JSON-RPC connection. `handle` validates params,
 * dispatches the handler, and maps the Effect to a wire `ResponseFrame`.
 *
 * `R` carries the union of all bound handlers' service Tag requirements
 * so the dispatch site (the WS frame loop) can resolve R via the
 * server's `ManagedRuntime`. Defaults to `never` for back-compat. */
export interface JsonRpcServer<Ctx = unknown, R = never> {
  readonly handle: (
    frame: RequestFrame,
    ctx: Ctx,
  ) => Effect.Effect<ResponseFrame, never, R>;
}

export const makeJsonRpcServer = <Ctx = unknown, R = never>(
  handlers: ReadonlyArray<RpcHandler<Ctx, R>>,
  logger: RpcLogger | null = null,
): JsonRpcServer<Ctx, R> => {
  const handlerByMethod = new Map<JsonRpcMethod, RpcHandler<Ctx, R>>();
  for (const h of handlers) {
    handlerByMethod.set(h.definition.name, h);
  }

  const handle = (
    frame: RequestFrame,
    ctx: Ctx,
  ): Effect.Effect<ResponseFrame, never, R> =>
    Effect.gen(function* () {
      const handler = handlerByMethod.get(frame.method);
      if (handler === undefined) {
        return responseFrame(frame.id, {
          error: {
            code: JSON_RPC_RESERVED_CODES.MethodNotFound,
            message: `Method not found: ${frame.method}`,
          },
        });
      }

      const paramsResult = yield* Effect.exit(
        decodeRpcParams(handler.definition, frame.params),
      );
      if (Exit.isFailure(paramsResult)) {
        return responseFrame(frame.id, {
          error: {
            code: JSON_RPC_RESERVED_CODES.InvalidParams,
            message: `Invalid params for method: ${frame.method}`,
          },
        });
      }

      const startMs = Date.now();
      const handlerExit = yield* Effect.exit(
        handler.handle(paramsResult.value, ctx),
      );
      const durationMs = Date.now() - startMs;

      if (Exit.isSuccess(handlerExit)) {
        logger?.info(
          {
            requestId: frame.id,
            method: frame.method,
            durationMs,
          },
          "RPC request completed",
        );
        return responseFrame(frame.id, { result: handlerExit.value });
      }

      const failure = Cause.failureOption(handlerExit.cause);
      if (failure._tag === "Some") {
        const wireError = wireErrorFromInstance(failure.value);
        if (wireError !== null) {
          logger?.warn(
            {
              requestId: frame.id,
              method: frame.method,
              errorCode: wireError.code,
              durationMs,
            },
            wireError.message,
          );
          return responseFrame(frame.id, {
            error: {
              code: wireError.code,
              message: wireError.message,
              ...(wireError.data !== undefined ? { data: wireError.data } : {}),
            },
          });
        }
      }

      logger?.error(
        {
          requestId: frame.id,
          method: frame.method,
          cause: Cause.pretty(handlerExit.cause),
          durationMs,
        },
        "RPC handler error",
      );
      return responseFrame(frame.id, {
        error: {
          code: JSON_RPC_RESERVED_CODES.InternalError,
          message: "Internal error",
        },
      });
    });

  return { handle };
};

/** Reads wire metadata (code/message/data) off an `RpcErrorClass` instance.
 * Returns `null` when the failure isn't a registered wire-error class
 * (caller routes to InternalError). */
export function wireErrorFromInstance(value: unknown): {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
} | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (!isRegisteredErrorInstance(value)) {
    return null;
  }
  const cls = value.constructor as RpcErrorClass;
  const instanceMessage =
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
      ? (value as { message: string }).message
      : undefined;
  const data = "data" in value ? (value as { data?: unknown }).data : undefined;
  return {
    code: cls.code,
    message: instanceMessage ?? cls.message,
    ...(data !== undefined ? { data } : {}),
  };
}
