import { describe, expect, it } from "vitest";
import { createRpcRouter, RpcError } from "./router.js";
import { ErrorCodes, type RequestFrame } from "@moltzap/protocol";
import type { AuthenticatedContext } from "./context.js";

const activeAgent: AuthenticatedContext = {
  agentId: "agent-1",
  agentStatus: "active",
  ownerUserId: "user-1",
};

const pendingAgent: AuthenticatedContext = {
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
});
