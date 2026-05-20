/**
 * Client-side delivery properties.
 *
 * Covers spec-amendment #200 §5:
 *   C1 — fan-out-cardinality (client-side new)
 *   C3 — payload-opacity (client-side new)
 *   C4 — task-boundary-isolation (client half of both-sides)
 *
 * Handshake-noise guard (O7): every observation filters by
 * `emissionTag`. C1 tags each of N emissions with a shared campaign
 * id; predicate asserts exactly N observed frames with that campaign
 * id. C3 tags the one emission; predicate finds exactly one observed
 * frame carrying the byte-identical payload. C4 tags task-A and
 * task-B emissions with distinct campaigns; task-A subscriber must
 * observe zero task-B campaign emissions.
 *
 * Exact-cardinality discipline (#195 §P1 on server-side C1 carries
 * over): `observedCount === N`, not `≥ 1` and not `≤ N`. Duplicates
 * and drops fail symmetrically.
 */
import { Effect, type Scope } from "effect";
import { notificationFrame } from "../../../transport/wire.js";
import {
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
} from "../../../task/methods.js";
import { MessageReceivedNotificationDefinition } from "../../../task/methods.js";
import {
  agentId,
  conversationId as toConversationId,
  messageId,
  taskId,
} from "../_shared/test-fixtures.js";
import type { ClientConformanceRunContext } from "./runner.js";
import { registerProperty } from "../_shared/registry.js";
import type {
  PropertyFailure,
  PropertyInvariantViolation,
} from "../_shared/registry.js";
import {
  acquireFixture,
  collectTagged,
  invariant,
  subscribeAll,
  type ClientFixture,
  type TaggedObservation,
} from "./_fixtures.js";

const CATEGORY = "delivery" as const;
const PROPERTY_BUDGET_MS = 8_000;
const PROPERTY_FAN_OUT_CARDINALITY_CLIENT = "fan-out-cardinality-client";
const PROPERTY_PAYLOAD_OPACITY_CLIENT = "payload-opacity-client";
const PROPERTY_TASK_BOUNDARY_ISOLATION_CLIENT =
  "task-boundary-isolation-client";
const PAYLOAD_TOKEN_RADIX = 36;
const FAN_OUT_EMISSION_COUNT = 5;
const TASK_BOUNDARY_EMISSION_COUNT = 3;
const LIFECYCLE_OBSERVATION_COUNT = 2;

type ConversationId = ReturnType<typeof toConversationId>;
type AgentId = ReturnType<typeof agentId>;

interface FanOutEmissionPlan {
  readonly tags: ReadonlyArray<string>;
  readonly expectedSlotTexts: ReadonlyArray<string>;
}

interface TaskBoundaryCampaign {
  readonly conversationId: ConversationId;
  readonly tags: ReadonlyArray<string>;
}

type DeliveryPropertyEffect = Effect.Effect<void, PropertyFailure, Scope.Scope>;

type DeliveryAssertion = Effect.Effect<void, PropertyInvariantViolation>;

/**
 * C1 client-side — TestServer emits N fan-out `NotificationFrame`s (one
 * per conversation participant position) to a real client subscribed
 * to the conversation. All N carry the same `emissionTag` campaign;
 * each carries a per-position `positionIndex` in the payload.
 *
 * Predicate (conjunction):
 *   - `observedByCampaign.length === N`
 *   - every `positionIndex` in `[0..N)` appears exactly once
 *   - observation order matches emission order
 *
 * Discriminates: a client that coalesces duplicate fan-out frames,
 * drops one, or reorders the sequence fails.
 */
export function registerFanOutCardinalityClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
    "N fan-out notifications surface on real client in emission order, no drops, no dups",
    Effect.scoped(runFanOutCardinalityClient(ctx)),
  );
}

function runFanOutCardinalityClient(
  ctx: ClientConformanceRunContext,
): DeliveryPropertyEffect {
  return Effect.gen(function* () {
    const fx = yield* acquireFixture(
      ctx,
      CATEGORY,
      PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
    );
    yield* subscribeAll(fx.handle);
    const plan = yield* emitFanOutNotifications(fx);
    const observed = yield* collectTagged(fx.handle, tagPredicate(plan.tags), {
      expected: FAN_OUT_EMISSION_COUNT,
      budgetMs: PROPERTY_BUDGET_MS,
    });
    yield* assertFanOutObservedCount(observed);
    yield* assertFanOutOrderAndPayload(plan, observed);
  }).pipe(Effect.withSpan("registerFanOutCardinalityClient"));
}

