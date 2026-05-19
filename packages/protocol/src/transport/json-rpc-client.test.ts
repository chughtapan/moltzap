/**
 * Unit tests for the Spec F (#617) `AgentClientConnection` originator's
 * `resolve` path — focused on inbound error-frame decode for codes that
 * match the registered tagged-error registry.
 *
 * The resolver path that constructs the failure value lives in
 * `json-rpc-client.ts` (the originator helper internalised by `dispatch.ts`
 * post Spec F) and was the site of issue #511: the wire frame's `data`
 * payload was dropped because the registered class was constructed with
 * no arguments.
 *
 * Post Spec F (architect plan #619 §6 FRI), this test exercises the
 * originator through the public typed-dispatcher entry point
 * `makeAgentClientConnection({ handlers: {}, ... })` rather than the
 * legacy `makeJsonRpcClient` factory.
 */
import { describe, expect, it } from "vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { Type } from "@sinclair/typebox";

import { defineRpc } from "./method.js";
import { makeAgentClientConnection } from "./connection.js";
import { responseFrame, type ResponseFrame } from "./wire.js";
import { ForbiddenError } from "./wire-errors.js";

const TestEcho = defineRpc({
  name: "test/echo",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

function parseRequestId(raw: string): string {
  const parsed = JSON.parse(raw) as { id?: unknown };
  if (typeof parsed.id !== "string") {
    throw new Error(`expected string id in outgoing frame, got ${raw}`);
  }
  return parsed.id;
}

describe("AgentClientConnection.resolve — registered tagged-error decode", () => {
  it("preserves the wire frame's `data` payload on a registered error code", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wireData = { agentIds: ["agent-a", "agent-b"] } as const;
          // Capture the request id the client mints on the first write.
          // Effect.ignore makes a second write (none expected) a no-op.
          const idDef = yield* Deferred.make<string>();
          const client = yield* makeAgentClientConnection<never, never>({
            id: "test-originator",
            handlers: {},
            write: (raw) =>
              Deferred.succeed(idDef, parseRequestId(raw)).pipe(Effect.ignore),
            idPrefix: "test",
          });

          // Issue the call on a fiber so it parks on the deferred while
          // the test feeds an inbound error frame via `resolve`. The
          // typed `call` constraint is the per-kind outbound catalog;
          // here we exercise the resolver against a synthetic descriptor
          // (not part of the production catalog) so we widen the call
          // type for this test boundary only.
          type CallAny = <D extends typeof TestEcho>(
            d: D,
            p: {},
          ) => ReturnType<typeof client.call>;
          const callFiber = yield* Effect.fork(
            (client.call as CallAny)(TestEcho, {}),
          );
          const outgoingId = yield* Deferred.await(idDef);

          const inbound: ResponseFrame = responseFrame(outgoingId, {
            error: {
              code: ForbiddenError.code,
              message: "denied",
              data: wireData,
            },
          });

          const handled = yield* client.resolve(inbound);
          expect(handled).toBe(true);

          const exit = yield* Effect.exit(Fiber.join(callFiber));
          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;

          const value = Option.getOrNull(Cause.failureOption(exit.cause));
          expect(value).toBeInstanceOf(ForbiddenError);
          expect((value as ForbiddenError).data).toEqual(wireData);
        }),
      ),
    ));
});
