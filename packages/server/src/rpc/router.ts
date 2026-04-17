import { Cause, Effect, Exit } from "effect";
import type { RequestFrame, ResponseFrame } from "@moltzap/protocol";
import { ErrorCodes } from "@moltzap/protocol";
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
  // #ignore-sloppy-code-next-line[async-keyword]: ws server dispatch boundary invoked per frame
  return async function dispatch(
    frame: RequestFrame,
    ctx: AuthenticatedContext,
    connId: string,
    // #ignore-sloppy-code-next-line[promise-type]: ws server dispatch boundary invoked per frame
  ): Promise<ResponseFrame> {
    const requestId = frame.id;
    const methodName = frame.method;
    const method = methods[methodName];
    if (!method) {
      logger.warn({ requestId, method: methodName }, "Unknown RPC method");
      return errorResponse(
        requestId,
        ErrorCodes.MethodNotFound,
        `Unknown method: ${methodName}`,
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

    const exit = await Effect.runPromiseExit(program);
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
        return errorResponse(requestId, ErrorCodes.InvalidParams, err.message);
      }
      if (err instanceof ForbiddenError) {
        return errorResponse(requestId, ErrorCodes.Forbidden, err.message);
      }
      if (err instanceof RpcFailure) {
        logger.warn(
          { requestId, method: methodName, errorCode: err.code, durationMs },
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
    return errorResponse(requestId, ErrorCodes.InternalError, "Internal error");
  };
}

function successResponse(id: string, result: unknown): ResponseFrame {
  return { jsonrpc: "2.0", type: "response", id, result };
}

function errorResponse(
  id: string,
  code: number,
  message: string,
  data?: unknown,
): ResponseFrame {
  const error: { code: number; message: string; data?: unknown } = {
    code,
    message,
  };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", type: "response", id, error };
}