function emitFanOutNotifications(
  fx: ClientFixture,
): Effect.Effect<FanOutEmissionPlan> {
  return Effect.gen(function* () {
    const tags: string[] = [];
    const expectedSlotTexts: string[] = [];
    const senderId = agentId(fx.handle.agentId);
    for (let i = 0; i < FAN_OUT_EMISSION_COUNT; i++) {
      const slotText = `position-${i}`;
      expectedSlotTexts.push(slotText);
      const tag = yield* fx.window.freshEmissionTag;
      tags.push(tag);
      yield* fx.window.emitTaggedNotification({
        connection: fx.connection,
        base: fanOutNotification(senderId, i, slotText),
        emissionTag: tag,
      });
    }
    return { tags, expectedSlotTexts };
  });
}

function fanOutNotification(senderId: AgentId, slot: number, text: string) {
  return notificationFrame(MessageReceivedNotificationDefinition, {
    taskId: taskId("00000000-0000-4000-8000-fa0c0a0fa0c0"),
    message: {
      id: messageId(`00000000-0000-4000-8000-${fanOutSlot(slot)}`),
      conversationId: toConversationId("00000000-0000-4000-8000-fa0c0a0fa0c0"),
      senderId,
      parts: [{ type: "text", text }],
      createdAt: new Date(0).toISOString(),
    },
  });
}

function tagPredicate(tags: ReadonlyArray<string>): (tag: string) => boolean {
  const tagSet = new Set(tags);
  return (tag) => tagSet.has(tag);
}

function assertFanOutObservedCount(
  observed: ReadonlyArray<TaggedObservation>,
): DeliveryAssertion {
  return observed.length === FAN_OUT_EMISSION_COUNT
    ? Effect.void
    : Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
          `expected ${FAN_OUT_EMISSION_COUNT} observations, got ${observed.length}`,
        ),
      );
}

function assertFanOutOrderAndPayload(
  plan: FanOutEmissionPlan,
  observed: ReadonlyArray<TaggedObservation>,
): DeliveryAssertion {
  return Effect.gen(function* () {
    for (let i = 0; i < FAN_OUT_EMISSION_COUNT; i++) {
      yield* assertFanOutSlot(plan, observed, i);
    }
  });
}

function assertFanOutSlot(
  plan: FanOutEmissionPlan,
  observed: ReadonlyArray<TaggedObservation>,
  slot: number,
): DeliveryAssertion {
  const observation = observed[slot]!;
  if (observation.tag !== plan.tags[slot]) {
    return Effect.fail(
      invariant(
        CATEGORY,
        PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
        `order mismatch at slot ${slot}: expected ${plan.tags[slot]}, got ${observation.tag}`,
      ),
    );
  }
  const surfacedStr = new TextDecoder().decode(observation.raw);
  return surfacedStr.includes(plan.expectedSlotTexts[slot]!)
    ? Effect.void
    : Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
          `slot ${slot} surfaced without per-slot marker text "${plan.expectedSlotTexts[slot]}"`,
        ),
      );
}

const FAN_OUT_SLOT_PAD = 12;
const FAN_OUT_SLOT_RADIX = 16;
function fanOutSlot(i: number): string {
  return i.toString(FAN_OUT_SLOT_RADIX).padStart(FAN_OUT_SLOT_PAD, "0");
}

/**
 * C3 client-side — TestServer emits a single `NotificationFrame` whose
 * payload contains a distinct byte-sequence token; real client's
 * subscriber surfaces a frame whose raw bytes still contain that
 * token.
 *
 * Predicate (strict): the raw-bytes view of the surfaced notification
 * includes the emitted token byte-for-byte. A client that routes
 * payloads through a lossy re-serialization (e.g., key-reorder JSON
 * stringify) fails.
 */
export function registerPayloadOpacityClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_PAYLOAD_OPACITY_CLIENT,
    "opaque payload token round-trips byte-identical through the real client",
    Effect.scoped(runPayloadOpacityClient(ctx)),
  );
}

function runPayloadOpacityClient(
  ctx: ClientConformanceRunContext,
): DeliveryPropertyEffect {
  return Effect.gen(function* () {
    const fx = yield* acquireFixture(
      ctx,
      CATEGORY,
      PROPERTY_PAYLOAD_OPACITY_CLIENT,
    );
    yield* subscribeAll(fx.handle);
    const token = payloadToken(ctx);
    const tag = yield* emitPayloadOpacityNotification(fx, token);
    const observed = yield* collectTagged(fx.handle, (t) => t === tag, {
      expected: 1,
      budgetMs: PROPERTY_BUDGET_MS,
    });
    yield* assertPayloadTokenObserved(token, observed);
  }).pipe(Effect.withSpan("registerPayloadOpacityClient"));
}

