import { Cause, Effect, Exit } from "effect";
import type { RequestFrame, ResponseFrame } from "@moltzap/protocol";
import { ErrorCodes, responseFrame } from "@moltzap/protocol";
import type { AuthenticatedContext, RpcMethodRegistry } from "./context.js";
import {
  ForbiddenError,
  InvalidParamsError,
  RpcFailure,
  validateParams,
} from "../runtime/index.js";
import { LoggerLive, logger } from "../logger.js";
import { ConnIdTag } from "../app/layers.js";

export function createRpcRouter(methods: RpcMethodRegistry) {
  return function dispatch(
    frame: RequestFrame,
    ctx: AuthenticatedContext,
    connId: string,
  ) {
    const requestId = frame.id;
    const methodName = frame.method;
    const method = methods[methodName];
    if (!method) {
      logger.warn({ requestId, method: methodName }, "Unknown RPC method");
      return Effect.runPromise(
        Effect.succeed(
          errorResponse(
            requestId,
            ErrorCodes.MethodNotFound,
            `Unknown method: ${methodName}`,
          ),
        ),
      );
    }

    const params = frame.params ?? {};
    const startMs = Date.now();

    const program = Effect.gen(function* () {
      const validated = method.validator
        ? yield* validateParams<unknown>(method.validator, params)
        : params;
      if (method.requiresActive && ctx.agentStatus !== "active") {
        return yield* Effect.fail(
          new ForbiddenError({
            message: "Agent must be claimed before performing this action",
          }),
        );
      }
      return yield* method.handler(validated, ctx);
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
          if (err instanceof InvalidParamsError) {
            return errorResponse(
              requestId,
              ErrorCodes.InvalidParams,
              err.message,
            );
          }
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

function successResponse(id: string, result: unknown): ResponseFrame {
  return responseFrame("c2s", id, { result });
}

function errorResponse(
  id: string,
  code: number,
  message: string,
  data?: unknown,
): ResponseFrame {
  return responseFrame("c2s", id, {
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}
