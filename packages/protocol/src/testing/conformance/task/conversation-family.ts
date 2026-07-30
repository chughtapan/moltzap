/**
 * Conformance properties for the `task` + `conversation` family
 * (8 methods × 9 properties, N/A cells excluded). One `register*` per
 * method anchors a property whose body exercises the spec-body-mandated
 * case: schema decode, happy-path delivery, participant-admitted
 * invariant (where applicable).
 *
 * All methods live in one file because every property shares the same
 * acquire-clients fixture; one file per method would duplicate ~30 lines
 * of setup each without adding coverage. The "one property per method"
 * shape is preserved via separate `register*` functions per method.
 *
 * Out of scope (covered by the server conversation-family integration test
 * integration suite under
 * `packages/server/src/__tests__/integration/task/`):
 *   - Transaction rollback (requires real Postgres mid-tx failure).
 *   - Dual-emit notification arrival assertion (covered with
 *     `awaitOneNotification` in the integration suite).
 */
import { Effect, Either } from "effect";
import {
  DEFAULT_APP_ID,
  taskCreatedNotificationDefinition,
  taskFailedNotificationDefinition,
  taskRequest,
  taskLeave,
  taskCreate,
  type Task,
  type TaskId,
} from "#task";
import {
  conversationList,
  type Conversation,
  type ConversationListItem,
} from "#conversation";
import { registerTestApp } from "../_shared/test-app.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";
import {
  DELIVERY_CATEGORY,
  DELIVERY_DEFAULT_TIMEOUT_MS,
  acquireClient,
  awaitOneNotification,
  deliveryViolation,
  type ConversationActor,
} from "./_helpers.js";

const CATEGORY = DELIVERY_CATEGORY;
type FixtureError = ReturnType<typeof deliveryViolation>;
type Actor = ConversationActor;

const fixtureMap =
  (property: string) =>
  (cause: string): FixtureError =>
    deliveryViolation(property, `fixture: ${cause}`);

const acquireActor = (
  ctx: ConformanceRunContext,
  property: string,
  name: string,
) => acquireClient(ctx, name).pipe(Effect.mapError(fixtureMap(property)));

// Run an RPC effect, mapping any failure (wire error or transport fault)
// into a `deliveryViolation` tagged `${label}: <error tag>`.
const sendOrViolate = <A>(
  property: string,
  label: string,
  effect: Effect.Effect<A, { readonly _tag?: string }>,
): Effect.Effect<A, FixtureError> =>
  effect.pipe(
    Effect.either,
    Effect.flatMap((res) =>
      requireRight(res, (e) =>
        deliveryViolation(property, `${label}: ${e._tag ?? "untagged error"}`),
      ),
    ),
  );

// ─── TaskRequest ──────────────────────────────────────────────────────

const TASK_CREATE_PROPERTY = "task-create";

const createTaskCreate = (
  alice: Actor,
  bob: Actor,
): Effect.Effect<
  { task: Task; conversation: Conversation | null },
  FixtureError
> =>
  sendOrViolate(
    TASK_CREATE_PROPERTY,
    "app/task/create",
    alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agent.agentId],
    }),
  );

const assertTaskCreateShape = (payload: {
  task: { status: string };
  conversation: Conversation | null;
}): Effect.Effect<void, FixtureError> => {
  // The conformance app client auto-accepts app/task/create
  // callback, so agent/task/request returns an `active` task (waiting →
  // active transition completes before the RPC resolves).
  if (payload.task.status !== "active") {
    return Effect.fail(
      deliveryViolation(
        TASK_CREATE_PROPERTY,
        `task.status was ${payload.task.status}, expected active`,
      ),
    );
  }
  if (payload.conversation !== null) {
    return Effect.fail(
      deliveryViolation(
        TASK_CREATE_PROPERTY,
        "conversation should be null without initialConversation",
      ),
    );
  }
  return Effect.void;
};

/**
 * Registers task create.
 * @param ctx Context for the operation.
 */
export function registerTaskCreate(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    TASK_CREATE_PROPERTY,
    "agent/task/request under an accepting app transitions waiting -> active and fires agent/task/created to the initiator",
    Effect.scoped(
      Effect.gen(function* () {
        const alice = yield* acquireActor(
          ctx,
          TASK_CREATE_PROPERTY,
          "tcf-tc-a",
        );
        const bob = yield* acquireActor(ctx, TASK_CREATE_PROPERTY, "tcf-tc-b");
        const payload = yield* createTaskCreate(alice, bob);
        yield* assertTaskCreateShape(payload);
        const event = yield* awaitTaskCreated(alice, TASK_CREATE_PROPERTY);
        if (event.params.task.id !== payload.task.id) {
          return yield* Effect.fail(
            deliveryViolation(
              TASK_CREATE_PROPERTY,
              `agent/task/created carried task.id ${event.params.task.id}, expected ${payload.task.id}`,
            ),
          );
        }
        if (event.params.task.status !== "active") {
          return yield* Effect.fail(
            deliveryViolation(
              TASK_CREATE_PROPERTY,
              `agent/task/created carried status ${event.params.task.status}, expected active`,
            ),
          );
        }
      }),
    ).pipe(Effect.withSpan("registerTaskCreate")),
  );
}