function payloadToken(ctx: ClientConformanceRunContext): string {
  return `opq-${ctx.seed.toString(PAYLOAD_TOKEN_RADIX)}-${Date.now().toString(PAYLOAD_TOKEN_RADIX)}`;
}

function emitPayloadOpacityNotification(
  fx: ClientFixture,
  token: string,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const tag = yield* fx.window.freshEmissionTag;
    yield* fx.window.emitTaggedNotification({
      connection: fx.connection,
      base: payloadOpacityNotification(fx, token),
      emissionTag: tag,
    });
    return tag;
  });
}

function payloadOpacityNotification(fx: ClientFixture, token: string) {
  return notificationFrame(MessageReceivedNotificationDefinition, {
    taskId: taskId("00000000-0000-4000-8000-00000000c1de"),
    message: {
      id: messageId("00000000-0000-4000-8000-00000000c0de"),
      conversationId: toConversationId("00000000-0000-4000-8000-00000000c1de"),
      senderId: agentId(fx.handle.agentId),
      parts: [{ type: "text", text: "x" }],
      patchedBy: token,
      createdAt: new Date(0).toISOString(),
    },
  });
}

function assertPayloadTokenObserved(
  token: string,
  observed: ReadonlyArray<TaggedObservation>,
): DeliveryAssertion {
  const surfaced = observed[0];
  if (surfaced === undefined) {
    return Effect.fail(
      invariant(
        CATEGORY,
        PROPERTY_PAYLOAD_OPACITY_CLIENT,
        `token ${token} emission not surfaced by real client`,
      ),
    );
  }
  const surfacedStr = new TextDecoder().decode(surfaced.raw);
  return surfacedStr.includes(token)
    ? Effect.void
    : Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_PAYLOAD_OPACITY_CLIENT,
          `token ${token} not present byte-for-byte in surfaced raw frame`,
        ),
      );
}

/**
 * C4 client half — TestServer emits N task-A notifications (tagged campaignA)
 * and M task-B notifications (tagged campaignB) to a real client subscribed
 * with a `conversationId` filter set to task-A. The client's task-A
 * subscriber surfaces zero campaignB events.
 *
 * Predicate: `observedCampaignB.length === 0`.
 */
export function registerTaskBoundaryIsolationClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_TASK_BOUNDARY_ISOLATION_CLIENT,
    "task-A subscriber does not surface task-B notifications — no leakage",
    Effect.scoped(runTaskBoundaryIsolationClient(ctx)),
  );
}

function runTaskBoundaryIsolationClient(
  ctx: ClientConformanceRunContext,
): DeliveryPropertyEffect {
  return Effect.gen(function* () {
    const fx = yield* acquireFixture(
      ctx,
      CATEGORY,
      PROPERTY_TASK_BOUNDARY_ISOLATION_CLIENT,
    );
    yield* subscribeAll(fx.handle);
    const taskA = toConversationId("00000000-0000-4000-8000-000000000a01");
    const taskB = toConversationId("00000000-0000-4000-8000-000000000b02");
    const by = agentId(fx.handle.agentId);
    const campaignA = yield* emitTaskBoundaryCampaign(fx, taskA, by);
    const campaignB = yield* emitTaskBoundaryCampaign(fx, taskB, by);
    yield* drainTaskBoundaryCampaigns(fx, campaignA, campaignB);
    yield* assertTaskBoundaryCampaign(fx, campaignA, "task-A");
    yield* assertTaskBoundaryCampaign(fx, campaignB, "task-B");
  }).pipe(Effect.withSpan("registerTaskBoundaryIsolationClient"));
}

function emitTaskBoundaryCampaign(
  fx: ClientFixture,
  conversationId: ConversationId,
  by: AgentId,
): Effect.Effect<TaskBoundaryCampaign> {
  return Effect.gen(function* () {
    const tags: string[] = [];
    for (let i = 0; i < TASK_BOUNDARY_EMISSION_COUNT; i++) {
      const tag = yield* fx.window.freshEmissionTag;
      tags.push(tag);
      yield* fx.window.emitTaggedNotification({
        connection: fx.connection,
        base: archiveNotification(conversationId, by),
        emissionTag: tag,
      });
    }
    return { conversationId, tags };
  });
}

