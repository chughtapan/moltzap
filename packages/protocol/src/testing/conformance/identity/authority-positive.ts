/**
 * Authorized caller → typed success on at least one known-safe RPC.
 * Registers a fresh agent, completes the handshake, calls
 * `conversations/list` (empty-collection result is defined for every
 * newly-registered agent), asserts a Right outcome.
 */
import { Effect } from "effect";
import { ConversationsList } from "../../../task/methods.js";
import { makeTestClient } from "../../test-client.js";
import { registerTestAgent } from "../../agent-registration.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import { leftOrNull } from "../_shared/_helpers.js";

const CATEGORY = "rpc-semantics" as const;
const PROPERTY = "authority-positive";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

export function registerAuthorityPositive(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "authorized agent → typed success on conversations/list",
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "ap",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason: `agent registration failed: ${e.body}`,
              }),
          ),
        );
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason: `client acquire failed: ${String(e)}`,
              }),
          ),
        );
        const outcome = yield* client
          .sendRpc(ConversationsList, {})
          .pipe(Effect.either);
        const failure = leftOrNull(outcome);
        if (failure !== null) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `authorized conversations/list failed: ${failure._tag}`,
            }),
          );
        }
      }),
    ),
  );
}
