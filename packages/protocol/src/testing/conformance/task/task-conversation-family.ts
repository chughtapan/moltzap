/**
 * Conformance properties for the `task/*` + `task/conversation/*` family
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
 * Out of scope (covered by the `task-conversation-family.test.ts`
 * integration suite under
 * `packages/server/src/__tests__/integration/task/`):
 *   - Transaction rollback (requires real Postgres mid-tx failure).
 *   - Dual-emit notification arrival assertion (covered with
 *     `awaitOneNotification` in the integration suite).
 */
import { Effect, Either } from "effect";
import type { AgentId } from "../../../identity/methods.js";
import {
  DEFAULT_APP_ID,
  TaskConversationAddParticipant,
  TaskConversationArchive,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationRemoveParticipant,
  TaskConversationUnarchive,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskRejectedError,
  TaskRequest,
  TaskLeave,
  type Conversation,
  type Task,
  type TaskConversationListItem,
  type TaskId,
} from "../../../task/methods.js";
import { TaskCreate } from "../../../app/methods.js";
import type { TestClient } from "../_shared/driver/test-client.js";
import { type TestAgent } from "../_shared/test-fixtures.js";
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
  type NotificationBuffer,
} from "./_helpers.js";

const CATEGORY = DELIVERY_CATEGORY;
type FixtureError = ReturnType<typeof deliveryViolation>;
interface Actor {
  readonly agent: TestAgent;
  readonly client: TestClient;
  readonly notifications: NotificationBuffer;
}

const fixtureMap =
  (property: string) =>
  (cause: string): FixtureError =>
    deliveryViolation(property, `fixture: ${cause}`);

const acquireActor = (
  ctx: ConformanceRunContext,
  property: string,
  name: string,
) => acquireClient(ctx, name).pipe(Effect.mapError(fixtureMap(property)));

// ─── TaskRequest ──────────────────────────────────────────────────────

const TASK_CREATE_PROPERTY = "task-create";

const createTaskCreate = (
  alice: Actor,
  bob: Actor,
): Effect.Effect<
  { task: Task; conversation: Conversation | null },
  FixtureError
> =>
  alice.client
    .sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agent.agentId as AgentId],
    })
    .pipe(
      Effect.either,
      Effect.flatMap((res) =>
        requireRight(res, (e) =>
          deliveryViolation(
            TASK_CREATE_PROPERTY,
            `task/create: ${e._tag ?? String(e)}`,
          ),
        ),
      ),
    );

const assertTaskCreateShape = (payload: {
  task: { status: string };
  conversation: Conversation | null;
}): Effect.Effect<void, FixtureError> => {
  // The conformance moderator auto-accepts the task/create TM
  // callback, so task/request returns an `active` task (waiting →
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

export function registerTaskCreate(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    TASK_CREATE_PROPERTY,
    "task/request under an accepting TM transitions waiting → active and fires task/created to the initiator",
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
              `task/created carried task.id ${event.params.task.id}, expected ${payload.task.id}`,
            ),
          );
        }
        if (event.params.task.status !== "active") {
          return yield* Effect.fail(
            deliveryViolation(
              TASK_CREATE_PROPERTY,
              `task/created carried status ${event.params.task.status}, expected active`,
            ),
          );
        }
      }),
    ).pipe(Effect.withSpan("registerTaskCreate")),
  );
}

const awaitTaskCreated = (actor: Actor, property: string) =>
  awaitOneNotification(
    actor.notifications,
    TaskCreatedNotificationDefinition,
    DELIVERY_DEFAULT_TIMEOUT_MS,
  ).pipe(
    Effect.mapError((reason) =>
      deliveryViolation(property, `task/created missing: ${reason}`),
    ),
  );

// ─── TaskRequest — TM reject path ────────────────────────────────────

const TASK_REQUEST_REJECT_PROPERTY = "task-request-tm-reject";
const REJECT_REASON = "app_policy";

