/**
 * Delivery — properties that exercise multi-connection invariants
 * against the real server: fan-out cardinality, store-and-replay,
 * payload opacity, and task-boundary isolation.
 *
 * Historical grouping note: spec #181 §5 calls this "Tier C". Code uses
 * semantic names only.
 *
 * Principle 3: every property body is `Effect<void, PropertyFailure>`.
 */
import * as fc from "fast-check";
import { Effect, Either, Ref, type Scope } from "effect";
import { ErrorCodes } from "../../schema/errors.js";
import { EventNames } from "../../schema/events.js";
import {
  AppsCloseSession,
  AppsCreate,
  AppsRegister,
} from "../../schema/methods/apps.js";
import {
  ConversationsArchive,
  ConversationsCreate,
  ConversationsUnarchive,
  ConversationsUpdate,
} from "../../schema/methods/conversations.js";
import { MessagesSend } from "../../schema/methods/messages.js";
import { RpcResponseError } from "../errors.js";
import { makeTestClient, type TestClient } from "../test-client.js";
import { registerTestAgent, type TestAgent } from "../agent-registration.js";
import type { ConformanceRunContext } from "./runner.js";
import {
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  assertProperty,
  registerProperty,
} from "./registry.js";
import { leftOrNull, requireRight, sendUntypedRpc } from "./_helpers.js";

const CATEGORY = "delivery" as const;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CAPTURE_CAPACITY = 256;
const DEFAULT_PROPERTY_NUM_RUNS = 3;
const DATE_ID_RADIX = 36;
const MAX_N = 4;
const CONVERSATION_LIFECYCLE_PROPERTY = "conversation-lifecycle";
const APP_SESSION_CLOSE_LIFECYCLE_PROPERTY = "app-session-close-lifecycle";
const ARCHIVE_LIFECYCLE_PROPERTY = "archive-lifecycle";
const STORE_AND_REPLAY_PROPERTY = "store-and-replay";
const TASK_BOUNDARY_ISOLATION_PROPERTY = "task-boundary-isolation";

interface ConversationFixture {
  readonly owner: { agent: TestAgent; client: TestClient };
  readonly participants: ReadonlyArray<{
    agent: TestAgent;
    client: TestClient;
  }>;
  readonly conversationId: string;
}

type ConversationActor = {
  readonly agent: TestAgent;
  readonly client: TestClient;
};

type ArchiveEventData = {
  readonly conversationId?: unknown;
  readonly archivedAt?: unknown;
  readonly by?: unknown;
};

type ConversationEventData = {
  readonly conversation?: {
    readonly id?: unknown;
    readonly name?: unknown;
  };
};

type MessageEventData = {
  readonly message?: {
    readonly conversationId?: unknown;
  };
};

type AppSessionClosedEventData = {
  readonly sessionId?: unknown;
  readonly closedBy?: unknown;
};

type UnarchiveEventData = {
  readonly conversationId?: unknown;
  readonly by?: unknown;
};

function violation(name: string, reason: string): PropertyInvariantViolation {
  return new PropertyInvariantViolation({ category: CATEGORY, name, reason });
}

function acquirePropertyConversation(
  ctx: ConformanceRunContext,
  propertyName: string,
  namePrefix: string,
): Effect.Effect<ConversationFixture, PropertyInvariantViolation, Scope.Scope> {
  return acquireConversation(ctx, 1, namePrefix).pipe(
    Effect.mapError((e) => violation(propertyName, `fixture: ${e}`)),
  );
}

function firstParticipant(
  fixture: ConversationFixture,
  propertyName: string,
): Effect.Effect<ConversationActor, PropertyInvariantViolation> {
  const participant = fixture.participants[0];
  return participant === undefined
    ? Effect.fail(violation(propertyName, "fixture missing participant"))
    : Effect.succeed(participant);
}

function sendText(
  actor: ConversationActor,
  conversationId: string,
  text: string,
) {
  return actor.client.sendRpc(MessagesSend.name, {
    conversationId,
    parts: [{ type: "text", text }],
  });
}

function archiveConversation(actor: ConversationActor, conversationId: string) {
  return actor.client.sendRpc(ConversationsArchive.name, { conversationId });
}

function updateConversationName(
  actor: ConversationActor,
  conversationId: string,
  name: string,
) {
  return actor.client.sendRpc(ConversationsUpdate.name, {
    conversationId,
    name,
  });
}

function unarchiveConversation(
  actor: ConversationActor,
  conversationId: string,
) {
  return actor.client.sendRpc(ConversationsUnarchive.name, { conversationId });
}

