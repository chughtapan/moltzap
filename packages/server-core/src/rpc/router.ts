import type { RequestFrame, ResponseFrame } from "@moltzap/protocol";
import { ErrorCodes } from "@moltzap/protocol";
import type { AuthenticatedContext, RpcMethodRegistry } from "./context.js";
import { logger } from "../logger.js";
import {
  telemetry,
  SCHEMA_VERSION,
  type RpcErrorReason,
} from "@moltzap/observability";

function emitRpcError(opts: {
  method: string;
  code: number;
  message: string;
  reason: RpcErrorReason;
  ctx: AuthenticatedContext;
}): void {
  const { method, code, message, reason, ctx } = opts;
  telemetry.emit({
    event: "rpc.error",
    source: "server",
    schemaVersion: SCHEMA_VERSION,
    ts: Date.now(),
    method,
    code,
    message,
    reason,
    agentId: ctx.kind === "agent" ? ctx.agentId : undefined,
    connId: ctx.connectionId,
  });
}

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
      emitRpcError({
        method: methodName,
        code: ErrorCodes.MethodNotFound,
        message: `Unknown method: ${methodName}`,
        reason: "method_not_found",
        ctx,
      });
      return errorResponse(
        requestId,
        ErrorCodes.MethodNotFound,
        `Unknown method: ${methodName}`,
      );
    }

    const params = frame.params ?? {};
    if (method.validator && !method.validator(params)) {
      emitRpcError({
        method: methodName,
        code: ErrorCodes.InvalidParams,
        message: "Invalid parameters",
        reason: "invalid_params",
        ctx,
      });
      return errorResponse(
        requestId,
        ErrorCodes.InvalidParams,
        "Invalid parameters",
      );
    }

    if (method.requiresActive) {
      if (ctx.kind === "agent" && ctx.agentStatus !== "active") {
        const msg = "Agent must be claimed before performing this action";
        emitRpcError({
          method: methodName,
          code: ErrorCodes.Forbidden,
          message: msg,
          reason: "forbidden_pending_claim",
          ctx,
        });
        return errorResponse(requestId, ErrorCodes.Forbidden, msg);
      }
      if (ctx.kind === "user" && !ctx.activeAgentId) {
        const msg = "No active agent. Claim an agent first.";
        emitRpcError({
          method: methodName,
          code: ErrorCodes.Forbidden,
          message: msg,
          reason: "forbidden_no_active_agent",
          ctx,
        });
        return errorResponse(requestId, ErrorCodes.Forbidden, msg);
      }
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
        emitRpcError({
          method: methodName,
          code: err.code,
          message: err.message,
          reason: "handler_rejected",
          ctx,
        });
        return errorResponse(requestId, err.code, err.message);
      }
      logger.error(
        { requestId, method: methodName, err, durationMs },
        "RPC handler error",
      );
      emitRpcError({
        method: methodName,
        code: -32603,
        message: "Internal error",
        reason: "handler_error",
        ctx,
      });
      return errorResponse(requestId, -32603, "Internal error");
    }
  };
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function successResponse(id: string, result: unknown): ResponseFrame {
  return { jsonrpc: "2.0", type: "response", id, result };
}

function errorResponse(
  id: string,
  code: number,
  message: string,
): ResponseFrame {
  return { jsonrpc: "2.0", type: "response", id, error: { code, message } };
}