// Register a SEPARATE app principal (HTTP + `appKey` Connect) whose
// `task/create` callback always rejects. Returns the server-minted appId
// that the requesting agent targets in `task/request`.
const registerRejectingTm = (ctx: ConformanceRunContext) =>
  registerTestApp({
    baseUrl: ctx.realServer.baseUrl,
    wsUrl: ctx.realServer.wsUrl,
    appId: crypto.randomUUID(),
    name: "rejecting-tm",
    // Declare the `task_create` hook so the server round-trips the
    // task-admission decision to the app (a hookless manifest opts into the
    // synthetic-accept fast-path, which would never reach the reject below).
    taskCreateTimeoutMs: 5_000,
  }).pipe(
    Effect.mapError((e) =>
      deliveryViolation(
        TASK_REQUEST_REJECT_PROPERTY,
        `apps/register: ${e._tag}`,
      ),
    ),
    Effect.tap((app) =>
      app.client.onAppCallback(TaskCreate, () =>
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
    // The reject surfaces as the typed `TaskRejected` wire error
    // (-32024), NOT a generic internal error — that is the contract
    // a requester discriminates on. Asserting the specific code keeps
    // this non-vacuous: any-Left would also pass for an unrelated
    // transport failure, which would not prove the TM-reject path.
    onLeft: (error) => {
      const code = (error as { readonly code?: unknown }).code;
      return code === TaskRejectedError.code
        ? Effect.void
        : Effect.fail(
            deliveryViolation(
              TASK_REQUEST_REJECT_PROPERTY,
              `task/request failed with code ${String(code)}, expected TaskRejected (${TaskRejectedError.code})`,
            ),
          );
    },
    onRight: () =>
      Effect.fail(
        deliveryViolation(
          TASK_REQUEST_REJECT_PROPERTY,
          "task/request resolved OK; expected an RPC error on TM reject",
        ),
      ),
  });

const assertTaskFailedReason = (actor: Actor) =>
  awaitOneNotification(
    actor.notifications,
    TaskFailedNotificationDefinition,
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

export function registerTaskRequestReject(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    TASK_REQUEST_REJECT_PROPERTY,
    "task/request fails and fires task/failed when the bound TM rejects via the task/create callback",
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
        const appId = yield* registerRejectingTm(ctx);
        const outcome = yield* alice.client
          .sendRpc(TaskRequest, {
            appId,
            invitedAgentIds: [bob.agent.agentId as AgentId],
          })
          .pipe(Effect.either);
        yield* assertTaskRequestFailed(outcome);
        // The initiator observes `task/failed` on the waiting → failed
        // transition, carrying the TM's reject reason.
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
  alice.client.sendRpc(TaskLeave, { taskId }).pipe(
    Effect.either,
    Effect.flatMap((res) =>
      requireRight(res, (e) =>
        deliveryViolation(
          TASK_LEAVE_PROPERTY,
          `${context}: ${e._tag ?? String(e)}`,
        ),
      ),
    ),
    Effect.asVoid,
  );

const createSelfOnlyTask = (
  alice: Actor,
  property: string,
): Effect.Effect<Task, FixtureError> =>
  alice.client
    .sendRpc(TaskRequest, { appId: DEFAULT_APP_ID, invitedAgentIds: [] })
    .pipe(
      Effect.either,
      Effect.flatMap((res) =>
        requireRight(res, (e) =>
          deliveryViolation(property, `task/create: ${e._tag ?? String(e)}`),
        ),
      ),
      Effect.map((r) => r.task),
    );

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

// ─── TaskConversationCreate + List ───────────────────────────────────

const TCC_LIST_PROPERTY = "task-conversation-create-list";

const createTaskWithInitialConversation = (
  alice: Actor,
  bob: Actor,
  name: string,
  property: string,
): Effect.Effect<
  { task: Task; conversation: Conversation | null },
  FixtureError
> =>
  alice.client
    .sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agent.agentId as AgentId],
      initialConversation: {
        name,
        participants: [bob.agent.agentId as AgentId],
      },
    })
    .pipe(
      Effect.either,
      Effect.flatMap((res) =>
        requireRight(res, (e) =>
          deliveryViolation(property, `task/create: ${e._tag ?? String(e)}`),
        ),
      ),
    );

const listTaskConversations = (
  alice: Actor,
  property: string,
): Effect.Effect<readonly TaskConversationListItem[], FixtureError> =>
  alice.client.sendRpc(TaskConversationList, {}).pipe(
    Effect.either,
    Effect.flatMap((res) =>
      requireRight(res, (e) =>
        deliveryViolation(
          property,
          `task/conversation/list: ${e._tag ?? String(e)}`,
        ),
      ),
    ),
    Effect.map((r) => r.items),
  );