function waitForConversationCreatedEvent(
  observer: ConversationActor,
  conversationId: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* observer.client
      .waitForEvent(EventNames.ConversationCreated, DEFAULT_TIMEOUT_MS)
      .pipe(
        Effect.mapError((e) =>
          violation(propertyName, `created event missing: ${e.message}`),
        ),
      );
    const data = event.data as ConversationEventData | undefined;
    if (data?.conversation?.id !== conversationId) {
      return yield* Effect.fail(
        violation(
          propertyName,
          `bad created event payload: ${JSON.stringify(event.data)}`,
        ),
      );
    }
  });
}

function waitForConversationUpdatedEvent(
  observer: ConversationActor,
  conversationId: string,
  name: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* observer.client
      .waitForEvent(EventNames.ConversationUpdated, DEFAULT_TIMEOUT_MS)
      .pipe(
        Effect.mapError((e) =>
          violation(propertyName, `updated event missing: ${e.message}`),
        ),
      );
    const data = event.data as ConversationEventData | undefined;
    if (
      data?.conversation?.id !== conversationId ||
      data.conversation.name !== name
    ) {
      return yield* Effect.fail(
        violation(
          propertyName,
          `bad updated event payload: ${JSON.stringify(event.data)}`,
        ),
      );
    }
  });
}

function waitForMessageReceivedEvent(
  observer: ConversationActor,
  conversationId: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* observer.client
      .waitForEvent(EventNames.MessageReceived, DEFAULT_TIMEOUT_MS)
      .pipe(
        Effect.mapError((e) =>
          violation(propertyName, `message event missing: ${e.message}`),
        ),
      );
    const data = event.data as MessageEventData | undefined;
    if (data?.message?.conversationId !== conversationId) {
      return yield* Effect.fail(
        violation(
          propertyName,
          `bad message event payload: ${JSON.stringify(event.data)}`,
        ),
      );
    }
  });
}

function waitForAppSessionClosedEvent(
  observer: ConversationActor,
  sessionId: string,
  closedBy: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* observer.client
      .waitForEvent(EventNames.AppSessionClosed, DEFAULT_TIMEOUT_MS)
      .pipe(
        Effect.mapError((e) =>
          violation(propertyName, `session closed event missing: ${e.message}`),
        ),
      );
    const data = event.data as AppSessionClosedEventData | undefined;
    if (data?.sessionId !== sessionId || data.closedBy !== closedBy) {
      return yield* Effect.fail(
        violation(
          propertyName,
          `bad session closed event payload: ${JSON.stringify(event.data)}`,
        ),
      );
    }
  });
}

function waitForArchivedEvent(
  observer: ConversationActor,
  conversationId: string,
  byAgentId: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* observer.client
      .waitForEvent(EventNames.ConversationArchived, DEFAULT_TIMEOUT_MS)
      .pipe(
        Effect.mapError((e) =>
          violation(propertyName, `archive event missing: ${e.message}`),
        ),
      );
    const data = event.data as ArchiveEventData | undefined;
    if (
      data?.conversationId !== conversationId ||
      typeof data.archivedAt !== "string" ||
      data.by !== byAgentId
    ) {
      return yield* Effect.fail(
        violation(
          propertyName,
          `bad archive event payload: ${JSON.stringify(event.data)}`,
        ),
      );
    }
  });
}

function waitForUnarchivedEvent(
  observer: ConversationActor,
  conversationId: string,
  byAgentId: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const event = yield* observer.client
      .waitForEvent(EventNames.ConversationUnarchived, DEFAULT_TIMEOUT_MS)
      .pipe(
        Effect.mapError((e) =>
          violation(propertyName, `unarchive event missing: ${e.message}`),
        ),
      );
    const data = event.data as UnarchiveEventData | undefined;
    if (data?.conversationId !== conversationId || data.by !== byAgentId) {
      return yield* Effect.fail(
        violation(
          propertyName,
          `bad unarchive event payload: ${JSON.stringify(event.data)}`,
        ),
      );
    }
  });
}

function assertConversationRejectsMessages(
  actor: ConversationActor,
  conversationId: string,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const outcome = yield* sendText(
      actor,
      conversationId,
      "must-fail-while-archived",
    ).pipe(Effect.either);
    const outcomeViolation = Either.match(outcome, {
      onRight: () =>
        violation(propertyName, "messages/send succeeded while archived"),
      onLeft: (error) => {
        if (
          error instanceof RpcResponseError &&
          error.code === ErrorCodes.ConversationArchived
        ) {
          return null;
        }
        const errorLabel =
          error instanceof RpcResponseError
            ? `${error._tag}/${error.code}`
            : error._tag;
        return violation(
          propertyName,
          `messages/send returned ${errorLabel}, expected ConversationArchived`,
        );
      },
    });
    if (outcomeViolation !== null) {
      return yield* Effect.fail(outcomeViolation);
    }
  });
}

