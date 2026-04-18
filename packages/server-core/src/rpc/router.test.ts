import { describe, expect, it, afterEach } from "vitest";
import { createRpcRouter, RpcError } from "./router.js";
import { ErrorCodes, type RequestFrame } from "@moltzap/protocol";
import type { AuthenticatedContext } from "./context.js";
import {
  captureTelemetry,
  resetTelemetry,
} from "@moltzap/observability/test-utils";

const activeAgent: AuthenticatedContext = {
  kind: "agent",
  agentId: "agent-1",
  agentStatus: "active",
  ownerUserId: "user-1",
};

const pendingAgent: AuthenticatedContext = {
  kind: "agent",
  agentId: "agent-2",
  agentStatus: "pending_claim",
  ownerUserId: null,
};

describe("createRpcRouter", () => {
  const methods = {
    "test/echo": {
      handler: async (params: unknown) => params,
    },
    "test/active-only": {
      handler: async () => ({ ok: true }),
      requiresActive: true,
    },
    "test/throw": {
      handler: async () => {
        throw new RpcError(ErrorCodes.NotFound, "Not found");
      },
    },
    "test/validated": {
      handler: async (params: unknown) => params,
      validator: (params: unknown) =>
        typeof params === "object" && params !== null && "name" in params,
    },
  };

  const dispatch = createRpcRouter(methods);

  function frame(method: string, params?: unknown): RequestFrame {
    return { jsonrpc: "2.0", type: "request", id: "req-1", method, params };
  }

  it("dispatches to handler and returns result", async () => {
    const res = await dispatch(
      frame("test/echo", { hello: "world" }),
      activeAgent,
    );
    expect(res.result).toEqual({ hello: "world" });
    expect(res.error).toBeUndefined();
  });

  it("returns MethodNotFound for unknown method", async () => {
    const res = await dispatch(frame("test/nonexistent"), activeAgent);
    expect(res.error?.code).toBe(ErrorCodes.MethodNotFound);
  });

  it("blocks pending agents on requiresActive methods", async () => {
    const res = await dispatch(frame("test/active-only"), pendingAgent);
    expect(res.error?.code).toBe(ErrorCodes.Forbidden);
  });

  it("allows active agents on requiresActive methods", async () => {
    const res = await dispatch(frame("test/active-only"), activeAgent);
    expect(res.result).toEqual({ ok: true });
  });

  it("handles RpcError from handler", async () => {
    const res = await dispatch(frame("test/throw"), activeAgent);
    expect(res.error?.code).toBe(ErrorCodes.NotFound);
    expect(res.error?.message).toBe("Not found");
  });

  it("rejects invalid params when validator is set", async () => {
    const res = await dispatch(frame("test/validated", {}), activeAgent);
    expect(res.error?.code).toBe(ErrorCodes.InvalidParams);
  });

  it("passes valid params through validator", async () => {
    const res = await dispatch(
      frame("test/validated", { name: "alice" }),
      activeAgent,
    );
    expect(res.result).toEqual({ name: "alice" });
  });

  describe("telemetry emits", () => {
    afterEach(resetTelemetry);

    it("emits rpc.error for unknown method with reason=method_not_found", async () => {
      const { events } = captureTelemetry();
      await dispatch(frame("test/nonexistent"), activeAgent);
      const rpcErrors = events.filter((e) => e.event === "rpc.error");
      expect(rpcErrors).toHaveLength(1);
      const err = rpcErrors[0]!;
      if (err.event !== "rpc.error") return;
      expect(err.code).toBe(ErrorCodes.MethodNotFound);
      expect(err.method).toBe("test/nonexistent");
      expect(err.agentId).toBe("agent-1");
      expect(err.reason).toBe("method_not_found");
    });

    it("emits rpc.error for InvalidParams with reason=invalid_params", async () => {
      const { events } = captureTelemetry();
      await dispatch(frame("test/validated", {}), activeAgent);
      const rpcErrors = events.filter((e) => e.event === "rpc.error");
      expect(rpcErrors).toHaveLength(1);
      if (rpcErrors[0]!.event !== "rpc.error") return;
      expect(rpcErrors[0]!.code).toBe(ErrorCodes.InvalidParams);
      expect(rpcErrors[0]!.reason).toBe("invalid_params");
    });

    it("emits rpc.error when handler throws RpcError with reason=handler_rejected", async () => {
      const { events } = captureTelemetry();
      await dispatch(frame("test/throw"), activeAgent);
      const rpcErrors = events.filter((e) => e.event === "rpc.error");
      expect(rpcErrors).toHaveLength(1);
      if (rpcErrors[0]!.event !== "rpc.error") return;
      expect(rpcErrors[0]!.code).toBe(ErrorCodes.NotFound);
      expect(rpcErrors[0]!.message).toBe("Not found");
      expect(rpcErrors[0]!.reason).toBe("handler_rejected");
    });

    it("emits rpc.error for Forbidden on pending agent with reason=forbidden_pending_claim", async () => {
      const { events } = captureTelemetry();
      await dispatch(frame("test/active-only"), pendingAgent);
      const rpcErrors = events.filter((e) => e.event === "rpc.error");
      expect(rpcErrors).toHaveLength(1);
      if (rpcErrors[0]!.event !== "rpc.error") return;
      expect(rpcErrors[0]!.code).toBe(ErrorCodes.Forbidden);
      expect(rpcErrors[0]!.reason).toBe("forbidden_pending_claim");
    });

    it("does NOT emit rpc.error on successful dispatch", async () => {
      const { events } = captureTelemetry();
      await dispatch(frame("test/echo", { ok: 1 }), activeAgent);
      const rpcErrors = events.filter((e) => e.event === "rpc.error");
      expect(rpcErrors).toHaveLength(0);
    });
  });
});