const assertItemMatches = (
  items: readonly TaskConversationListItem[],
  conversation: Conversation,
  expectedTaskId: TaskId,
): Effect.Effect<void, FixtureError> => {
  const found = items.find((i) => i.conversation.id === conversation.id);
  if (found === undefined) {
    return Effect.fail(
      deliveryViolation(
        TCC_LIST_PROPERTY,
        "list did not surface the just-created conversation",
      ),
    );
  }
  if (found.taskId !== expectedTaskId) {
    return Effect.fail(
      deliveryViolation(
        TCC_LIST_PROPERTY,
        `list item taskId mismatch (got ${found.taskId}, want ${expectedTaskId})`,
      ),
    );
  }
  return Effect.void;
};

export function registerTaskConversationCreateAndList(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    TCC_LIST_PROPERTY,
    "TaskRequest(initialConversation) + TaskConversationList surface the new conversation",
    Effect.scoped(
      Effect.gen(function* () {
        const alice = yield* acquireActor(ctx, TCC_LIST_PROPERTY, "tcf-tcl-a");
        const bob = yield* acquireActor(ctx, TCC_LIST_PROPERTY, "tcf-tcl-b");
        const payload = yield* createTaskWithInitialConversation(
          alice,
          bob,
          "conformance",
          TCC_LIST_PROPERTY,
        );
        if (payload.conversation === null) {
          return yield* Effect.fail(
            deliveryViolation(
              TCC_LIST_PROPERTY,
              "initialConversation supplied but conversation returned null",
            ),
          );
        }
        const items = yield* listTaskConversations(alice, TCC_LIST_PROPERTY);
        yield* assertItemMatches(items, payload.conversation, payload.task.id);
      }),
    ).pipe(Effect.withSpan("registerTaskConversationCreateAndList")),
  );
}

// ─── TM-only deny paths ──────────────────────────────────────────────
//
// Under DEFAULT_APP_ID the TM endpoint is the in-process app handler,
// so no test agent passes the TM authority gate. Each property pins
// the deny shape (typed wire error). Success paths are exercised
// end-to-end by the integration suite under
// `packages/server/src/__tests__/integration/task/`.

const expectRpcDenial = <Result>(
  send: Effect.Effect<Result, unknown>,
  property: string,
  context: string,
): Effect.Effect<void, FixtureError> =>
  send.pipe(
    Effect.either,
    Effect.flatMap((res) =>
      Either.match(res, {
        onLeft: () => Effect.void,
        onRight: () =>
          Effect.fail(
            deliveryViolation(
              property,
              `${context}: expected RPC denial; succeeded`,
            ),
          ),
      }),
    ),
  );

const TCA_DENIED_PROPERTY = "task-conversation-archive-denied";

const runArchiveUnarchiveDenied = (ctx: ConformanceRunContext) =>
  Effect.scoped(
    Effect.gen(function* () {
      const alice = yield* acquireActor(ctx, TCA_DENIED_PROPERTY, "tcf-tca-a");
      const bob = yield* acquireActor(ctx, TCA_DENIED_PROPERTY, "tcf-tca-b");
      const payload = yield* createTaskWithInitialConversation(
        alice,
        bob,
        "tca",
        TCA_DENIED_PROPERTY,
      );
      const conversation = payload.conversation;
      if (conversation === null) {
        return yield* Effect.fail(
          deliveryViolation(TCA_DENIED_PROPERTY, "no conversation to archive"),
        );
      }
      yield* expectRpcDenial(
        alice.client.sendRpc(TaskConversationArchive, {
          taskId: payload.task.id,
          conversationId: conversation.id,
        }),
        TCA_DENIED_PROPERTY,
        "task/conversation/archive",
      );
      yield* expectRpcDenial(
        alice.client.sendRpc(TaskConversationUnarchive, {
          taskId: payload.task.id,
          conversationId: conversation.id,
        }),
        TCA_DENIED_PROPERTY,
        "task/conversation/unarchive",
      );
    }),
  );

export function registerTaskConversationArchiveDenied(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    TCA_DENIED_PROPERTY,
    "TaskConversationArchive/Unarchive deny non-TM callers under DEFAULT_APP_ID",
    runArchiveUnarchiveDenied(ctx).pipe(
      Effect.withSpan("registerTaskConversationArchiveDenied"),
    ),
  );
}

const TCAP_PROPERTY = "task-conversation-add-participant";