function acquireClient(
  ctx: ConformanceRunContext,
  name: string,
): Effect.Effect<
  { agent: TestAgent; client: TestClient },
  string,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name,
    }).pipe(Effect.mapError((e) => `register(${name}): ${e.body}`));
    const client = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(Effect.mapError((e) => `makeTestClient(${name}): ${String(e)}`));
    return { agent, client };
  });
}

function acquireConversation(
  ctx: ConformanceRunContext,
  n: number,
  namePrefix: string,
): Effect.Effect<ConversationFixture, string, Scope.Scope> {
  const clamped = Math.min(Math.max(1, n), MAX_N);
  return Effect.gen(function* () {
    const owner = yield* acquireClient(ctx, `${namePrefix}-owner`);
    const participants = yield* Effect.forEach(
      Array.from({ length: clamped }, (_, i) => i),
      (i) => acquireClient(ctx, `${namePrefix}-p${i}`),
      { concurrency: clamped },
    );
    const createResult = yield* owner.client
      .sendRpc(ConversationsCreate.name, {
        type: "group",
        name: `${namePrefix}-conv`,
        participants: participants.map((p) => ({
          type: "agent" as const,
          id: p.agent.agentId,
        })),
      })
      .pipe(Effect.either);
    const created = (yield* requireRight(
      createResult,
      (error) => `conversations/create failed: ${error._tag}`,
    )) as {
      conversation?: { id?: string };
    };
    const conversationId = created.conversation?.id;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return yield* Effect.fail(
        `conversations/create returned no conversation.id`,
      );
    }
    return { owner, participants, conversationId };
  });
}

/**
 * Fan-out cardinality — spec §5 C1: messages/send ⇒ **exactly** N
 * inbound events (one per connection). Architect §4.4: tightened from
 * `>=1` to `===1`; a server that duplicates events now fails.
 *
 * Empty-counts side channel replaced with an explicit
 * `PropertyInvariantViolation`.
 */
export function registerFanOutCardinality(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "fan-out-cardinality",
    "messages/send ⇒ exactly N inbound message events (one per connection)",
    assertProperty(CATEGORY, "fan-out-cardinality", () =>
      fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 3 }), (n) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const fixture = yield* acquireConversation(ctx, n, "fan").pipe(
                  Effect.mapError((e) =>
                    violation("fan-out-cardinality", `fixture: ${e}`),
                  ),
                );
                const send = yield* fixture.owner.client
                  .sendRpc(MessagesSend.name, {
                    conversationId: fixture.conversationId,
                    parts: [{ type: "text", text: "fan-out-ping" }],
                  })
                  .pipe(Effect.either);
                if (leftOrNull(send) !== null) {
                  return { kind: "send-failed" as const };
                }
                yield* Effect.sleep("250 millis");
                const observed = yield* Effect.forEach(
                  fixture.participants,
                  (p) => p.client.snapshot,
                );
                const counts = observed.map(
                  (snap) =>
                    snap.filter(
                      (s) =>
                        s.kind === "inbound" &&
                        s.frame?.type === "event" &&
                        typeof s.frame.event === "string" &&
                        s.frame.event.includes("message"),
                    ).length,
                );
                return { kind: "ok" as const, counts };
              }),
            ).pipe(
              Effect.map((result) => {
                if (result.kind !== "ok") return false;
                // Exact-cardinality predicate. Duplicates and drops both fail.
                return (
                  result.counts.length === fixture_n(n) &&
                  result.counts.every((c) => c === 1)
                );
              }),
            ),
          ),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DEFAULT_PROPERTY_NUM_RUNS,
        },
      ),
    ),
  );
}

function fixture_n(requested: number): number {
  return Math.min(Math.max(1, requested), MAX_N);
}

/**
 * Store-and-replay — spec §5 C2: offline-then-reconnect delivers the
 * messages sent during the disconnect window.
 *
 * **Status: architect §4.5 option (b) — property split.**
 *
 * Option (a) (reconnect via scope composition) was attempted and is
 * infrastructure-viable: TestClient supports re-opening with the same
 * apiKey/agentId via `Effect.scoped`, no new public primitive needed.
 * However, the current server implementation does not buffer events
 * for offline subscribers (empirical observation against
 * `startCoreTestServer` at commit time): after reconnect, the
 * participant's capture buffer contains zero of the N messages sent
 * during the offline window. This is a server-side gap against spec
 * §5 C2, not a TestClient gap.
 *
 * Per architect §4.5 option (b), this property is scoped to
 * **basic-delivery-landing** — the weaker invariant that N messages
 * sent to a live conversation land in every currently-subscribed
 * participant's capture buffer. The full offline-replay assertion is
 * tracked as a follow-up under epic #186. If/when the server
 * implements C2 replay, flip this body back to the reconnect form
 * from the git history and remove the #186 pointer.
 */
