/**
 * Network-layer helpers shared by presence properties.
 *
 * Carved verbatim from `conformance/presence.ts@961a5c8`. Body
 * unchanged; import paths shift to the new layer location.
 */
import { Effect, Option, Stream, Duration, type Scope } from "effect";
import type { Static } from "@sinclair/typebox";

import { PresenceChangedNotificationDefinition } from "@moltzap/protocol/network";
import { notificationDefinitions } from "../../../rpc-registry.js";
import {
  decodeNotification,
  isDecodedNotification,
} from "../../../transport/rpc-groups.js";
import { PresenceSubscribe } from "@moltzap/protocol/network";
import { AgentId } from "@moltzap/protocol/identity";
import {
  makeCloseableTestClient,
  makeTestClient,
  type CloseableTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import { isNotificationFrame } from "../_shared/frame-mutator.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { PropertyInvariantViolation } from "../_shared/registry.js";

export const PRESENCE_CATEGORY = "presence" as const;
export const PRESENCE_DEFAULT_TIMEOUT_MS = 5000;
export const PRESENCE_DEFAULT_CAPTURE_CAPACITY = 256;

export type PresenceStatus = "online" | "offline" | "away";
type AgentIdValue = Static<typeof AgentId>;

export interface PresenceChangedPayload {
  readonly agentId: string;
  readonly status: PresenceStatus;
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
): Effect.Effect<
  { agent: TestAgent; client: TestClient },
  PropertyInvariantViolation,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const agent = yield* registerAgent(ctx, propertyName, name);
    const client = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: PRESENCE_DEFAULT_TIMEOUT_MS,
      captureCapacity: PRESENCE_DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        presenceViolation(
          propertyName,
          `makeTestClient(${name}): ${String(e)}`,
        ),
      ),
    );
    return { agent, client };
  });
}

export function acquireCloseableClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  agent: TestAgent,
  label: string,
): Effect.Effect<CloseableTestClient, PropertyInvariantViolation, Scope.Scope> {
  // makeCloseableTestClient owns its own internal scope; without a
  // release finalizer, returning the client leaks the WebSocket past
  // the property boundary. acquireRelease ties teardown to the
  // surrounding Effect.scoped.
  return Effect.acquireRelease(
    makeCloseableTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: PRESENCE_DEFAULT_TIMEOUT_MS,
      captureCapacity: PRESENCE_DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        presenceViolation(
          propertyName,
          `makeCloseableTestClient(${label}): ${String(e)}`,
        ),
      ),
    ),
    (client) => client.close.pipe(Effect.orElseSucceed(() => undefined)),
  );
}

export function subscribePresence(
  subscriber: TestClient,
  agentId: AgentIdValue,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return subscriber.sendRpc(PresenceSubscribe, { agentIds: [agentId] }).pipe(
    Effect.mapError((e) =>
      presenceViolation(
        propertyName,
        `presence/subscribe failed: ${String(e)}`,
      ),
    ),
    Effect.asVoid,
  );
}

/**
 * `TestClient.waitForNotification` matches by descriptor only. We need a
 * payload predicate, so consume the notification Stream with a filter and
 * timeout it ourselves.
 */
export function waitForPresenceWithStatus(
  client: TestClient,
  expected: PresenceChangedPayload,
  propertyName: string,
  timeoutMs: number = PRESENCE_DEFAULT_TIMEOUT_MS,
): Effect.Effect<void, PropertyInvariantViolation> {
  return client.notifications.pipe(
    Stream.filter(
      (frame) => frame.definition === PresenceChangedNotificationDefinition,
    ),
    Stream.map((frame) => frame.params as PresenceChangedPayload | undefined),
    Stream.filter(
      (data): data is PresenceChangedPayload =>
        data !== undefined &&
        data.agentId === expected.agentId &&
        data.status === expected.status,
    ),
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        presenceViolation(
          propertyName,
          `timed out waiting for presence/changed { agentId: ${expected.agentId}, status: ${expected.status} }`,
        ),
    }),
    Effect.mapError((e) =>
      e instanceof PropertyInvariantViolation
        ? e
        : presenceViolation(propertyName, `event stream errored: ${String(e)}`),
    ),
    Effect.flatMap((maybe) =>
      maybe._tag === "Some"
        ? Effect.void
        : Effect.fail(
            presenceViolation(
              propertyName,
              `event stream closed before presence/changed { agentId: ${expected.agentId}, status: ${expected.status} } arrived`,
            ),
          ),
    ),
  );
}

export function presenceStatusesFor(
  client: TestClient,
  agentId: AgentIdValue,
): Effect.Effect<ReadonlyArray<PresenceStatus>> {
  return Effect.gen(function* () {
    const snap = yield* client.snapshot;
    const statuses: PresenceStatus[] = [];
    for (const s of snap) {
      if (s.kind !== "inbound") continue;
      const frame = s.frame;
      if (frame === null || !isNotificationFrame(frame)) continue;
      const notification = yield* decodeNotification(
        notificationDefinitions,
        frame,
      ).pipe(Effect.option);
      const presenceNotification = Option.filter(notification, (decoded) =>
        isDecodedNotification(PresenceChangedNotificationDefinition, decoded),
      );
      if (Option.isNone(presenceNotification)) {
        continue;
      }
      const data = presenceNotification.value.params;
      if (data.agentId !== agentId) continue;
      statuses.push(data.status);
    }
    return statuses;
  });
}

export function countPresenceChangedFor(
  client: TestClient,
  agentId: AgentIdValue,
): Effect.Effect<number> {
  return presenceStatusesFor(client, agentId).pipe(Effect.map((s) => s.length));
}