function awaitTaskCreated(actor: Actor, property: string) {
  return awaitOneNotification(
    actor.notifications,
    taskCreatedNotificationDefinition,
    DELIVERY_DEFAULT_TIMEOUT_MS,
  ).pipe(
    Effect.mapError((reason) =>
      deliveryViolation(property, `agent/task/created missing: ${reason}`),
    ),
  );
}

// ─── TaskRequest — app reject path ───────────────────────────────────

const TASK_REQUEST_REJECT_PROPERTY = "task-request-app-reject";
const REJECT_REASON = "app_policy";

// Register a SEPARATE app principal (HTTP + `appKey` Connect) whose
// `app/task/create` callback always rejects. Returns the server-minted appId
// that the requesting agent targets in `agent/task/request`.
const registerRejectingApp = (ctx: ConformanceRunContext) =>
  registerTestApp({
    baseUrl: ctx.realServer.baseUrl,
    wsUrl: ctx.realServer.wsUrl,
    appId: crypto.randomUUID(),
    name: "rejecting-app",
    // `task_create` becomes a `kind: "hook"` policy so the server
    // round-trips the task-admission decision to the app; a static
    // `accept` policy would resolve in-process and never reach the
    // reject handler wired below.
    taskCreateTimeoutMs: 5_000,
  }).pipe(
    Effect.mapError((e) =>
      deliveryViolation(
        TASK_REQUEST_REJECT_PROPERTY,
        `app registration: ${e._tag}`,
      ),
    ),
    Effect.tap((app) =>
      app.client.onAppCallback(taskCreate, () =>
        Effect.succeed({
          verdict: { decision: "reject" as const, reason: REJECT_REASON },
        }),
      ),
    ),
    Effect.map((app) => app.appId),
  );

const assertTaskRequestFailed = (
  outcome: Either.Either<unknown, unknown>,
): Effect.Effect<void, FixtureError> =>
  Either.match(outcome, {
    // The reject surfaces as the typed `TaskRejected` wire error, NOT a
    // generic internal error — that is the contract a requester
    // discriminates on. Asserting the specific `_tag` keeps this
    // non-vacuous: any-Left would also pass for an unrelated transport
    // failure, which would not prove the app-reject path.
    onLeft: (error) => {
      const tag: unknown =
        typeof error === "object" && error !== null
          ? Reflect.get(error, "tag")
          : undefined;
      return tag === "TaskRejected"
        ? Effect.void
        : Effect.fail(
            deliveryViolation(
              TASK_REQUEST_REJECT_PROPERTY,
              `agent/task/request failed with ${String(tag)}, expected TaskRejected`,
            ),
          );
    },
    onRight: () =>
      Effect.fail(
        deliveryViolation(
          TASK_REQUEST_REJECT_PROPERTY,
          "agent/task/request resolved OK; expected an RPC error on app reject",
        ),
      ),
  });

const assertTaskFailedReason = (actor: Actor) =>
  awaitOneNotification(
    actor.notifications,
    taskFailedNotificationDefinition,
    DELIVERY_DEFAULT_TIMEOUT_MS,
  ).pipe(
    Effect.mapError((reason) =>
      deliveryViolation(
        TASK_REQUEST_REJECT_PROPERTY,
        `task/failed missing: ${reason}`,
      ),
    ),
    Effect.flatMap((failed) =>
      failed.params.reason === REJECT_REASON
        ? Effect.void
        : Effect.fail(
            deliveryViolation(
              TASK_REQUEST_REJECT_PROPERTY,
              `task/failed carried reason ${String(failed.params.reason)}, expected ${REJECT_REASON}`,
            ),
          ),
    ),
  );

/**
 * Registers task request reject.
 * @param ctx Context for the operation.
 */
export function registerTaskRequestReject(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    TASK_REQUEST_REJECT_PROPERTY,
    "agent/task/request fails and fires task/failed when the owning app rejects via the app/task/create callback",
    Effect.scoped(
      Effect.gen(function* () {
        const alice = yield* acquireActor(
          ctx,
          TASK_REQUEST_REJECT_PROPERTY,
          "tcf-rej-a",
        );
        const bob = yield* acquireActor(
          ctx,
          TASK_REQUEST_REJECT_PROPERTY,
          "tcf-rej-b",
        );
        const appId = yield* registerRejectingApp(ctx);
        const outcome = yield* alice.client
          .sendRpc(taskRequest, {
            appId,
            invitedAgentIds: [bob.agent.agentId],
          })
          .pipe(Effect.either);
        yield* assertTaskRequestFailed(outcome);
        // The initiator observes `task/failed` on the waiting → failed
        // transition, carrying the app's reject reason.
        yield* assertTaskFailedReason(alice);
      }),
    ).pipe(Effect.withSpan("registerTaskRequestReject")),
  );
}