export function registerStoreAndReplay(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    STORE_AND_REPLAY_PROPERTY,
    "every messages/send lands in a live participant's capture buffer (basic-delivery-landing; #186 tracks C2 offline-replay)",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireConversation(ctx, 1, "sr").pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: STORE_AND_REPLAY_PROPERTY,
                reason: `fixture: ${e}`,
              }),
          ),
        );
        const participant = fixture.participants[0];
        if (participant === undefined) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: STORE_AND_REPLAY_PROPERTY,
              reason: "fixture missing participant",
            }),
          );
        }
        const sent = 3;
        for (let i = 0; i < sent; i++) {
          yield* fixture.owner.client
            .sendRpc(MessagesSend.name, {
              conversationId: fixture.conversationId,
              parts: [{ type: "text", text: `sr-${i}` }],
            })
            .pipe(Effect.either);
        }
        yield* Effect.sleep("350 millis");
        const snap = yield* participant.client.snapshot;
        const delivered = snap.filter(
          (s) =>
            s.kind === "inbound" &&
            s.frame?.type === "event" &&
            typeof s.frame.event === "string" &&
            s.frame.event.includes("message"),
        ).length;
        if (delivered < sent) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: STORE_AND_REPLAY_PROPERTY,
              reason: `sent ${sent}, live participant observed ${delivered}`,
            }),
          );
        }
      }),
    ),
  );
}

/** Payload opacity — sent text appears byte-for-byte in delivered events. */
export function registerPayloadOpacity(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "payload-opacity",
    "sent message text appears verbatim in delivered event bytes",
    assertProperty(CATEGORY, "payload-opacity", () =>
      fc.assert(
        fc.asyncProperty(
          // Exclude JSON-meta chars so a simple substring match is valid.
          fc
            .string({ minLength: 4, maxLength: 24 })
            .filter((s) => !/[\\" \n\r\t]/.test(s)),
          (text) =>
            Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const fixture = yield* acquireConversation(ctx, 1, "po").pipe(
                    Effect.mapError((e) =>
                      violation("payload-opacity", `fixture: ${e}`),
                    ),
                  );
                  const participant = fixture.participants[0];
                  if (participant === undefined) return false;
                  yield* fixture.owner.client.sendRpc(MessagesSend.name, {
                    conversationId: fixture.conversationId,
                    parts: [{ type: "text", text }],
                  });
                  yield* Effect.sleep("250 millis");
                  const snap = yield* participant.client.snapshot;
                  return snap.some(
                    (s) =>
                      s.kind === "inbound" &&
                      s.frame?.type === "event" &&
                      s.raw.includes(text),
                  );
                }),
              ).pipe(Effect.catchAll(() => Effect.succeed(false))),
            ),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DEFAULT_PROPERTY_NUM_RUNS,
        },
      ),
    ),
  );
}

/**
 * Hook-gated delivery — admission verbs are awaitable, the verdict
 * mutates the recipient view, dynamically attached conversations enter
 * the hook pipeline (mirrors `33-attach-conversation.integration.test.ts:312-369`).
 *
 * Architect plan §1.7 acceptance:
 *   - `before_message_delivery: { block: true }` drops the message before
 *     delivery (recipient does NOT observe it).
 *   - `block: false, patch: { parts: [...] }` lands a MUTATED message —
 *     recipient sees the patched parts, not the sender's parts.
 *   - `apps/attachConversation` adds a conversation to the session's
 *     hook pipeline; the same hook then fires for traffic on the new
 *     conversation.
 *
 * Conformance reach: the assertions are observable on the SENDER (deny
 * → typed dispatch error) and RECIPIENT (patched parts in inbound
 * event). Wiring the app session over WS requires `apps/create`, which
 * needs the initiator's `owner_user_id` to be non-null — see the
 * `app-disconnect-fail-policy` rationale in `boundary.ts`. When the
 * fixture's agents are owner-less (default `startCoreTestServer`), the
 * property reports `PropertyUnavailable` and B.9 carries the load.
 */
