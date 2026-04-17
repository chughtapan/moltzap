import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { ErrorCodes, type RequestFrame } from "@moltzap/protocol";
import { createRpcRouter } from "./router.js";
import type { AuthenticatedContext, RpcMethodDef } from "./context.js";
import { ForbiddenError, RpcFailure } from "../runtime/index.js";

// Router tests assemble handler fixtures directly as `RpcMethodDef` literals
// rather than going through `defineMethod` — these aren't real RPC methods
// with TypeBox manifests, they're synthetic test shapes that exercise the
// router's branches (success, Forbidden, RpcFailure, defect, InvalidParams).
const makeMethod = (def: RpcMethodDef): RpcMethodDef => def;

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

function frame(method: string, params?: unknown): RequestFrame {
  return { jsonrpc: "2.0", type: "request", id: "req-1", method, params };
}

describe("createRpcRouter", () => {
  const methods = {
    "test/echo": makeMethod({
      validator: () => true,
      handler: (params) => Effect.succeed(params),
    }),
    "test/active-only": makeMethod({
      validator: () => true,
      handler: () => Effect.succeed({ ok: true as const }),
      requiresActive: true,
    }),
    "test/fail": makeMethod({
      validator: () => true,
      handler: () =>
        Effect.fail(
          new RpcFailure({
            code: ErrorCodes.NotFound,
            message: "Not found",
          }),
        ),
    }),
    "test/fail-with-data": makeMethod({
      validator: () => true,
      handler: () =>
        Effect.fail(
          new RpcFailure({
            code: ErrorCodes.Conflict,
            message: "dup",
            data: { id: "x" },
          }),
        ),
    }),
    "test/defect": makeMethod({
      validator: () => true,
      handler: () => Effect.die(new Error("kaboom")),
    }),
    "test/validated": makeMethod({
      validator: (params: unknown): params is { name: string } =>
        typeof params === "object" && params !== null && "name" in params,
      handler: (params) => Effect.succeed(params),
    }),
    "test/forbidden": makeMethod({
      validator: () => true,
      // ForbiddenError isn't in the RpcHandler error channel (which is
      // RpcFailure), but the router matches `instanceof ForbiddenError`
      // independently — we synthesize it here via `as never` to exercise
      // that branch without having to widen the public handler type.
      handler: () =>
        Effect.fail(new ForbiddenError({ message: "not allowed" }) as never),
    }),
  };

  const dispatch = createRpcRouter(methods);

  it("dispatches to handler and returns result", async () => {
    const res = await dispatch(
      frame("test/echo", { hello: "world" }),
      activeAgent,
      "test-conn-id",
    );
    expect(res.result).toEqual({ hello: "world" });
    expect(res.error).toBeUndefined();
  });

  it("returns MethodNotFound for unknown method", async () => {
    const res = await dispatch(
      frame("test/nonexistent"),
      activeAgent,
      "test-conn-id",
    );
    expect(res.error?.code).toBe(ErrorCodes.MethodNotFound);
  });

  it("blocks pending agents on requiresActive methods", async () => {
    const res = await dispatch(
      frame("test/active-only"),
      pendingAgent,
      "test-conn-id",
    );
    expect(res.error?.code).toBe(ErrorCodes.Forbidden);
  });

  it("allows active agents on requiresActive methods", async () => {
    const res = await dispatch(
      frame("test/active-only"),
      activeAgent,
      "test-conn-id",
    );
    expect(res.result).toEqual({ ok: true });
  });

  it("maps Effect.fail(RpcFailure) to typed wire error", async () => {
    const res = await dispatch(frame("test/fail"), activeAgent, "test-conn-id");
    expect(res.error?.code).toBe(ErrorCodes.NotFound);
    expect(res.error?.message).toBe("Not found");
  });

  it("preserves RpcFailure data field", async () => {
    const res = await dispatch(
      frame("test/fail-with-data"),
      activeAgent,
      "test-conn-id",
    );
    expect(res.error?.code).toBe(ErrorCodes.Conflict);
    expect(res.error?.data).toEqual({ id: "x" });
  });

  it("maps Effect.fail(ForbiddenError) to Forbidden wire error", async () => {
    // Covers the `err instanceof ForbiddenError` branch at router.ts:73-75 —
    // distinct from the "active-only on pending agent" branch above, which
    // synthesizes the ForbiddenError inside the router. Here the handler
    // itself fails with ForbiddenError and we check the same mapping.
    const res = await dispatch(
      frame("test/forbidden"),
      activeAgent,
      "test-conn-id",
    );
    expect(res.error?.code).toBe(ErrorCodes.Forbidden);
    expect(res.error?.message).toBe("not allowed");
  });

  it("maps Effect.die to InternalError (defect)", async () => {
    const res = await dispatch(
      frame("test/defect"),
      activeAgent,
      "test-conn-id",
    );
    expect(res.error?.code).toBe(ErrorCodes.InternalError);
    expect(res.error?.message).toBe("Internal error");
  });

  it("rejects invalid params with InvalidParams", async () => {
    const res = await dispatch(
      frame("test/validated", {}),
      activeAgent,
      "test-conn-id",
    );
    expect(res.error?.code).toBe(ErrorCodes.InvalidParams);
  });

  it("passes valid params through validator", async () => {
    const res = await dispatch(
      frame("test/validated", { name: "alice" }),
      activeAgent,
      "test-conn-id",
    );
    expect(res.result).toEqual({ name: "alice" });
  });

  effectIt.effect("composes with @effect/vitest for effect-native tests", () =>
    Effect.gen(function* () {
      const res = yield* Effect.promise(() =>
        dispatch(frame("test/echo", { x: 1 }), activeAgent, "test-conn-id"),
      );
      expect(res.result).toEqual({ x: 1 });
    }),
  );
});
