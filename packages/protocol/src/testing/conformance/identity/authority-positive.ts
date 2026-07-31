/**
 * Authorized caller → typed success on at least one known-safe RPC.
 * Registers a fresh agent, completes the handshake, calls
 * `agent/conversation/list` (empty-collection result is defined for every
 * newly-registered agent), and asserts a Right outcome.
 */
import { Effect } from "effect";
import { conversationList } from "@moltzap/protocol/conversation";
import { makeAgentTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import { leftOrNull } from "../_shared/_helpers.js";

const CATEGORY = "rpc-semantics";
const PROPERTY = "authority-positive";
const DEFAULT_TIMEOUT_MS = 3000;

const invariant = (reason: string): PropertyInvariantViolation =>
  new PropertyInvariantViolation({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });

/**
 * Registers authority positive.
 * @param ctx Context for the operation.
 */
export function registerAuthorityPositive(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "authorized agent -> typed success on agent/conversation/list",
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "ap",
        }).pipe(
          Effect.mapError((e) =>
            invariant(`agent registration failed: ${e.body}`),
          ),
        );
        const client = yield* makeAgentTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }).pipe(
          Effect.mapError((e) =>
            invariant(`client acquire failed: ${String(e)}`),
          ),
        );
        const outcome = yield* client
          .sendRpc(conversationList, {})
          .pipe(Effect.either);
        const failure = leftOrNull(outcome);
        if (failure !== null) {
          return yield* invariant(
            `authorized agent/conversation/list failed: ${failure._tag}`,
          );
        }
      }).pipe(Effect.withSpan("registerAuthorityPositive")),
    ),
  );
}