export function registerHookGatedDelivery(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "hook-gated-delivery",
    "deny drops; patch mutates recipient view; attached conv enters hooks",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireAppSessionFixture(
          ctx,
          "hgd",
          "hook-gated-delivery",
        ).pipe(Effect.either);
        yield* requireRight(fixture, (error) => error);
        // Codex review (#327, finding 4): the protocol fixture cannot
        // drive the deny/patch/attach scenarios end-to-end (no DB seam
        // to inspect the recipient view; `apps/attachConversation` is a
        // c2s RPC but the assertion needs a server-internal observation
        // the conformance contract does not expose). When a future
        // fixture extension makes apps/create reachable, surface a
        // typed Deferred so the suite reports honest coverage instead
        // of a vacuous pass.
        return yield* Effect.fail(
          new PropertyDeferred({
            category: CATEGORY,
            name: "hook-gated-delivery",
            followUp:
              "deny/patch/attach assertions live in B.9 server integration tests (#318) — protocol fixture lacks DB-level recipient inspection",
          }),
        );
      }),
    ),
  );
}

/**
 * Multi-app FIFO short-circuit — register two apps on the same hook,
 * first denies, assert second handler is NOT invoked. Architect plan
 * §3.4: `Effect.forEach(registeredApps, ...)` iterates in registration
 * order; first-deny short-circuits the loop.
 *
 * Same fixture constraint as `hook-gated-delivery`: requires app session
 * machinery. Reports `PropertyUnavailable` when prerequisites are
 * absent.
 */
export function registerMultiAppFifoShortCircuit(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    "multi-app-fifo-short-circuit",
    "two apps; first denies; second hook is NOT invoked",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireAppSessionFixture(
          ctx,
          "mfs",
          "multi-app-fifo-short-circuit",
        ).pipe(Effect.either);
        yield* requireRight(fixture, (error) => error);
        // Codex review (#327, finding 5): once apps/create succeeds, the
        // FIFO short-circuit assertion requires registering a SECOND
        // app on the same hook and observing the second handler is NOT
        // invoked — the protocol fixture exposes a single-app session.
        // B.9 covers via the dual-app wire fixture; surface a typed
        // Deferred here.
        return yield* Effect.fail(
          new PropertyDeferred({
            category: CATEGORY,
            name: "multi-app-fifo-short-circuit",
            followUp:
              "two-app dispatch + first-deny short-circuit assertion lives in B.9 server integration tests (#318)",
          }),
        );
      }),
    ),
  );
}

/**
 * App-session fixture — registers an app via WS, opens a session as a
 * sender, returns the live clients ready for hook-gated assertions.
 * Returns `PropertyUnavailable` when the prerequisite chain (agent
 * `owner_user_id` on the sender) cannot be satisfied through the
 * fixture's HTTP register endpoint. Callers pattern-match Left to
 * surface the typed unavailability.
 */
interface AppSessionFixture {
  readonly app: { agent: TestAgent; client: TestClient; appId: string };
  readonly sender: { agent: TestAgent; client: TestClient };
  readonly sessionId: string;
  readonly dispatchHits: Ref.Ref<number>;
}

interface AppSessionCloseFixture {
  readonly initiator: { agent: TestAgent; client: TestClient };
  readonly invitee: { agent: TestAgent; client: TestClient };
  readonly sessionId: string;
  readonly conversationId: string;
}

type AppCreateResultData = {
  readonly session?: {
    readonly id?: unknown;
    readonly conversations?: Record<string, unknown>;
  };
};

