import { Cause, Effect, Exit } from "effect";
import type { JsonRpcId, ResponseFrame } from "@moltzap/protocol";
import { ErrorCodes, responseFrame } from "@moltzap/protocol";
import type { AuthenticatedContext, ResolvedRpcMethod } from "./context.js";
import { ForbiddenError, RpcFailure } from "../runtime/index.js";
import { LoggerLive, logger } from "../logger.js";
import { ConnIdTag } from "../app/layers.js";

export function createRpcRouter() {
  return function dispatch(
    request: ResolvedRpcMethod,
    ctx: AuthenticatedContext,
    connId: string,
  ) {
    const frame = request.frame;
    const requestId = frame.id;
    const methodName = frame.method;
    const startMs = Date.now();

    const program = Effect.gen(function* () {
      if (request.requiresActive && ctx.agentStatus !== "active") {
        return yield* Effect.fail(
          new ForbiddenError({
            message: "Agent must be claimed before performing this action",
          }),
        );
      }
      return yield* request.handle(ctx);
    }).pipe(
      Effect.provideService(ConnIdTag, connId),
      Effect.provide(LoggerLive),
    );

    return Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(program);
        const durationMs = Date.now() - startMs;

        if (Exit.isSuccess(exit)) {
          logger.info(
            { requestId, method: methodName, durationMs },
            "RPC request completed",
          );
          return successResponse(requestId, exit.value);
        }

        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          const err = failure.value;
          if (err instanceof ForbiddenError) {
            return errorResponse(requestId, ErrorCodes.Forbidden, err.message);
          }
          if (err instanceof RpcFailure) {
            logger.warn(
              {
                requestId,
                method: methodName,
                errorCode: err.code,
                durationMs,
              },
              err.message,
            );
            return errorResponse(requestId, err.code, err.message, err.data);
          }
        }

        logger.error(
          {
            requestId,
            method: methodName,
            cause: Cause.pretty(exit.cause),
            durationMs,
          },
          "RPC handler error",
        );
        return errorResponse(
          requestId,
          ErrorCodes.InternalError,
          "Internal error",
        );
      }),
    );
  };
}

function successResponse(id: JsonRpcId, result: unknown): ResponseFrame {
  return responseFrame(id, { result });
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): ResponseFrame {
  return responseFrame(id, {
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}
