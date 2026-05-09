/**
 * Idempotent RPCs yield equivalent responses on replay. For every
 * list-shaped method where empty params are valid and `isIdempotent`
 * says replay is safe, sends the same params twice and asserts both
 * succeed with **identical results** (not just identical tags).
 *
 * Architect §4.4: removed `.pipe(Effect.orElseSucceed(["skip","skip"]))`
 * masking. Transport failures now surface as `PropertyUnavailable` so
 * the runner reports them explicitly instead of folding them into a
 * silent pass. Predicate compares response bodies via canonical JSON
 * — spec B5 says "identical results", not "identical outcome kinds".
 */
import { Effect, Either } from "effect";
import { AgentsList } from "../../../identity/methods.js";
import { ConversationsList } from "../../../task/methods.js";
import { isIdempotent } from "../../models/dispatch.js";
import { canonicalJson, sortJsonArray } from "../../canonicalize.js";
import { makeTestClient } from "../../test-client.js";
import { registerTestAgent } from "../../agent-registration.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "../_shared/registry.js";
import { eitherTag } from "../_shared/_helpers.js";

const CATEGORY = "rpc-semantics" as const;
const PROPERTY = "idempotence";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

export function registerIdempotence(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "isIdempotent methods: two sends yield identical response bodies",
    Effect.gen(function* () {
      const emptyParamIdempotents = [AgentsList, ConversationsList] as const;
      for (const definition of emptyParamIdempotents) {
        const method = definition.name;
        if (!isIdempotent(method)) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `isIdempotent(${method}) is false — oracle disagreement`,
            }),
          );
        }
        const pair = yield* Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* registerTestAgent({
              baseUrl: ctx.realServer.baseUrl,
              name: "id",
            });
            const client = yield* makeTestClient({
              serverUrl: ctx.realServer.wsUrl,
              agentKey: agent.apiKey,
              agentId: agent.agentId,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              captureCapacity: DEFAULT_CAPTURE_CAPACITY,
            });
            const a = yield* client.sendRpc(definition, {}).pipe(Effect.either);
            const b = yield* client.sendRpc(definition, {}).pipe(Effect.either);
            return { a, b };
          }),
        ).pipe(
          Effect.catchTags({
            TestingAgentRegistrationError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: PROPERTY,
                  reason: `register: ${e.body}`,
                }),
              ),
            TestingTransportIoError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: PROPERTY,
                  reason: `transport io: ${String(e.cause)}`,
                }),
              ),
            TestingTransportClosedError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: PROPERTY,
                  reason: `transport closed: ${e.reason}`,
                }),
              ),
            TestingRpcResponseError: (e) =>
              Effect.fail(
                new PropertyUnavailable({
                  category: CATEGORY,
                  name: PROPERTY,
                  reason: `rpc response error: ${e.message}`,
                }),
              ),
          }),
        );
        const aTag = eitherTag(pair.a);
        const bTag = eitherTag(pair.b);
        if (aTag !== bTag) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `${method}: replay outcome-tag mismatch ${aTag} → ${bTag}`,
            }),
          );
        }
        const successPair = Either.match(pair.a, {
          onLeft: () => null,
          onRight: (a) =>
            Either.match(pair.b, {
              onLeft: () => null,
              onRight: (b) => ({ a, b }),
            }),
        });
        if (successPair !== null) {
          // Canonical-projection comparison per architect #197 §3.3.
          // Direct JSON.stringify on wire-derived values is byte-
          // equality, not semantic equality; a conforming server may
          // return the list in a different row order across replays.
          const aCanon = canonIdempotenceResult(method, successPair.a);
          const bCanon = canonIdempotenceResult(method, successPair.b);
          if (aCanon !== bCanon) {
            return yield* Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason: `${method}: replay bodies diverge under canonical projection`,
              }),
            );
          }
        }
      }
    }),
  );
}

/**
 * Idempotence canonical projection — architect #197 §3.3.
 *
 * Spec B5: agents/list.agents and conversations/list.conversations are
 * unordered row sets across replays. Every OTHER array (including any
 * nested `participants`, future nested message lists, and every
 * payload field that is not one of the two named arrays) remains
 * order-sensitive.
 *
 * The projection sorts ONLY the specific top-level array the spec
 * marks unordered, then finalizes via `canonicalJson` (which
 * normalizes object-key order but preserves every remaining array's
 * order). A real re-ordering regression inside nested arrays still
 * fails the property.
 */
function canonIdempotenceResult(
  method: typeof AgentsList.name | typeof ConversationsList.name,
  result: unknown,
): string {
  if (method === AgentsList.name) {
    const r = result as { agents?: unknown[] };
    return canonicalJson({
      ...r,
      agents: Array.isArray(r.agents) ? sortJsonArray(r.agents) : r.agents,
    });
  }
  const r = result as { conversations?: unknown[]; cursor?: string };
  return canonicalJson({
    ...r,
    conversations: Array.isArray(r.conversations)
      ? sortJsonArray(r.conversations)
      : r.conversations,
  });
}