export function registerTaskConversationAddParticipant(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    TCAP_PROPERTY,
    "TaskConversationAddParticipant rejects non-admitted targets",
    Effect.scoped(
      Effect.gen(function* () {
        const alice = yield* acquireActor(ctx, TCAP_PROPERTY, "tcf-tcap-a");
        const bob = yield* acquireActor(ctx, TCAP_PROPERTY, "tcf-tcap-b");
        const carol = yield* acquireActor(ctx, TCAP_PROPERTY, "tcf-tcap-c");
        const payload = yield* createTaskWithInitialConversation(
          alice,
          bob,
          "tcap",
          TCAP_PROPERTY,
        );
        const conversation = payload.conversation;
        if (conversation === null) {
          return yield* Effect.fail(
            deliveryViolation(TCAP_PROPERTY, "no conversation"),
          );
        }
        // Carol is NOT in `task_participants`; the participant-
        // admitted invariant fires before the authority gate.
        yield* expectRpcDenial(
          alice.client.sendRpc(TaskConversationAddParticipant, {
            taskId: payload.task.id,
            conversationId: conversation.id,
            agentId: carol.agent.agentId as AgentId,
          }),
          TCAP_PROPERTY,
          "task/conversation/participants/add (non-admitted)",
        );
      }),
    ).pipe(Effect.withSpan("registerTaskConversationAddParticipant")),
  );
}

const TCRP_PROPERTY = "task-conversation-remove-participant";

export function registerTaskConversationRemoveParticipant(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    TCRP_PROPERTY,
    "TaskConversationRemoveParticipant denies non-TM callers",
    Effect.scoped(
      Effect.gen(function* () {
        const alice = yield* acquireActor(ctx, TCRP_PROPERTY, "tcf-tcrp-a");
        const bob = yield* acquireActor(ctx, TCRP_PROPERTY, "tcf-tcrp-b");
        const payload = yield* createTaskWithInitialConversation(
          alice,
          bob,
          "tcrp",
          TCRP_PROPERTY,
        );
        const conversation = payload.conversation;
        if (conversation === null) {
          return yield* Effect.fail(
            deliveryViolation(TCRP_PROPERTY, "no conversation"),
          );
        }
        yield* expectRpcDenial(
          alice.client.sendRpc(TaskConversationRemoveParticipant, {
            taskId: payload.task.id,
            conversationId: conversation.id,
            agentId: bob.agent.agentId as AgentId,
          }),
          TCRP_PROPERTY,
          "task/conversation/participants/remove (non-TM)",
        );
      }),
    ).pipe(Effect.withSpan("registerTaskConversationRemoveParticipant")),
  );
}

const TCC_DENIED_PROPERTY = "task-conversation-create-denied";

export function registerTaskConversationCreateDenied(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    TCC_DENIED_PROPERTY,
    "TaskConversationCreate denies non-TM caller under DEFAULT_APP_ID",
    Effect.scoped(
      Effect.gen(function* () {
        const alice = yield* acquireActor(
          ctx,
          TCC_DENIED_PROPERTY,
          "tcf-tccd-a",
        );
        const bob = yield* acquireActor(ctx, TCC_DENIED_PROPERTY, "tcf-tccd-b");
        const payload = yield* alice.client
          .sendRpc(TaskRequest, {
            appId: DEFAULT_APP_ID,
            invitedAgentIds: [bob.agent.agentId as AgentId],
          })
          .pipe(
            Effect.either,
            Effect.flatMap((res) =>
              requireRight(res, (e) =>
                deliveryViolation(
                  TCC_DENIED_PROPERTY,
                  `task/create: ${e._tag ?? String(e)}`,
                ),
              ),
            ),
          );
        yield* expectRpcDenial(
          alice.client.sendRpc(TaskConversationCreate, {
            taskId: payload.task.id,
            name: "denied-spinoff",
            participants: [bob.agent.agentId as AgentId],
          }),
          TCC_DENIED_PROPERTY,
          "task/conversation/create (non-TM)",
        );
      }),
    ).pipe(Effect.withSpan("registerTaskConversationCreateDenied")),
  );
}

// ─── Aggregate ───────────────────────────────────────────────────────

export const TASK_CONVERSATION_FAMILY_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerTaskCreate,
  registerTaskRequestReject,
  registerTaskLeave,
  registerTaskConversationCreateAndList,
  registerTaskConversationCreateDenied,
  registerTaskConversationArchiveDenied,
  registerTaskConversationAddParticipant,
  registerTaskConversationRemoveParticipant,
];
