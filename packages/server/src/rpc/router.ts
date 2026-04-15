import type { RequestFrame, ResponseFrame } from "@moltzap/protocol";
import { ErrorCodes } from "@moltzap/protocol";
import type { AuthenticatedContext, RpcMethodRegistry } from "./context.js";
import { logger } from "../logger.js";

export function createRpcRouter(methods: RpcMethodRegistry) {
  return async function dispatch(
    frame: RequestFrame,
    ctx: AuthenticatedContext,
  ): Promise<ResponseFrame> {
    const requestId = frame.id;
    const methodName = frame.method;
    const startMs = Date.now();

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
    if (method.validator && !method.validator(params)) {
      return errorResponse(
        requestId,
        ErrorCodes.InvalidParams,
        "Invalid parameters",
      );
    }

    if (method.requiresActive && ctx.agentStatus !== "active") {
      return errorResponse(
        requestId,
        ErrorCodes.Forbidden,
        "Agent must be claimed before performing this action",
      );
    }

    try {
      const result = await method.handler(params, ctx);
      const durationMs = Date.now() - startMs;
      logger.info(
        { requestId, method: methodName, durationMs },
        "RPC request completed",
      );
      return successResponse(requestId, result);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      if (err instanceof RpcError) {
        logger.warn(
          { requestId, method: methodName, errorCode: err.code, durationMs },
          err.message,
        );
        return errorResponse(requestId, err.code, err.message, err.data);
      }
      logger.error(
        { requestId, method: methodName, err, durationMs },
        "RPC handler error",
      );
      return errorResponse(requestId, -32603, "Internal error");
    }
  };
}

export class RpcError extends Error {
  public readonly data?: unknown;
  constructor(
    public readonly code: number,
    message: string,
    data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
    this.data = data;
  }
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