function acquireAppSessionFixture(
  ctx: ConformanceRunContext,
  namePrefix: string,
  propertyName: string,
): Effect.Effect<AppSessionFixture, PropertyUnavailable, Scope.Scope> {
  const unavailable = (reason: string): PropertyUnavailable =>
    new PropertyUnavailable({ category: CATEGORY, name: propertyName, reason });
  return Effect.gen(function* () {
    const appAgent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: `${namePrefix}-app`,
    }).pipe(
      Effect.mapError((e) => unavailable(`app agent register: ${e.body}`)),
    );
    const appClient = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: appAgent.apiKey,
      agentId: appAgent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) => unavailable(`app client acquire: ${String(e)}`)),
    );

    const appId = `${namePrefix}-${Date.now().toString(DATE_ID_RADIX)}`;
    const registerOutcome = yield* sendUntypedRpc(
      appClient,
      AppsRegister.name,
      {
        manifest: {
          appId,
          name: `Hook-gated app ${appId}`,
          permissions: { required: [], optional: [] },
          conversations: [
            { key: "main", name: "Main", participantFilter: "all" },
          ],
          hooks: {
            before_message_delivery: { timeout_ms: 5000 },
            on_join: {},
          },
        },
      },
    ).pipe(Effect.either);
    yield* requireRight(registerOutcome, (error) =>
      unavailable(`apps/register failed: ${error._tag}`),
    );

    const senderAgent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: `${namePrefix}-sender`,
    }).pipe(Effect.mapError((e) => unavailable(`sender register: ${e.body}`)));
    const senderClient = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: senderAgent.apiKey,
      agentId: senderAgent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        unavailable(`sender client acquire: ${String(e)}`),
      ),
    );

    const createOutcome = yield* senderClient
      .sendRpc(AppsCreate.name, { appId, invitedAgentIds: [] })
      .pipe(Effect.either);
    const createResult = yield* requireRight(createOutcome, (error) =>
      unavailable(
        // Most common cause: owner_user_id is null on the sender (see
        // app-host.ts:629). The default `startCoreTestServer` does not
        // configure `devModeUserId`; B.9 fills the gap via DB seeding.
        `apps/create failed (likely sender owner_user_id null; B.9 covers via DB seeding): ${error._tag}`,
      ),
    );

    const session = (createResult as { session?: { id?: string } }).session;
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return yield* Effect.fail(
        unavailable(`apps/create returned no session.id`),
      );
    }

    const dispatchHits = yield* Ref.make(0);
    return {
      app: { agent: appAgent, client: appClient, appId },
      sender: { agent: senderAgent, client: senderClient },
      sessionId,
      dispatchHits,
    } satisfies AppSessionFixture;
  });
}

function acquireAppSessionCloseFixture(
  ctx: ConformanceRunContext,
): Effect.Effect<
  AppSessionCloseFixture,
  PropertyUnavailable | PropertyInvariantViolation,
  Scope.Scope
> {
  const propertyName = APP_SESSION_CLOSE_LIFECYCLE_PROPERTY;
  const unavailable = (reason: string): PropertyUnavailable =>
    new PropertyUnavailable({ category: CATEGORY, name: propertyName, reason });
  return Effect.gen(function* () {
    const appAgent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "clapp",
      uniqueSuffix: false,
    }).pipe(
      Effect.mapError((e) => unavailable(`app agent register: ${e.body}`)),
    );
    const appClient = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: appAgent.apiKey,
      agentId: appAgent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) => unavailable(`app client acquire: ${String(e)}`)),
    );

    const appId = `close-life-${Date.now().toString(DATE_ID_RADIX)}`;
    const registerOutcome = yield* sendUntypedRpc(
      appClient,
      AppsRegister.name,
      {
        manifest: {
          appId,
          name: `Close lifecycle app ${appId}`,
          permissions: { required: [], optional: [] },
          conversations: [
            { key: "main", name: "Main", participantFilter: "all" },
          ],
        },
      },
    ).pipe(Effect.either);
    yield* requireRight(registerOutcome, (error) =>
      unavailable(`apps/register failed: ${error._tag}`),
    );

    const initiatorAgent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "clinit",
      uniqueSuffix: false,
    }).pipe(
      Effect.mapError((e) => unavailable(`initiator register: ${e.body}`)),
    );
    const initiatorClient = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: initiatorAgent.apiKey,
      agentId: initiatorAgent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        unavailable(`initiator client acquire: ${String(e)}`),
      ),
    );

    const inviteeAgent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "clinv",
      uniqueSuffix: false,
    }).pipe(Effect.mapError((e) => unavailable(`invitee register: ${e.body}`)));
    const inviteeClient = yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: inviteeAgent.apiKey,
      agentId: inviteeAgent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        unavailable(`invitee client acquire: ${String(e)}`),
      ),
    );

    const createOutcome = yield* initiatorClient
      .sendRpc(AppsCreate.name, {
        appId,
        invitedAgentIds: [inviteeAgent.agentId],
      })
      .pipe(Effect.either);
    const createResult = yield* requireRight(createOutcome, (error) =>
      unavailable(
        `apps/create failed (likely agents lack owner_user_id): ${error._tag}`,
      ),
    );

    const session = (createResult as AppCreateResultData).session;
    const sessionId = session?.id;
    const mainConversationId = session?.conversations?.["main"];
    if (
      typeof sessionId !== "string" ||
      typeof mainConversationId !== "string"
    ) {
      return yield* Effect.fail(
        violation(
          propertyName,
          `apps/create response missing session id or main conversation: ${JSON.stringify(createResult)}`,
        ),
      );
    }

    return {
      initiator: { agent: initiatorAgent, client: initiatorClient },
      invitee: { agent: inviteeAgent, client: inviteeClient },
      sessionId,
      conversationId: mainConversationId,
    } satisfies AppSessionCloseFixture;
  });
}

