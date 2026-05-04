import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import {
  defineRpc,
  ErrorCodes,
  jsonRpcStringId,
  requestFrame,
  type ParamsOf,
  type RpcDefinition,
  type RequestFrame,
  type ResponseFrame,
  type TSchema,
} from "@moltzap/protocol";
import { createRpcRouter } from "./router.js";
import { defineMethod, makeRpcMethodBoundaryService } from "./context.js";
import type { AuthenticatedContext } from "./context.js";
import { ForbiddenError, RpcFailure } from "../runtime/index.js";
import { AgentId, UserId } from "../app/types.js";

const activeAgent: AuthenticatedContext = {
  agentId: AgentId("00000000-0000-4000-8000-0000000000a1"),
  agentStatus: "active",
  ownerUserId: UserId("00000000-0000-4000-8000-0000000001a1"),
};

const pendingAgent: AuthenticatedContext = {
  agentId: AgentId("00000000-0000-4000-8000-0000000000a2"),
  agentStatus: "pending_claim",
  ownerUserId: null,
};

const AnyParams = Type.Any();
const AnyResult = Type.Any();

const TestEcho = defineRpc({
  name: "test/echo",
  params: AnyParams,
  result: AnyResult,
});
const TestActiveOnly = defineRpc({
  name: "test/active-only",
  params: AnyParams,
  result: AnyResult,
});
const TestFail = defineRpc({
  name: "test/fail",
  params: AnyParams,
  result: AnyResult,
});
const TestFailWithData = defineRpc({
  name: "test/fail-with-data",
  params: AnyParams,
  result: AnyResult,
});
const TestDefect = defineRpc({
  name: "test/defect",
  params: AnyParams,
  result: AnyResult,
});
const TestForbidden = defineRpc({
  name: "test/forbidden",
  params: AnyParams,
  result: AnyResult,
});

function frame<D extends RpcDefinition<string, TSchema, TSchema>>(
  definition: D,
  params: ParamsOf<D>,
): RequestFrame {
  return requestFrame(jsonRpcStringId("req-1"), definition, params);
}

function expectResult(response: ResponseFrame): unknown {
  if (!("result" in response)) {
    throw new Error(`expected result response, got ${response.error.message}`);
  }
  return response.result;
}

function expectError(
  response: ResponseFrame,
): Extract<ResponseFrame, { error: unknown }>["error"] {
  if (!("error" in response)) {
    throw new Error("expected error response");
  }
  return response.error;
}

describe("createRpcRouter", () => {
  const methods = [
    defineMethod(TestEcho, {
      handler: (params) => Effect.succeed(params),
    }),
    defineMethod(TestActiveOnly, {
      handler: () => Effect.succeed({ ok: true as const }),
      requiresActive: true,
    }),
    defineMethod(TestFail, {
      handler: () =>
        Effect.fail(
          new RpcFailure({
            code: ErrorCodes.NotFound,
            message: "Not found",
          }),
        ),
    }),
    defineMethod(TestFailWithData, {
      handler: () =>
        Effect.fail(
          new RpcFailure({
            code: ErrorCodes.Conflict,
            message: "dup",
            data: { id: "x" },
          }),
        ),
    }),
    defineMethod(TestDefect, {
      handler: () => Effect.die(new Error("kaboom")),
    }),
    defineMethod(TestForbidden, {
      // ForbiddenError isn't in the RpcHandler error channel (which is
      // RpcFailure), but the router matches `instanceof ForbiddenError`
      // independently — we synthesize it here via `as never` to exercise
      // that branch without having to widen the public handler type.
      handler: () =>
        Effect.fail(new ForbiddenError({ message: "not allowed" }) as never),
    }),
  ];

  const dispatchResolved = createRpcRouter();
  const boundary = makeRpcMethodBoundaryService(methods);
  const dispatch = async (
    request: RequestFrame,
    ctx: AuthenticatedContext,
    connId: string,
  ) => {
    const resolved = await Effect.runPromise(boundary.resolve(request));
    return dispatchResolved(resolved, ctx, connId);
  };

  it("dispatches to handler and returns result", async () => {
    const res = await dispatch(
      frame(TestEcho, { hello: "world" }),
      activeAgent,
      "test-conn-id",
    );
    expect(expectResult(res)).toEqual({ hello: "world" });
  });

  it("blocks pending agents on requiresActive methods", async () => {
    const res = await dispatch(
      frame(TestActiveOnly, {}),
      pendingAgent,
      "test-conn-id",
    );
    expect(expectError(res).code).toBe(ErrorCodes.Forbidden);
  });

  it("allows active agents on requiresActive methods", async () => {
    const res = await dispatch(
      frame(TestActiveOnly, {}),
      activeAgent,
      "test-conn-id",
    );
    expect(expectResult(res)).toEqual({ ok: true });
  });

  it("maps Effect.fail(RpcFailure) to typed wire error", async () => {
    const res = await dispatch(
      frame(TestFail, {}),
      activeAgent,
      "test-conn-id",
    );
    const error = expectError(res);
    expect(error.code).toBe(ErrorCodes.NotFound);
    expect(error.message).toBe("Not found");
  });

  it("preserves RpcFailure data field", async () => {
    const res = await dispatch(
      frame(TestFailWithData, {}),
      activeAgent,
      "test-conn-id",
    );
    const error = expectError(res);
    expect(error.code).toBe(ErrorCodes.Conflict);
    expect(error.data).toEqual({ id: "x" });
  });

  it("maps Effect.fail(ForbiddenError) to Forbidden wire error", async () => {
    // Covers the `err instanceof ForbiddenError` branch at router.ts:73-75 —
    // distinct from the "active-only on pending agent" branch above, which
    // synthesizes the ForbiddenError inside the router. Here the handler
    // itself fails with ForbiddenError and we check the same mapping.
    const res = await dispatch(
      frame(TestForbidden, {}),
      activeAgent,
      "test-conn-id",
    );
    const error = expectError(res);
    expect(error.code).toBe(ErrorCodes.Forbidden);
    expect(error.message).toBe("not allowed");
  });

  it("maps Effect.die to InternalError (defect)", async () => {
    const res = await dispatch(
      frame(TestDefect, {}),
      activeAgent,
      "test-conn-id",
    );
    const error = expectError(res);
    expect(error.code).toBe(ErrorCodes.InternalError);
    expect(error.message).toBe("Internal error");
  });

  effectIt.effect("composes with @effect/vitest for effect-native tests", () =>
    Effect.gen(function* () {
      const res = yield* Effect.promise(() =>
        dispatch(frame(TestEcho, { x: 1 }), activeAgent, "test-conn-id"),
      );
      expect(expectResult(res)).toEqual({ x: 1 });
    }),
  );
});