// ─── TaskLeave ───────────────────────────────────────────────────────

const TASK_LEAVE_PROPERTY = "task-leave";

const sendTaskLeave = (
  alice: Actor,
  taskId: TaskId,
  context: string,
): Effect.Effect<void, FixtureError> =>
  sendOrViolate(
    TASK_LEAVE_PROPERTY,
    context,
    alice.client.sendRpc(taskLeave, { taskId }),
  ).pipe(Effect.asVoid);

const createSelfOnlyTask = (
  alice: Actor,
  property: string,
): Effect.Effect<Task, FixtureError> =>
  sendOrViolate(
    property,
    "app/task/create",
    alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    }),
  ).pipe(Effect.map((r) => r.task));

/**
 * Registers task leave.
 * @param ctx Context for the operation.
 */
export function registerTaskLeave(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    TASK_LEAVE_PROPERTY,
    "TaskLeave is self-only and idempotent against non-participation",
    Effect.scoped(
      Effect.gen(function* () {
        const alice = yield* acquireActor(ctx, TASK_LEAVE_PROPERTY, "tcf-tl-a");
        const task = yield* createSelfOnlyTask(alice, TASK_LEAVE_PROPERTY);
        yield* sendTaskLeave(alice, task.id, "task/leave first");
        // Idempotency: not-a-participant returns ok with no
        // notifications per spec body Goal 2.
        yield* sendTaskLeave(alice, task.id, "task/leave second");
      }),
    ).pipe(Effect.withSpan("registerTaskLeave")),
  );
}

// ─── Conversation Create + List ──────────────────────────────────────

const CONVERSATION_LIST_PROPERTY = "conversation-create-list";

const createTaskWithInitialConversation = (
  alice: Actor,
  bob: Actor,
  name: string,
  property: string,
): Effect.Effect<
  { task: Task; conversation: Conversation | null },
  FixtureError
> =>
  sendOrViolate(
    property,
    "app/task/create",
    alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agent.agentId],
      initialConversation: {
        name,
        participants: [bob.agent.agentId],
      },
    }),
  );

const listConversations = (
  alice: Actor,
  property: string,
): Effect.Effect<readonly ConversationListItem[], FixtureError> =>
  sendOrViolate(
    property,
    "agent/conversation/list",
    alice.client.sendRpc(conversationList, {}),
  ).pipe(Effect.map((r) => r.items));

const assertItemMatches = (
  items: readonly ConversationListItem[],
  conversation: Conversation,
  expectedTaskId: TaskId,
): Effect.Effect<void, FixtureError> => {
  const found = items.find((i) => i.conversation.id === conversation.id);
  if (found === undefined) {
    return Effect.fail(
      deliveryViolation(
        CONVERSATION_LIST_PROPERTY,
        "list did not surface the just-created conversation",
      ),
    );
  }
  if (found.taskId !== expectedTaskId) {
    return Effect.fail(
      deliveryViolation(
        CONVERSATION_LIST_PROPERTY,
        `list item taskId mismatch (got ${found.taskId}, want ${expectedTaskId})`,
      ),
    );
  }
  return Effect.void;
};

/**
 * Registers conversation create and list.
 * @param ctx Context for the operation.
 */
export function registerConversationCreateAndList(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    CONVERSATION_LIST_PROPERTY,
    "TaskRequest(initialConversation) + ConversationList surface the new conversation",
    Effect.scoped(
      Effect.gen(function* () {
        const alice = yield* acquireActor(
          ctx,
          CONVERSATION_LIST_PROPERTY,
          "tcf-tcl-a",
        );
        const bob = yield* acquireActor(
          ctx,
          CONVERSATION_LIST_PROPERTY,
          "tcf-tcl-b",
        );
        const payload = yield* createTaskWithInitialConversation(
          alice,
          bob,
          "conformance",
          CONVERSATION_LIST_PROPERTY,
        );
        if (payload.conversation === null) {
          return yield* Effect.fail(
            deliveryViolation(
              CONVERSATION_LIST_PROPERTY,
              "initialConversation supplied but conversation returned null",
            ),
          );
        }
        const items = yield* listConversations(
          alice,
          CONVERSATION_LIST_PROPERTY,
        );
        yield* assertItemMatches(items, payload.conversation, payload.task.id);
      }),
    ).pipe(Effect.withSpan("registerConversationCreateAndList")),
  );
}

// ─── Aggregate ───────────────────────────────────────────────────────

/** Provides the conversation family properties runtime value. */
export const CONVERSATION_FAMILY_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerTaskCreate,
  registerTaskRequestReject,
  registerTaskLeave,
  registerConversationCreateAndList,
];
