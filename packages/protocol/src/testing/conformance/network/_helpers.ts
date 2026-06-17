/**
 * Network-layer helpers shared by presence properties.
 */
import { Effect, type Scope } from "effect";

import type { AgentId } from "#identity";
import {
  makeAgentTestClient,
  makeCloseableAgentTestClient,
  type AgentTestClient,
  type CloseableAgentTestClient,
} from "../_shared/driver/test-client.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyInvariantViolation } from "../_shared/registry.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";

export const PRESENCE_CATEGORY = "presence" as const;
export const PRESENCE_DEFAULT_TIMEOUT_MS = 5000;

// Matches the server-derived presence status schema. `working` is driven by
// the LeaseRegistry-grant lifecycle.
export type PresenceStatus = "online" | "working" | "offline";

export interface PresenceStatusEntry {
  readonly agentId: AgentId;
  readonly status: PresenceStatus;
}

export interface PresenceActor {
  readonly agent: TestAgent;
  readonly client: AgentTestClient;
}

export function presenceViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation {
  return new PropertyInvariantViolation({
    category: PRESENCE_CATEGORY,
    name,
    reason,
  });
}

export function registerAgent(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<TestAgent, PropertyInvariantViolation> {
  return registerTestAgent({
    baseUrl: ctx.realServer.baseUrl,
    name,
  }).pipe(
    Effect.mapError((e) =>
      presenceViolation(
        propertyName,
        `register(${name}): status=${e.status} body=${e.body}`,
      ),
    ),
  );
}

export function acquireClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<PresenceActor, PropertyInvariantViolation, Scope.Scope> {
  return Effect.gen(function* () {
    const agent = yield* registerAgent(ctx, propertyName, name);
    const client = yield* makeAgentTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      defaultTimeoutMs: PRESENCE_DEFAULT_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((e) =>
        presenceViolation(
          propertyName,
          `makeAgentTestClient(${name}): ${String(e)}`,
        ),
      ),
    );
    return { agent, client };
  }).pipe(Effect.withSpan("acquireClient"));
}

export function acquireCloseableClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  agent: TestAgent,
  label: string,
): Effect.Effect<
  CloseableAgentTestClient,
  PropertyInvariantViolation,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const client = yield* makeCloseableAgentTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      defaultTimeoutMs: PRESENCE_DEFAULT_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((e) =>
        presenceViolation(
          propertyName,
          `makeCloseableAgentTestClient(${label}): ${String(e)}`,
        ),
      ),
    );
    yield* Effect.addFinalizer(() =>
      client.close.pipe(Effect.orElseSucceed(() => undefined)),
    );
    return client;
  }).pipe(Effect.withSpan("acquireCloseableClient"));
}