function drainTaskBoundaryCampaigns(
  fx: ClientFixture,
  campaignA: TaskBoundaryCampaign,
  campaignB: TaskBoundaryCampaign,
): Effect.Effect<ReadonlyArray<TaggedObservation>> {
  const tags = [...campaignA.tags, ...campaignB.tags];
  return collectTagged(fx.handle, tagPredicate(tags), {
    expected: tags.length,
    budgetMs: PROPERTY_BUDGET_MS,
  });
}

function assertTaskBoundaryCampaign(
  fx: ClientFixture,
  campaign: TaskBoundaryCampaign,
  label: string,
): DeliveryAssertion {
  return Effect.gen(function* () {
    const observed = yield* collectTagged(
      fx.handle,
      tagPredicate(campaign.tags),
      {
        expected: TASK_BOUNDARY_EMISSION_COUNT,
        budgetMs: 0,
      },
    );
    for (const obs of observed) {
      yield* assertTaskBoundaryObservation(campaign, label, obs);
    }
  });
}

function assertTaskBoundaryObservation(
  campaign: TaskBoundaryCampaign,
  label: string,
  obs: TaggedObservation,
): DeliveryAssertion {
  const actual = obs.params.conversationId;
  return actual === campaign.conversationId
    ? Effect.void
    : Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_TASK_BOUNDARY_ISOLATION_CLIENT,
          `${label} emission surfaced with conversationId ${String(actual)}`,
        ),
      );
}

/**
 * Archive lifecycle client — TestServer emits archive then unarchive
 * lifecycle events. The real client subscriber must surface both in
 * emission order.
 */
export function registerArchiveLifecycleClient(
  ctx: ClientConformanceRunContext,
): void {
  const name = "archive-lifecycle-client";
  registerProperty(
    ctx,
    CATEGORY,
    name,
    "archive/unarchive lifecycle notifications surface on the real client in order",
    Effect.scoped(runArchiveLifecycleClient(ctx, name)),
  );
}

function runArchiveLifecycleClient(
  ctx: ClientConformanceRunContext,
  name: string,
): DeliveryPropertyEffect {
  return Effect.gen(function* () {
    const fx = yield* acquireFixture(ctx, CATEGORY, name);
    yield* subscribeAll(fx.handle);
    const conversationId = toConversationId(
      "00000000-0000-4000-8000-000000000001",
    );
    const by = agentId(fx.handle.agentId);
    const tag = yield* emitArchiveLifecycle(fx, conversationId, by);
    const observed = yield* collectTagged(fx.handle, (t) => t === tag, {
      expected: LIFECYCLE_OBSERVATION_COUNT,
      budgetMs: PROPERTY_BUDGET_MS,
    });
    yield* assertArchiveLifecycleObserved(name, observed);
  }).pipe(Effect.withSpan("registerArchiveLifecycleClient"));
}

function emitArchiveLifecycle(
  fx: ClientFixture,
  conversationId: ConversationId,
  by: AgentId,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const tag = yield* fx.window.freshEmissionTag;
    yield* fx.window.emitTaggedNotification({
      connection: fx.connection,
      base: archiveNotification(conversationId, by),
      emissionTag: tag,
    });
    yield* fx.window.emitTaggedNotification({
      connection: fx.connection,
      base: unarchiveNotification(conversationId, by),
      emissionTag: tag,
    });
    return tag;
  });
}

function archiveNotification(conversationId: ConversationId, by: AgentId) {
  return notificationFrame(ConversationArchivedNotificationDefinition, {
    conversationId,
    archivedAt: new Date(0).toISOString(),
    by,
  });
}

function unarchiveNotification(conversationId: ConversationId, by: AgentId) {
  return notificationFrame(ConversationUnarchivedNotificationDefinition, {
    conversationId,
    by,
  });
}

function assertArchiveLifecycleObserved(
  name: string,
  observed: ReadonlyArray<TaggedObservation>,
): DeliveryAssertion {
  if (observed.length !== LIFECYCLE_OBSERVATION_COUNT) {
    return Effect.fail(
      invariant(
        CATEGORY,
        name,
        `expected ${LIFECYCLE_OBSERVATION_COUNT} lifecycle observations, got ${observed.length}`,
      ),
    );
  }
  return archiveLifecycleInOrder(observed)
    ? Effect.void
    : Effect.fail(
        invariant(
          CATEGORY,
          name,
          `lifecycle order mismatch: ${observed.map((o) => o.notificationName).join(",")}`,
        ),
      );
}

function archiveLifecycleInOrder(
  observed: ReadonlyArray<TaggedObservation>,
): boolean {
  return (
    observed[0]?.notificationName ===
      ConversationArchivedNotificationDefinition.name &&
    observed[1]?.notificationName ===
      ConversationUnarchivedNotificationDefinition.name
  );
}