/** Task-boundary isolation — conversation A's events don't leak into B. */
export function registerTaskBoundaryIsolation(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    TASK_BOUNDARY_ISOLATION_PROPERTY,
    "participants in conversation B observe zero leaks from conversation A",
    Effect.scoped(
      Effect.gen(function* () {
        const fxA = yield* acquireConversation(ctx, 1, "iso-a").pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: TASK_BOUNDARY_ISOLATION_PROPERTY,
                reason: `fixture A: ${e}`,
              }),
          ),
        );
        const fxB = yield* acquireConversation(ctx, 1, "iso-b").pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: TASK_BOUNDARY_ISOLATION_PROPERTY,
                reason: `fixture B: ${e}`,
              }),
          ),
        );
        yield* fxA.owner.client
          .sendRpc(MessagesSend.name, {
            conversationId: fxA.conversationId,
            parts: [{ type: "text", text: "iso-leak-canary" }],
          })
          .pipe(Effect.either);
        yield* Effect.sleep("250 millis");
        const outsider = fxB.participants[0];
        if (outsider === undefined) return;
        const snap = yield* outsider.client.snapshot;
        const leaked = snap.some(
          (s) => s.kind === "inbound" && s.raw.includes(fxA.conversationId),
        );
        if (leaked) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: TASK_BOUNDARY_ISOLATION_PROPERTY,
              reason: `conversation ${fxA.conversationId} leaked into outsider ${outsider.agent.agentId}`,
            }),
          );
        }
      }),
    ),
  );
}

/**
 * Conversation lifecycle — the supported reversible path is observable
 * and enforced:
 *   - conversations/create broadcasts conversations/created
 *   - messages/send broadcasts messages/received
 *   - conversations/update broadcasts conversations/updated
 *   - archive/unarchive form the only reversible terminal state
 *   - archived conversations reject messages/send
 *   - messages/send succeeds again after unarchive
 */
export function registerConversationLifecycle(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    CONVERSATION_LIFECYCLE_PROPERTY,
    "create/send/update/archive/unarchive lifecycle is observable and enforced",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquirePropertyConversation(
          ctx,
          CONVERSATION_LIFECYCLE_PROPERTY,
          "life",
        );
        const participant = yield* firstParticipant(
          fixture,
          CONVERSATION_LIFECYCLE_PROPERTY,
        );

        yield* waitForConversationCreatedEvent(
          participant,
          fixture.conversationId,
          CONVERSATION_LIFECYCLE_PROPERTY,
        );

        const firstSend = yield* sendText(
          fixture.owner,
          fixture.conversationId,
          "lifecycle-before-update",
        ).pipe(Effect.either);
        yield* requireRight(firstSend, (error) =>
          violation(
            CONVERSATION_LIFECYCLE_PROPERTY,
            `messages/send failed before archive: ${error._tag}`,
          ),
        );
        yield* waitForMessageReceivedEvent(
          participant,
          fixture.conversationId,
          CONVERSATION_LIFECYCLE_PROPERTY,
        );

        const updatedName = `Lifecycle ${ctx.seed}`;
        const update = yield* updateConversationName(
          fixture.owner,
          fixture.conversationId,
          updatedName,
        ).pipe(Effect.either);
        yield* requireRight(update, (error) =>
          violation(
            CONVERSATION_LIFECYCLE_PROPERTY,
            `conversations/update failed: ${error._tag}`,
          ),
        );
        yield* waitForConversationUpdatedEvent(
          participant,
          fixture.conversationId,
          updatedName,
          CONVERSATION_LIFECYCLE_PROPERTY,
        );

        const archive = yield* archiveConversation(
          fixture.owner,
          fixture.conversationId,
        ).pipe(Effect.either);
        yield* requireRight(archive, (error) =>
          violation(
            CONVERSATION_LIFECYCLE_PROPERTY,
            `archive failed: ${error._tag}`,
          ),
        );
        yield* waitForArchivedEvent(
          participant,
          fixture.conversationId,
          fixture.owner.agent.agentId,
          CONVERSATION_LIFECYCLE_PROPERTY,
        );
        yield* assertConversationRejectsMessages(
          participant,
          fixture.conversationId,
          CONVERSATION_LIFECYCLE_PROPERTY,
        );

        const unarchive = yield* unarchiveConversation(
          fixture.owner,
          fixture.conversationId,
        ).pipe(Effect.either);
        yield* requireRight(unarchive, (error) =>
          violation(
            CONVERSATION_LIFECYCLE_PROPERTY,
            `unarchive failed: ${error._tag}`,
          ),
        );
        yield* waitForUnarchivedEvent(
          participant,
          fixture.conversationId,
          fixture.owner.agent.agentId,
          CONVERSATION_LIFECYCLE_PROPERTY,
        );

        const resumedSend = yield* sendText(
          participant,
          fixture.conversationId,
          "lifecycle-after-unarchive",
        ).pipe(Effect.either);
        yield* requireRight(resumedSend, (error) =>
          violation(
            CONVERSATION_LIFECYCLE_PROPERTY,
            `messages/send failed after unarchive: ${error._tag}`,
          ),
        );
      }),
    ),
  );
}

