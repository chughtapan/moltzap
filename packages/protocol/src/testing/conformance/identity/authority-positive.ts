/**
 * Authorized caller → typed success on at least one known-safe RPC.
 * Registers a fresh agent, completes the handshake, calls
 * `agent/task/list` (empty-collection result is defined for every
 * newly-registered agent), and asserts a Right outcome.
 */
import { Effect } from "effect";
import { TaskList } from "@moltzap/protocol/task";
import { makeAgentTestClient } from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import { leftOrNull } from "../_shared/_helpers.js";

const CATEGORY = "rpc-semantics" as const;
const PROPERTY = "authority-positive";
const DEFAULT_TIMEOUT_MS = 3000;

const invariant = (reason: string): PropertyInvariantViolation =>
  new PropertyInvariantViolation({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });

export function registerAuthorityPositive(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "authorized agent -> typed success on agent/task/list",
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
        const outcome = yield* client.sendRpc(TaskList, {}).pipe(Effect.either);
        const failure = leftOrNull(outcome);
        if (failure !== null) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `authorized agent/task/list failed: ${failure._tag}`,
            }),
          );
        }
      }).pipe(Effect.withSpan("registerAuthorityPositive")),
    ),
  );
}
