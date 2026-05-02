/**
 * Presence — properties pinning the connect/disconnect-driven
 * `presence/changed` invariant. The `presence/update` RPC path is
 * covered elsewhere; these properties pin the LIFECYCLE-driven path.
 * Closes arena#252.
 */
import { Effect, Stream, Duration, type Scope } from "effect";

import { PROTOCOL_VERSION } from "../../version.js";
import { EventNames } from "../../schema/events.js";
import { PresenceSubscribe } from "../../schema/methods/presence.js";
import {
  makeCloseableTestClient,
  makeTestClient,
  type CloseableTestClient,
  type TestClient,
} from "../test-client.js";
import { registerTestAgent, type TestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import { PropertyInvariantViolation, registerProperty } from "./registry.js";

const CATEGORY = "presence" as const;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CAPTURE_CAPACITY = 256;

type PresenceStatus = "online" | "offline" | "away";

interface PresenceChangedPayload {
  readonly agentId: string;
  readonly status: PresenceStatus;
}

function violation(name: string, reason: string): PropertyInvariantViolation {
  return new PropertyInvariantViolation({ category: CATEGORY, name, reason });
}

function registerAgent(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<TestAgent, PropertyInvariantViolation> {
  return registerTestAgent({
    baseUrl: ctx.realServer.baseUrl,
    name,
  }).pipe(
    Effect.mapError((e) =>
      violation(
        propertyName,
        `register(${name}): status=${e.status} body=${e.body}`,
      ),
    ),
  );
}

function acquireClient(
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
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        violation(propertyName, `makeTestClient(${name}): ${String(e)}`),
      ),
    );
    return { agent, client };
  });
}

function acquireCloseableClient(
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
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        violation(
          propertyName,
          `makeCloseableTestClient(${label}): ${String(e)}`,
        ),
      ),
    ),
    (client) => client.close.pipe(Effect.orElseSucceed(() => undefined)),
  );
}

function subscribePresence(
  subscriber: TestClient,
  agentId: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return subscriber
    .sendRpc(PresenceSubscribe.name, { agentIds: [agentId] })
    .pipe(
      Effect.mapError((e) =>
        violation(propertyName, `presence/subscribe failed: ${String(e)}`),
      ),
      Effect.asVoid,
    );
}

/**
 * `TestClient.waitForEvent` matches by event name only. We need a
 * payload predicate, so consume the events Stream with a filter and
 * timeout it ourselves.
 */
function waitForPresenceWithStatus(
  client: TestClient,
  expected: PresenceChangedPayload,
  propertyName: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Effect.Effect<void, PropertyInvariantViolation> {
  return client.events.pipe(
    Stream.filter((frame) => frame.event === EventNames.PresenceChanged),
    Stream.map((frame) => frame.data as PresenceChangedPayload | undefined),
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
        violation(
          propertyName,
          `timed out waiting for presence/changed { agentId: ${expected.agentId}, status: ${expected.status} }`,
        ),
    }),
    Effect.mapError((e) =>
      e instanceof PropertyInvariantViolation
        ? e
        : violation(propertyName, `event stream errored: ${String(e)}`),
    ),
    Effect.flatMap((maybe) =>
      maybe._tag === "Some"
        ? Effect.void
        : Effect.fail(
            violation(
              propertyName,
              `event stream closed before presence/changed { agentId: ${expected.agentId}, status: ${expected.status} } arrived`,
            ),
          ),
    ),
  );
}

function presenceStatusesFor(
  client: TestClient,
  agentId: string,
): Effect.Effect<ReadonlyArray<PresenceStatus>> {
  return client.snapshot.pipe(
    Effect.map((snap) =>
      snap.flatMap((s) => {
        if (s.kind !== "inbound") return [];
        const frame = s.frame;
        if (!frame || frame.type !== "event") return [];
        if (frame.event !== EventNames.PresenceChanged) return [];
        const data = frame.data as PresenceChangedPayload | undefined;
        if (data === undefined || data.agentId !== agentId) return [];
        return [data.status];
      }),
    ),
  );
}

function countPresenceChangedFor(
  client: TestClient,
  agentId: string,
): Effect.Effect<number> {
  return presenceStatusesFor(client, agentId).pipe(Effect.map((s) => s.length));
}

export function registerConnectBroadcast(ctx: ConformanceRunContext): void {
  const NAME = "connect-broadcast";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "auth/connect after subscribe ⇒ subscriber receives presence/changed { online }",
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* acquireClient(ctx, NAME, "p1-sub");
        const a = yield* registerAgent(ctx, NAME, "p1-a");
        yield* subscribePresence(sub.client, a.agentId, NAME);
        yield* acquireCloseableClient(ctx, NAME, a, "p1-a-client");
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );
      }),
    ),
  );
}

export function registerDisconnectBroadcast(ctx: ConformanceRunContext): void {
  const NAME = "disconnect-broadcast";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "ws-close after auth/connect ⇒ subscriber receives presence/changed { offline } strictly after { online }",
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* acquireClient(ctx, NAME, "p2-sub");
        const a = yield* registerAgent(ctx, NAME, "p2-a");
        yield* subscribePresence(sub.client, a.agentId, NAME);
        const aClient = yield* acquireCloseableClient(
          ctx,
          NAME,
          a,
          "p2-a-client",
        );
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );
        yield* aClient.close;
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "offline" },
          NAME,
        );
      }),
    ),
  );
}

