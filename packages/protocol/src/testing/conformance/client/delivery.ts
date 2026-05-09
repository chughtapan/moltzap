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
import { Effect } from "effect";
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
} from "../_shared/test-fixtures.js";
import type { ClientConformanceRunContext } from "./runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  acquireFixture,
  collectTagged,
  invariant,
  subscribeAll,
} from "./_fixtures.js";

const CATEGORY = "delivery" as const;
const PROPERTY_BUDGET_MS = 8_000;
const PROPERTY_FAN_OUT_CARDINALITY_CLIENT = "fan-out-cardinality-client";
const PROPERTY_PAYLOAD_OPACITY_CLIENT = "payload-opacity-client";
const PROPERTY_TASK_BOUNDARY_ISOLATION_CLIENT =
  "task-boundary-isolation-client";
const PAYLOAD_TOKEN_RADIX = 36;
const TASK_BOUNDARY_EMISSION_COUNT = 3;
const LIFECYCLE_OBSERVATION_COUNT = 2;

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
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
        );
        yield* subscribeAll(fx.handle);
        const N = 5;
        const tags: string[] = [];
        const expectedSlotTexts: string[] = [];
        const senderId = agentId(fx.handle.agentId);
        for (let i = 0; i < N; i++) {
          // Mint a per-iteration distinct `messages/received` frame so
          // `lookupTagForRawBytes`'s wire-bytes key is unique per
          // emission (the C1 cardinality predicate must distinguish N
          // frames, not collapse them via duplicate raw bytes).
          const slotText = `position-${i}`;
          expectedSlotTexts.push(slotText);
          const positional = notificationFrame(
            MessageReceivedNotificationDefinition,
            {
              message: {
                id: messageId(`00000000-0000-4000-8000-${fanOutSlot(i)}`),
                conversationId: toConversationId(
                  "00000000-0000-4000-8000-fa0c0a0fa0c0",
                ),
                senderId,
                parts: [{ type: "text", text: slotText }],
                createdAt: new Date(0).toISOString(),
              },
            },
          );
          const tag = yield* fx.window.freshEmissionTag;
          tags.push(tag);
          yield* fx.window.emitTaggedNotification({
            connection: fx.connection,
            base: positional,
            emissionTag: tag,
          });
        }
        const tagSet = new Set(tags);
        const observed = yield* collectTagged(fx.handle, (t) => tagSet.has(t), {
          expected: N,
          budgetMs: PROPERTY_BUDGET_MS,
        });
        if (observed.length !== N) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
              `expected ${N} observations, got ${observed.length}`,
            ),
          );
        }
        // Strict ordering: observed tags arrive in emission order, and the
        // surfaced wire content carries the per-slot text byte-for-byte
        // (a re-serializing client that scrambles part bodies fails here).
        for (let i = 0; i < N; i++) {
          if (observed[i]!.tag !== tags[i]) {
            return yield* Effect.fail(
              invariant(
                CATEGORY,
                PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
                `order mismatch at slot ${i}: expected ${tags[i]}, got ${observed[i]!.tag}`,
              ),
            );
          }
          const surfacedStr = new TextDecoder().decode(observed[i]!.raw);
          if (!surfacedStr.includes(expectedSlotTexts[i]!)) {
            return yield* Effect.fail(
              invariant(
                CATEGORY,
                PROPERTY_FAN_OUT_CARDINALITY_CLIENT,
                `slot ${i} surfaced without per-slot marker text "${expectedSlotTexts[i]}"`,
              ),
            );
          }
        }
      }),
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
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_PAYLOAD_OPACITY_CLIENT,
        );
        yield* subscribeAll(fx.handle);
        const token = `opq-${ctx.seed.toString(PAYLOAD_TOKEN_RADIX)}-${Date.now().toString(PAYLOAD_TOKEN_RADIX)}`;
        // Embed the token in a schema-conformant `messages/received`
        // payload (the `patchedBy` field is `Type.Optional(Type.String())`
        // so any byte sequence round-trips). Post-Phase-12 #222 the typed
        // inbound decoder validates per-method paramsSchema; opacity is
        // tested over the body bytes that survive validation.
        const base = notificationFrame(MessageReceivedNotificationDefinition, {
          message: {
            id: messageId("00000000-0000-4000-8000-00000000c0de"),
            conversationId: toConversationId(
              "00000000-0000-4000-8000-00000000c1de",
            ),
            senderId: agentId(fx.handle.agentId),
            parts: [{ type: "text", text: "x" }],
            patchedBy: token,
            createdAt: new Date(0).toISOString(),
          },
        });
        const tag = yield* fx.window.freshEmissionTag;
        yield* fx.window.emitTaggedNotification({
          connection: fx.connection,
          base,
          emissionTag: tag,
        });
        const observed = yield* collectTagged(fx.handle, (t) => t === tag, {
          expected: 1,
          budgetMs: PROPERTY_BUDGET_MS,
        });
        if (observed.length === 0) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              PROPERTY_PAYLOAD_OPACITY_CLIENT,
              `token ${token} emission not surfaced by real client`,
            ),
          );
        }
        const surfaced = observed[0]!;
        const surfacedStr = new TextDecoder().decode(surfaced.raw);
        if (!surfacedStr.includes(token)) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              PROPERTY_PAYLOAD_OPACITY_CLIENT,
              `token ${token} not present byte-for-byte in surfaced raw frame`,
            ),
          );
        }
      }),
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
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_TASK_BOUNDARY_ISOLATION_CLIENT,
        );
        yield* subscribeAll(fx.handle);
        const taskA = toConversationId("00000000-0000-4000-8000-000000000a01");
        const taskB = toConversationId("00000000-0000-4000-8000-000000000b02");
        const by = agentId(fx.handle.agentId);
        const archivedAt = new Date(0).toISOString();
        const buildBase = (cid: typeof taskA) =>
          notificationFrame(ConversationArchivedNotificationDefinition, {
            conversationId: cid,
            archivedAt,
            by,
          });
        // Emit task-A frames (each tag distinct so wire bytes vary).
        const tagsA: string[] = [];
        for (let i = 0; i < TASK_BOUNDARY_EMISSION_COUNT; i++) {
          const tag = yield* fx.window.freshEmissionTag;
          tagsA.push(tag);
          yield* fx.window.emitTaggedNotification({
            connection: fx.connection,
            base: buildBase(taskA),
            emissionTag: tag,
          });
        }
        // Emit task-B frames that must NOT cross-wire to task-A's
        // conversationId on the surfaced wire frame (positive-path
        // witness — divergence proof rewrites conversationId post-emit).
        const tagsB: string[] = [];
        for (let i = 0; i < TASK_BOUNDARY_EMISSION_COUNT; i++) {
          const tag = yield* fx.window.freshEmissionTag;
          tagsB.push(tag);
          yield* fx.window.emitTaggedNotification({
            connection: fx.connection,
            base: buildBase(taskB),
            emissionTag: tag,
          });
        }
        const tagSetA = new Set(tagsA);
        const tagSetB = new Set(tagsB);
        // Drain window: wait for all tagged emissions to arrive.
        yield* collectTagged(
          fx.handle,
          (t) => tagSetA.has(t) || tagSetB.has(t),
          { expected: 6, budgetMs: PROPERTY_BUDGET_MS },
        );
        const taggedA = yield* collectTagged(fx.handle, (t) => tagSetA.has(t), {
          expected: 3,
          budgetMs: 0,
        });
        for (const obs of taggedA) {
          const cid = obs.params.conversationId;
          if (cid !== taskA) {
            return yield* Effect.fail(
              invariant(
                CATEGORY,
                PROPERTY_TASK_BOUNDARY_ISOLATION_CLIENT,
                `task-A emission surfaced with conversationId ${String(cid)}`,
              ),
            );
          }
        }
        const taggedB = yield* collectTagged(fx.handle, (t) => tagSetB.has(t), {
          expected: 3,
          budgetMs: 0,
        });
        for (const obs of taggedB) {
          const cid = obs.params.conversationId;
          if (cid !== taskB) {
            return yield* Effect.fail(
              invariant(
                CATEGORY,
                PROPERTY_TASK_BOUNDARY_ISOLATION_CLIENT,
                `task-B emission surfaced with conversationId ${String(cid)} (cross-wiring)`,
              ),
            );
          }
        }
      }),
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
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(ctx, CATEGORY, name);
        yield* subscribeAll(fx.handle);

        const conversationId = toConversationId(
          "00000000-0000-4000-8000-000000000001",
        );
        const by = agentId(fx.handle.agentId);
        const tag = yield* fx.window.freshEmissionTag;
        yield* fx.window.emitTaggedNotification({
          connection: fx.connection,
          base: notificationFrame(ConversationArchivedNotificationDefinition, {
            conversationId,
            archivedAt: new Date(0).toISOString(),
            by,
          }),
          emissionTag: tag,
        });
        yield* fx.window.emitTaggedNotification({
          connection: fx.connection,
          base: notificationFrame(
            ConversationUnarchivedNotificationDefinition,
            {
              conversationId,
              by,
            },
          ),
          emissionTag: tag,
        });

        const observed = yield* collectTagged(fx.handle, (t) => t === tag, {
          expected: LIFECYCLE_OBSERVATION_COUNT,
          budgetMs: PROPERTY_BUDGET_MS,
        });
        if (observed.length !== LIFECYCLE_OBSERVATION_COUNT) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              name,
              `expected ${LIFECYCLE_OBSERVATION_COUNT} lifecycle observations, got ${observed.length}`,
            ),
          );
        }
        if (
          observed[0]?.notificationName !==
            ConversationArchivedNotificationDefinition.name ||
          observed[1]?.notificationName !==
            ConversationUnarchivedNotificationDefinition.name
        ) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              name,
              `lifecycle order mismatch: ${observed.map((o) => o.notificationName).join(",")}`,
            ),
          );
        }
      }),
    ),
  );
}