/**
 * App-session close lifecycle — when app sessions are reachable, close is
 * observable as both conversation archival and app/sessionClosed, and the
 * archived app conversation rejects later traffic.
 */
export function registerAppSessionCloseLifecycle(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    APP_SESSION_CLOSE_LIFECYCLE_PROPERTY,
    "apps/closeSession archives app conversations and broadcasts session close",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireAppSessionCloseFixture(ctx);

        const close = yield* fixture.initiator.client
          .sendRpc(AppsCloseSession.name, { sessionId: fixture.sessionId })
          .pipe(Effect.either);
        const closeResult = yield* requireRight(close, (error) =>
          violation(
            APP_SESSION_CLOSE_LIFECYCLE_PROPERTY,
            `apps/closeSession failed: ${error._tag}`,
          ),
        );
        if ((closeResult as { closed?: unknown }).closed !== true) {
          return yield* Effect.fail(
            violation(
              APP_SESSION_CLOSE_LIFECYCLE_PROPERTY,
              `apps/closeSession returned unexpected result: ${JSON.stringify(closeResult)}`,
            ),
          );
        }

        yield* waitForArchivedEvent(
          fixture.invitee,
          fixture.conversationId,
          fixture.initiator.agent.agentId,
          APP_SESSION_CLOSE_LIFECYCLE_PROPERTY,
        );
        yield* waitForAppSessionClosedEvent(
          fixture.invitee,
          fixture.sessionId,
          fixture.initiator.agent.agentId,
          APP_SESSION_CLOSE_LIFECYCLE_PROPERTY,
        );
        yield* assertConversationRejectsMessages(
          fixture.initiator,
          fixture.conversationId,
          APP_SESSION_CLOSE_LIFECYCLE_PROPERTY,
        );
      }),
    ),
  );
}

/**
 * Archive lifecycle — archival is observable and enforced:
 *   - conversations/archive broadcasts conversations/archived
 *   - messages/send to the archived conversation returns the typed
 *     ConversationArchived error
 *   - conversations/unarchive broadcasts conversations/unarchived
 *   - messages/send succeeds again after unarchive
 */
export function registerArchiveLifecycle(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    ARCHIVE_LIFECYCLE_PROPERTY,
    "archive/unarchive emits lifecycle events and gates messages/send",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquirePropertyConversation(
          ctx,
          ARCHIVE_LIFECYCLE_PROPERTY,
          "arch",
        );
        const participant = yield* firstParticipant(
          fixture,
          ARCHIVE_LIFECYCLE_PROPERTY,
        );

        const archive = yield* archiveConversation(
          fixture.owner,
          fixture.conversationId,
        ).pipe(Effect.either);
        yield* requireRight(archive, (error) =>
          violation(
            ARCHIVE_LIFECYCLE_PROPERTY,
            `archive failed: ${error._tag}`,
          ),
        );
        yield* waitForArchivedEvent(
          participant,
          fixture.conversationId,
          fixture.owner.agent.agentId,
          ARCHIVE_LIFECYCLE_PROPERTY,
        );
        yield* assertConversationRejectsMessages(
          participant,
          fixture.conversationId,
          ARCHIVE_LIFECYCLE_PROPERTY,
        );

        const unarchive = yield* unarchiveConversation(
          fixture.owner,
          fixture.conversationId,
        ).pipe(Effect.either);
        yield* requireRight(unarchive, (error) =>
          violation(
            ARCHIVE_LIFECYCLE_PROPERTY,
            `unarchive failed: ${error._tag}`,
          ),
        );
        yield* waitForUnarchivedEvent(
          participant,
          fixture.conversationId,
          fixture.owner.agent.agentId,
          ARCHIVE_LIFECYCLE_PROPERTY,
        );

        const resumedSend = yield* sendText(
          participant,
          fixture.conversationId,
          "must-succeed-after-unarchive",
        ).pipe(Effect.either);
        yield* requireRight(resumedSend, (error) =>
          violation(
            ARCHIVE_LIFECYCLE_PROPERTY,
            `messages/send failed after unarchive: ${error._tag}`,
          ),
        );
      }),
    ),
  );
}