/**
 * Sequential reconnect only. The wait for `offline` between client #1
 * close and client #2 connect is the in-band fence proving the server's
 * onExit reached `setOffline` before the new handshake. Concurrent
 * reconnect (new auth/connect races old onExit) is OOS — see OQ6.
 */
export function registerReconnectStorm(ctx: ConformanceRunContext): void {
  const NAME = "reconnect-storm";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "online → offline → online lands as three presence/changed events in strict order on a sequential reconnect",
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* acquireClient(ctx, NAME, "p3-sub");
        const a = yield* registerAgent(ctx, NAME, "p3-a");
        yield* subscribePresence(sub.client, a.agentId, NAME);

        const c1 = yield* acquireCloseableClient(ctx, NAME, a, "p3-a-client-1");
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );
        yield* c1.close;
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "offline" },
          NAME,
        );

        yield* acquireCloseableClient(ctx, NAME, a, "p3-a-client-2");
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );

        const sequence = yield* presenceStatusesFor(sub.client, a.agentId);
        if (
          sequence.length !== 3 ||
          sequence[0] !== "online" ||
          sequence[1] !== "offline" ||
          sequence[2] !== "online"
        ) {
          return yield* Effect.fail(
            violation(
              NAME,
              `expected [online, offline, online], got [${sequence.join(", ")}]`,
            ),
          );
        }
      }),
    ),
  );
}

/**
 * Re-sending auth/connect on an already-authenticated WS short-circuits
 * to buildHelloOk (`auth.handlers.ts:71`) which calls setOnline again.
 * The idempotency guard MUST suppress the redundant broadcast.
 */
export function registerSameStateNoDoubleFire(
  ctx: ConformanceRunContext,
): void {
  const NAME = "same-state-no-double-fire";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "redundant setOnline (auth/connect on already-authenticated WS) does NOT double-fire presence/changed",
    Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* acquireClient(ctx, NAME, "p4-sub");
        const a = yield* registerAgent(ctx, NAME, "p4-a");
        yield* subscribePresence(sub.client, a.agentId, NAME);
        const aClient = yield* acquireCloseableClient(
          ctx,
          NAME,
          a,
          "p4-a-client",
        );
        yield* waitForPresenceWithStatus(
          sub.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );

        yield* aClient
          .sendRpc("auth/connect", {
            agentKey: a.apiKey,
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          })
          .pipe(
            Effect.mapError((e) =>
              violation(NAME, `auth/connect re-send failed: ${String(e)}`),
            ),
          );

        // Stabilization window — give a regression a chance to land.
        yield* Effect.sleep("250 millis");
        const count = yield* countPresenceChangedFor(sub.client, a.agentId);
        if (count !== 1) {
          return yield* Effect.fail(
            violation(
              NAME,
              `expected 1 event for ${a.agentId}, observed ${count}`,
            ),
          );
        }
      }),
    ),
  );
}

export function registerMultiSubscriberFanOut(
  ctx: ConformanceRunContext,
): void {
  const NAME = "multi-subscriber-fan-out";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "auth/connect with N subscribers ⇒ exactly N presence/changed { online } events (one per subscriber)",
    Effect.scoped(
      Effect.gen(function* () {
        const s1 = yield* acquireClient(ctx, NAME, "p5-s1");
        const s2 = yield* acquireClient(ctx, NAME, "p5-s2");
        const a = yield* registerAgent(ctx, NAME, "p5-a");
        yield* subscribePresence(s1.client, a.agentId, NAME);
        yield* subscribePresence(s2.client, a.agentId, NAME);
        yield* acquireCloseableClient(ctx, NAME, a, "p5-a-client");

        yield* waitForPresenceWithStatus(
          s1.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );
        yield* waitForPresenceWithStatus(
          s2.client,
          { agentId: a.agentId, status: "online" },
          NAME,
        );

        const c1 = yield* countPresenceChangedFor(s1.client, a.agentId);
        const c2 = yield* countPresenceChangedFor(s2.client, a.agentId);
        if (c1 !== 1 || c2 !== 1) {
          return yield* Effect.fail(
            violation(
              NAME,
              `expected exactly 1 event per subscriber, observed s1=${c1} s2=${c2}`,
            ),
          );
        }
      }),
    ),
  );
}

export function registerSubscribeAfterConnect(
  ctx: ConformanceRunContext,
): void {
  const NAME = "subscribe-after-connect";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "subscribing AFTER an agent connects ⇒ snapshot reflects status: online",
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* registerAgent(ctx, NAME, "p6-a");
        yield* acquireCloseableClient(ctx, NAME, a, "p6-a-client");

        const sub = yield* acquireClient(ctx, NAME, "p6-sub");
        const result = yield* sub.client
          .sendRpc(PresenceSubscribe.name, { agentIds: [a.agentId] })
          .pipe(
            Effect.mapError((e) =>
              violation(NAME, `presence/subscribe failed: ${String(e)}`),
            ),
          );
        const statuses = (
          result as {
            statuses: ReadonlyArray<PresenceChangedPayload>;
          }
        ).statuses;
        if (statuses.length !== 1) {
          return yield* Effect.fail(
            violation(NAME, `expected 1 status entry, got ${statuses.length}`),
          );
        }
        const entry = statuses[0]!;
        if (entry.agentId !== a.agentId || entry.status !== "online") {
          return yield* Effect.fail(
            violation(
              NAME,
              `expected { agentId: ${a.agentId}, status: online }, got ${JSON.stringify(entry)}`,
            ),
          );
        }
      }),
    ),
  );
}
