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

/** Provides the presence category runtime value. */
export const PRESENCE_CATEGORY = "presence";
/** Provides the presence default timeout ms runtime value. */
export const PRESENCE_DEFAULT_TIMEOUT_MS = 5000;

// Matches the server-derived presence status schema. `working` is driven by
// the LeaseRegistry-grant lifecycle.
/** Represents presence status values. */
export type PresenceStatus = "online" | "working" | "offline";

/** Describes presence status entry. */
export interface PresenceStatusEntry {
  readonly agentId: AgentId;
  readonly status: PresenceStatus;
}

/** Describes presence actor. */
export interface PresenceActor {
  readonly agent: TestAgent;
  readonly client: AgentTestClient;
}

/**
 * Executes the presence violation operation.
 * @param name Name of the operation.
 * @param reason Value supplied to the operation.
 * @returns The presence violation result.
 */
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

/**
 * Registers agent.
 * @param ctx Context for the operation.
 * @param propertyName Value supplied to the operation.
 * @param name Name of the operation.
 * @returns The register agent result.
 */
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

/**
 * Executes the acquire client operation.
 * @param ctx Context for the operation.
 * @param propertyName Value supplied to the operation.
 * @param name Name of the operation.
 * @returns The acquire client result.
 */
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

/**
 * Executes the acquire closeable client operation.
 * @param ctx Context for the operation.
 * @param propertyName Value supplied to the operation.
 * @param agent Agent fixture that performs the operation.
 * @param label Value supplied to the operation.
 * @returns The acquire closeable client result.
 */
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
