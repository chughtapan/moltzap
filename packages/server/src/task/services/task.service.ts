import { Cause, Effect, Option } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import {
  endpointAddress as brandEndpointAddress,
  makeEndpointAddress,
  type EndpointAddress,
} from "@moltzap/protocol/network";
import { defaultTmAddressForType } from "../../network/app-tm-registry.js";
import type {
  Conversation,
  Message,
  Part,
  Task,
  TaskParticipant,
  TaskStatus,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId, ConversationId, MessageId } from "@moltzap/protocol/task";
import type { Db } from "../../db/client.js";
import type { Database } from "../../db/database.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "../../db/effect-kysely-toolkit.js";
import type { Transaction } from "../../db/kysely-vendor.js";
import {
  ForbiddenError,
  NotFoundError,
  ParticipantNotAdmittedError,
} from "@moltzap/protocol";
import type {
  ConversationService,
  ConversationServiceError,
} from "./conversation.service.js";
import type { MessageService, MessageServiceError } from "./message.service.js";
import {
  ConversationCreateAuthorization,
  ConversationInTask,
  MessageSendPermission,
  TaskReadAccess,
  TmAuthority,
  assertConversationInTaskMatches,
  assertTaskReadAccessMatchesTask,
  assertTmAuthorityMatchesTask,
} from "../../app/capabilities/index.js";

/**
 * Public-but-package-scoped error union. Spec E (#601) needs this
 * exported so capability obtain helpers in `app/capabilities/` can
 * declare matching error channels without over-narrowing.
 * @internal
 */
export type TaskServiceError =
  | ForbiddenError
  | NotFoundError
  | ParticipantNotAdmittedError
  | ConversationServiceError
  | MessageServiceError;

const ERR_NOT_FOUND = "Task not found";
const ERR_NOT_TM = "Caller is not the registered task manager for this task";
const ERR_NOT_PARTICIPANT = "Caller is not a participant of this task";
const ERR_CONV_NOT_IN_TASK =
  "Conversation does not belong to the specified task";
const ERR_TASK_NOT_OPEN = "Task is not open for mutation";

function absurdTaskStatus(status: never): never {
  throw new Error(`unreachable task status: ${JSON.stringify(status)}`);
}

const DEFAULT_TASK_LIST_LIMIT = 50;
const DEFAULT_TASK_MESSAGES_LIMIT = 50;

interface TaskRow {
  readonly id: TaskId;
  readonly app_id: string | null;
  readonly initiator_agent_id: AgentId;
  readonly status: TaskStatus;
  // Phase 9b consumer-migration (sub-issue #460 round 3 R12): NOT NULL.
  readonly tm_endpoint_address: string;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly created_at: Date;
}

/**
 * Stable TM-endpoint address for a registering agent: `tm:agent:&lt;agentId>`.
 * Persisted in `tasks.tm_endpoint_address` and routed through
 * `network.send` via `AgentEndpointResolver.resolveAll`. Phase 9b
 * consumer-migration (sub-issue #460 amendment) collapsed the volatile
 * per-WS-connection form into a resolver-internal `ConnectionId` lookup
 * — `tm:agent:&lt;agentId>` is the only `EndpointAddress` shape that
 * appears on the wire today.
 */
export function endpointAddressForAgent(agent: AgentId): EndpointAddress {
  return makeEndpointAddress("agent", agent);
}

/**
 * Spec D1 (#598) — stable TM-endpoint address derived from an `appId`.
 * Used by `task/create` to persist
 * `tasks.tm_endpoint_address = tm:app:&lt;appId>`. The address derives
 * deterministically from the UUID so every server boot binds the same
 * address per app. The default DM / group TMs from
 * `app-tm-registry` keep their pre-D1 addresses; they retire alongside
 * the legacy `conversations/*` family in D3 (#600).
 */
export function defaultAppTmEndpointAddress(appId: string): EndpointAddress {
  return makeEndpointAddress("app", appId);
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    appId: row.app_id,
    initiatorAgentId: row.initiator_agent_id,
    status: row.status,
    tmEndpointAddress: row.tm_endpoint_address,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function rowToParticipant(row: {
  readonly task_id: TaskId;
  readonly agent_id: AgentId;
  readonly admitted_at: Date | null;
}): TaskParticipant {
  return {
    taskId: row.task_id,
    agentId: row.agent_id,
    admittedAt: row.admitted_at ? row.admitted_at.toISOString() : null,
  };
}

export interface TaskCreateInput {
  readonly appId?: string;
  readonly invitedAgentIds?: readonly AgentId[];

  /**
   * Phase 9b consumer-migration (sub-issue #460 round 3 R13): atomic
   * task creation. Replaces the pre-R13 two-step (`tasks/create` then
   * `endpoints/registerTaskManager`). Required by the schema-level
   * NOT NULL constraint on `tasks.tm_endpoint_address` (R12).
   * - Custom-TM callers (e.g. werewolf) pass
   *   `endpointAddressForAgent(callerAgentId)` so the TM IS the
   *   caller, matching the address `endpoints/registerTaskManager`
   *   used to derive.
   * - `conversations/create` auto-task callers pass a default
   *   `tm:app:&lt;defaultDmTm | defaultGroupTm>` address (R14).
   */
  readonly tmEndpointAddress: EndpointAddress;
}

export interface TaskListInput {
  readonly appId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export interface TaskMessagesInput {
  readonly conversationId: ConversationId;
  readonly limit?: number;
}

export interface TaskMessagesSinceInput {
  readonly conversationId: ConversationId;
  readonly sinceSeq: string;
  readonly limit?: number;
}

export interface CreateConversationInput {
  readonly type: "dm" | "group";
  readonly name?: string;
  readonly participantAgentIds: readonly AgentId[];
}

export interface StoreMessageInput {
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly parts: readonly Part[];
  readonly replyToId?: MessageId;
}

export interface TaskCloseLifecycle {
  readonly task: Task;
  readonly participantAgentIds: readonly AgentId[];
  readonly archivedConversations: readonly {
    readonly conversationId: ConversationId;
    readonly archivedAt: string;
    readonly participantAgentIds: readonly AgentId[];
  }[];
}

/**
 * Spec D1 (#598) — return shape of `TaskService.leaveTask`. The
 * handler fans out one removal notification per `leftConversationIds`
 * (dual-emit), plus `TaskClosedNotificationDefinition` when
 * `closedTask` is non-null.
 */
export interface TaskLeaveResult {
  readonly leftConversationIds: ReadonlyArray<ConversationId>;
  readonly closedTask: Task | null;
}

type TaskTransaction = Transaction<Database>;
type ArchivedConversationRow = {
  readonly id: ConversationId;
  readonly archived_at: Date | null;
};
type ConversationParticipantRow = {
  readonly conversation_id: ConversationId;
  readonly agent_id: AgentId;
};
type AgentIdRow = {
  readonly agent_id: AgentId;
};

function conversationIdsFromRows(
  rows: readonly ArchivedConversationRow[],
): ConversationId[] {
  const ids: ConversationId[] = [];
  for (const row of rows) ids.push(row.id);
  return ids;
}

function participantMapFromRows(
  rows: readonly ConversationParticipantRow[],
): ReadonlyMap<ConversationId, readonly AgentId[]> {
  const participantsByConversation = new Map<ConversationId, AgentId[]>();
  for (const row of rows) {
    const existing = participantsByConversation.get(row.conversation_id) ?? [];
    existing.push(row.agent_id);
    participantsByConversation.set(row.conversation_id, existing);
  }
  return participantsByConversation;
}

function agentIdsFromRows(rows: readonly AgentIdRow[]): AgentId[] {
  const agentIds: AgentId[] = [];
  for (const row of rows) agentIds.push(row.agent_id);
  return agentIds;
}

function archivedConversationsFromRows(
  rows: readonly ArchivedConversationRow[],
  participantsByConversation: ReadonlyMap<ConversationId, readonly AgentId[]>,
): TaskCloseLifecycle["archivedConversations"] {
  const archivedConversations: Array<
    TaskCloseLifecycle["archivedConversations"][number]
  > = [];
  for (const row of rows) {
    archivedConversations.push({
      conversationId: row.id,
      archivedAt: row.archived_at!.toISOString(),
      participantAgentIds: participantsByConversation.get(row.id) ?? [],
    });
  }
  return archivedConversations;
}

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
  ) {}

  create(
    initiator: AgentId,
    input: TaskCreateInput,
  ): Effect.Effect<Task, TaskServiceError> {
    return catchSqlErrorAsDefect(
      transaction(this.db, (trx) =>
        Effect.gen(function* () {
          const row = yield* takeFirstOrFail(
            trx
              .insertInto("tasks")
              .values({
                app_id: input.appId ?? null,
                initiator_agent_id: initiator,
                status: "waiting",
                tm_endpoint_address: input.tmEndpointAddress,
              })
              .returningAll(),
          );
          yield* trx.insertInto("task_participants").values({
            task_id: row.id,
            agent_id: initiator,
            admitted_at: new Date(),
          });
          const invited = input.invitedAgentIds ?? [];
          for (const agentId of invited) {
            yield* trx
              .insertInto("task_participants")
              .values({
                task_id: row.id,
                agent_id: agentId,
                admitted_at: null,
              })
              .onConflict((oc) => oc.doNothing());
          }
          return rowToTask(row as TaskRow);
        }),
      ),
    );
  }

  get(
    id: TaskId,
    _caller: AgentId,
  ): Effect.Effect<
    { task: Task; participants: TaskParticipant[] },
    TaskServiceError,
    TaskReadAccess
  > {
    return Effect.gen(this, function* () {
      const cap = yield* TaskReadAccess;
      yield* assertTaskReadAccessMatchesTask(cap, id);
      const rows = yield* catchSqlErrorAsDefect(
        this.db
          .selectFrom("task_participants")
          .selectAll()
          .where("task_id", "=", id),
      );
      return {
        task: cap.task,
        participants: rows.map(rowToParticipant),
      };
    });
  }

  list(
    caller: AgentId,
    input: TaskListInput,
  ): Effect.Effect<readonly Task[], never> {
    const limit = input.limit ?? DEFAULT_TASK_LIST_LIMIT;
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        let qb = this.db
          .selectFrom("tasks")
          .innerJoin(
            "task_participants",
            "task_participants.task_id",
            "tasks.id",
          )
          .where("task_participants.agent_id", "=", caller)
          .selectAll("tasks")
          .orderBy("tasks.created_at", "desc")
          .limit(limit);
        if (input.appId !== undefined) {
          qb = qb.where("tasks.app_id", "=", input.appId);
        }
        if (input.status !== undefined) {
          qb = qb.where("tasks.status", "=", input.status);
        }
        const rows = yield* qb;
        return rows.map((row) => rowToTask(row as TaskRow));
      }),
    );
  }

  close(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<Task, TaskServiceError, TmAuthority> {
    return this.closeWithLifecycle(id, caller).pipe(
      Effect.map((closed) => closed.task),
    );
  }

  closeWithLifecycle(
    id: TaskId,
    _caller: AgentId,
  ): Effect.Effect<TaskCloseLifecycle, TaskServiceError, TmAuthority> {
    return Effect.gen(this, function* () {
      const cap = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(cap, id);
      return yield* catchSqlErrorAsDefect(
        transaction(this.db, (trx) => this.closeLifecycleTransaction(trx, id)),
      );
    });
  }

  private closeLifecycleTransaction(trx: TaskTransaction, id: TaskId) {
    return Effect.gen(this, function* () {
      const closedAt = new Date();
      const taskRow = yield* this.closeTaskRow(trx, id, closedAt);
      const archivedRows = yield* this.archiveOpenTaskConversations(
        trx,
        id,
        closedAt,
      );
      const conversationIds = conversationIdsFromRows(archivedRows);
      const participantsByConversation =
        yield* this.readConversationParticipantMap(trx, conversationIds);
      return {
        task: rowToTask(taskRow as TaskRow),
        participantAgentIds: yield* this.readAdmittedTaskParticipantIds(
          trx,
          id,
        ),
        archivedConversations: archivedConversationsFromRows(
          archivedRows,
          participantsByConversation,
        ),
      };
    });
  }

  private closeTaskRow(trx: TaskTransaction, id: TaskId, closedAt: Date) {
    return takeFirstOrFail(
      trx
        .updateTable("tasks")
        .set({ status: "closed", ended_at: closedAt })
        .where("id", "=", id)
        .returningAll(),
    );
  }

  private archiveOpenTaskConversations(
    trx: TaskTransaction,
    id: TaskId,
    closedAt: Date,
  ) {
    return trx
      .updateTable("conversations")
      .set({ archived_at: closedAt })
      .where("task_id", "=", id)
      .where("archived_at", "is", null)
      .returning(["id", "archived_at"]);
  }

  private readConversationParticipantMap(
    trx: TaskTransaction,
    conversationIds: readonly ConversationId[],
  ) {
    if (conversationIds.length === 0) {
      return Effect.succeed(new Map<ConversationId, readonly AgentId[]>());
    }
    return trx
      .selectFrom("conversation_participants")
      .select(["conversation_id", "agent_id"])
      .where("conversation_id", "in", [...conversationIds])
      .pipe(Effect.map(participantMapFromRows));
  }

  private readAdmittedTaskParticipantIds(trx: TaskTransaction, id: TaskId) {
    return trx
      .selectFrom("task_participants")
      .select("agent_id")
      .where("task_id", "=", id)
      .where("admitted_at", "is not", null)
      .pipe(Effect.map(agentIdsFromRows));
  }

  /**
   * Phase 9b consumer-migration (sub-issue #460 round 3 R14): server-
   * internal helper for the `conversations/create` auto-task path and
   * the `messages/send` auto-DM path. Creates a task whose TM is the
   * default `tm:app:&lt;dm | group>` endpoint, returning the row so the
   * caller can pass `task.id` to `ConversationService.create`.
   *
   * Used by `conversations/create` (server handler) and the
   * `messages/send` agent:&lt;name> path. Custom-TM apps (werewolf etc.)
   * call the public `create` directly with their own
   * `tmEndpointAddress` instead.
   */
  createDefaultTaskForType(
    type: "dm" | "group",
    initiator: AgentId,
    invitedAgentIds: readonly AgentId[] = [],
  ): Effect.Effect<Task, TaskServiceError> {
    // Importing the constants lazily here would create a cycle —
    // `app-tm-registry` is a network-layer module, `task.service` is
    // service-layer. Module-load-time import via the top of file is
    // fine; resolved lazily by the `taskTmAddressForType` helper at
    // file end.
    return this.create(initiator, {
      invitedAgentIds,
      tmEndpointAddress: defaultTmAddressForType(type),
    });
  }

  // Phase 9b consumer-migration (sub-issue #460 round 3 R12): the
  // `registerTm` / `unregisterTm` methods retired alongside the wire
  // RPCs. Atomic creation in `create` (R13) sets `tm_endpoint_address`
  // at insert time; the schema-level NOT NULL constraint forbids the
  // intermediate "task without TM" state.

  // Phase 9b consumer-migration (sub-issue #460 round 3 R12):
  // `task.tmEndpointAddress` is now non-null by construction. The
  // pre-R12 null branch retired alongside `endpoints/unregisterTaskManager`.
  loadTaskAsTmAuthority(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<Task, TaskServiceError> {
    return Effect.gen(this, function* () {
      const task = yield* this.fetchTask(id);
      switch (task.status) {
        case "waiting":
        case "active":
          break;
        case "closed":
        case "failed":
          return yield* Effect.fail(
            new ForbiddenError({ message: ERR_TASK_NOT_OPEN }),
          );
        default:
          return absurdTaskStatus(task.status);
      }
      const recorded = yield* Effect.try({
        try: () => brandEndpointAddress(task.tmEndpointAddress),
        catch: () => new ForbiddenError({ message: ERR_NOT_TM }),
      });
      const expected = endpointAddressForAgent(caller);
      if (recorded !== expected) {
        return yield* Effect.fail(new ForbiddenError({ message: ERR_NOT_TM }));
      }
      return task;
    });
  }

  loadTaskWithReadAccess(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<Task, TaskServiceError> {
    return Effect.gen(this, function* () {
      const task = yield* this.fetchTask(id);
      if (task.initiatorAgentId === caller) return task;
      // Pending invites (admitted_at IS NULL) are NOT read access.
      const participant = yield* catchSqlErrorAsDefect(
        takeFirstOption(
          this.db
            .selectFrom("task_participants")
            .select("agent_id")
            .where("task_id", "=", id)
            .where("agent_id", "=", caller)
            .where("admitted_at", "is not", null),
        ),
      );
      if (Option.isNone(participant)) {
        return yield* Effect.fail(
          new ForbiddenError({ message: ERR_NOT_PARTICIPANT }),
        );
      }
      return task;
    });
  }

  addParticipant(
    id: TaskId,
    _caller: AgentId,
    target: AgentId,
  ): Effect.Effect<TaskParticipant, TaskServiceError, TmAuthority> {
    return Effect.gen(this, function* () {
      const cap = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(cap, id);
      const row = yield* catchSqlErrorAsDefect(
        takeFirstOrFail(
          this.db
            .insertInto("task_participants")
            .values({
              task_id: id,
              agent_id: target,
              admitted_at: new Date(),
            })
            .onConflict((oc) =>
              oc
                .columns(["task_id", "agent_id"])
                .doUpdateSet({ admitted_at: new Date() }),
            )
            .returningAll(),
        ),
      );
      return rowToParticipant(row);
    });
  }

  removeParticipant(
    id: TaskId,
    _caller: AgentId,
    target: AgentId,
  ): Effect.Effect<void, TaskServiceError, TmAuthority> {
    return Effect.gen(this, function* () {
      const cap = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(cap, id);
      yield* catchSqlErrorAsDefect(
        this.db
          .deleteFrom("task_participants")
          .where("task_id", "=", id)
          .where("agent_id", "=", target),
      );
    });
  }

  createConversation(
    id: TaskId,
    caller: AgentId,
    input: CreateConversationInput,
  ): Effect.Effect<
    Conversation,
    TaskServiceError,
    TmAuthority | ConversationCreateAuthorization
  > {
    return Effect.gen(this, function* () {
      const cap = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(cap, id);
      // The task id is fixed (this is a TM acting on its own task),
      // so wrap it in `Effect.succeed` for the lazy-`mintTask`
      // contract `ConversationService.create` expects.
      return yield* this.conversations.create({
        type: input.type,
        name: input.name,
        agentIds: [...input.participantAgentIds],
        creatorAgentId: caller,
        mintTask: Effect.succeed({ id }),
      });
    });
  }

  closeConversation(
    id: TaskId,
    _caller: AgentId,
    conversationId: ConversationId,
  ): Effect.Effect<void, TaskServiceError, TmAuthority | ConversationInTask> {
    return Effect.gen(this, function* () {
      const tm = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(tm, id);
      const inTask = yield* ConversationInTask;
      yield* assertConversationInTaskMatches(inTask, id, conversationId);
      yield* this.archiveConversationInTask(id, conversationId);
    });
  }

  storeMessage(
    id: TaskId,
    _caller: AgentId,
    input: StoreMessageInput,
  ): Effect.Effect<
    Message,
    TaskServiceError,
    TmAuthority | ConversationInTask | MessageSendPermission
  > {
    return Effect.gen(this, function* () {
      const tm = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(tm, id);
      const inTask = yield* ConversationInTask;
      yield* assertConversationInTaskMatches(inTask, id, input.conversationId);
      // The post-insert UPDATE retired — `MessageService.send` stamps
      // `task_id` from `conv.task_id` at insert time, and the
      // `ConversationInTask` capability above already proved
      // `conv.task_id === id`.
      return yield* this.messages.send({
        conversationId: input.conversationId,
        parts: [...input.parts],
        senderAgentId: input.senderAgentId,
        replyToId: input.replyToId,
        bypassTmRouting: true,
      });
    });
  }

  getMessages(
    id: TaskId,
    caller: AgentId,
    input: TaskMessagesInput,
  ): Effect.Effect<
    { messages: Message[]; hasMore: boolean },
    TaskServiceError,
    TaskReadAccess | ConversationInTask
  > {
    return Effect.gen(this, function* () {
      const access = yield* TaskReadAccess;
      yield* assertTaskReadAccessMatchesTask(access, id);
      const inTask = yield* ConversationInTask;
      yield* assertConversationInTaskMatches(inTask, id, input.conversationId);
      return yield* this.messages.list(input.conversationId, caller, {
        limit: input.limit ?? DEFAULT_TASK_MESSAGES_LIMIT,
      });
    });
  }

  getMessagesSince(
    id: TaskId,
    caller: AgentId,
    input: TaskMessagesSinceInput,
  ): Effect.Effect<
    { messages: Message[]; hasMore: boolean },
    TaskServiceError,
    TaskReadAccess | ConversationInTask
  > {
    return Effect.gen(this, function* () {
      const access = yield* TaskReadAccess;
      yield* assertTaskReadAccessMatchesTask(access, id);
      const inTask = yield* ConversationInTask;
      yield* assertConversationInTaskMatches(inTask, id, input.conversationId);
      return yield* this.messages.list(input.conversationId, caller, {
        limit: input.limit ?? DEFAULT_TASK_MESSAGES_LIMIT,
        sinceSeq: input.sinceSeq,
      });
    });
  }

  /**
   * Spec E (#601) Decision B / Option A — package-private fetch helper
   * consumed by `obtainMessageSendPermission` to populate the composite
   * `MessageSendPermission.task` payload field. Not part of the
   * service's exported public surface; the JSDoc tag is the convention.
   * @internal
   */
  fetchTask(id: TaskId): Effect.Effect<Task, TaskServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const opt = yield* takeFirstOption(
          this.db.selectFrom("tasks").selectAll().where("id", "=", id),
        );
        if (Option.isNone(opt)) {
          return yield* Effect.fail(
            new NotFoundError({ message: ERR_NOT_FOUND }),
          );
        }
        return rowToTask(opt.value as TaskRow);
      }),
    );
  }

  /**
   * Spec E (#601) Decision B / Option A — package-private relationship
   * check consumed by `obtainConversationInTask`. Not part of the
   * service's exported public surface; the JSDoc tag is the convention.
   * @internal
   */
  assertConversationInTask(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<void, TaskServiceError> {
    return Effect.gen(this, function* () {
      const linkedOpt = yield* catchSqlErrorAsDefect(
        takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("task_id")
            .where("id", "=", conversationId),
        ),
      );
      if (Option.isNone(linkedOpt)) {
        return yield* Effect.fail(
          new NotFoundError({ message: "Conversation not found" }),
        );
      }
      if (linkedOpt.value.task_id !== id) {
        return yield* Effect.fail(
          new ForbiddenError({ message: ERR_CONV_NOT_IN_TASK }),
        );
      }
    });
  }

  /**
   * Spec E (#601) — Phase 1 new helper consumed by
   * `obtainAgentInTaskParticipants`. Mirrors the inline
   * `task_participants` lookup D1's `TaskConversationAddParticipant`
   * would otherwise duplicate. Fails closed with `ForbiddenError` when
   * the agent is absent or pending.
   * @internal
   */
  assertAgentInTaskParticipants(
    id: TaskId,
    agentId: AgentId,
  ): Effect.Effect<void, ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("task_participants")
            .select("agent_id")
            .where("task_id", "=", id)
            .where("agent_id", "=", agentId)
            .where("admitted_at", "is not", null),
        );
        if (Option.isNone(rowOpt)) {
          return yield* Effect.fail(
            new ForbiddenError({ message: ERR_NOT_PARTICIPANT }),
          );
        }
      }),
    );
  }

  private archiveConversationInTask(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<void, TaskServiceError> {
    return Effect.gen(this, function* () {
      const updated = yield* catchSqlErrorAsDefect(
        this.db
          .updateTable("conversations")
          .set({ archived_at: new Date() })
          .where("id", "=", conversationId)
          .where("task_id", "=", id)
          .returning("id"),
      );
      if (updated.length > 0) return;
      yield* this.assertConversationInTask(id, conversationId);
    });
  }

  /**
   * Spec D1 (#598) — participant-admitted invariant for the new
   * `task/conversation/*` admin handlers.
   *
   * The wire-level participant invariant per spec body Goal 1 is "agent
   * has a row in `task_participants(task_id, agent_id)`"; admission
   * state is a separate gate (a row with `admittedAt IS NULL` still
   * passes). This complements the Spec E
   * `obtainAgentInTaskParticipants` helper, which is the stricter
   * "admitted only" check used by message-send authority.
   *
   * Fails closed with `ParticipantNotAdmittedError` on the first agent
   * missing from `task_participants` so clients can distinguish
   * "invalid agent id shape" (`InvalidParamsError`) from "agent exists
   * but is not admitted to this task" (this tag) without parsing
   * messages. `SqlError` is caught defectively.
   * @internal
   */
  requireAgentsAreInTaskParticipants(
    id: TaskId,
    agentIds: ReadonlyArray<AgentId>,
  ): Effect.Effect<void, ParticipantNotAdmittedError> {
    if (agentIds.length === 0) return Effect.void;
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("task_participants")
          .select("agent_id")
          .where("task_id", "=", id)
          .where("agent_id", "in", [...agentIds]);
        const present = new Set<AgentId>(rows.map((row) => row.agent_id));
        for (const agentId of agentIds) {
          if (!present.has(agentId)) {
            return yield* Effect.fail(
              new ParticipantNotAdmittedError({
                message: `Agent ${agentId} is not admitted to task ${id}`,
              }),
            );
          }
        }
      }).pipe(
        Effect.withSpan("taskService.requireAgentsAreInTaskParticipants"),
      ),
    );
  }

  /**
   * Spec D1 (#598) — participant-set dedup for `task/create` under the
   * server-bundled DEFAULT_APP. Returns the extant task whose
   * `task_participants` set is exactly `{creator} ∪ invitedAgentIds`
   * for the given `appId`, or `null` if no match exists.
   *
   * Sibling to `conversationService.existingDmForCreate`. NOT a
   * generalization: the legacy DM dedup matches via
   * `conversation_participants` (conversation-level), while this
   * helper matches via `task_participants` (task-level). The
   * single-invitee case is functionally equivalent at the observable
   * layer but uses a different table — D3 retires the legacy path.
   *
   * Index: covered by the `task_participants` PRIMARY KEY
   * `(task_id, agent_id)`.
   * @internal
   */
  findExistingTaskByParticipants(
    creator: AgentId,
    invitedAgentIds: ReadonlyArray<AgentId>,
    appId: string,
  ): Effect.Effect<Task | null, never> {
    const fullParticipantSet = new Set<AgentId>([creator, ...invitedAgentIds]);
    return catchSqlErrorAsDefect(
      this.scanExistingTaskByParticipants(creator, appId, fullParticipantSet),
    );
  }

  private scanExistingTaskByParticipants(
    creator: AgentId,
    appId: string,
    fullParticipantSet: ReadonlySet<AgentId>,
  ): Effect.Effect<Task | null, SqlError> {
    return Effect.gen(this, function* () {
      const candidateIds = yield* this.candidateTaskIds(creator, appId);
      for (const taskId of candidateIds) {
        const match = yield* this.taskMatchesParticipantSet(
          taskId,
          fullParticipantSet,
        );
        if (match !== null) return match;
      }
      return null;
    }).pipe(Effect.withSpan("taskService.findExistingTaskByParticipants"));
  }

  private candidateTaskIds(
    creator: AgentId,
    appId: string,
  ): Effect.Effect<ReadonlyArray<TaskId>, SqlError> {
    return this.db
      .selectFrom("tasks")
      .innerJoin("task_participants", "task_participants.task_id", "tasks.id")
      .where("tasks.app_id", "=", appId)
      .where("task_participants.agent_id", "=", creator)
      .select("tasks.id")
      .distinct()
      .pipe(Effect.map((rows) => rows.map((row) => row.id)));
  }

  private taskMatchesParticipantSet(
    taskId: TaskId,
    fullParticipantSet: ReadonlySet<AgentId>,
  ): Effect.Effect<Task | null, SqlError> {
    return Effect.gen(this, function* () {
      const participantRows = yield* this.db
        .selectFrom("task_participants")
        .select("agent_id")
        .where("task_id", "=", taskId);
      if (participantRows.length !== fullParticipantSet.size) return null;
      const candidateSet = new Set<AgentId>(
        participantRows.map((row) => row.agent_id),
      );
      for (const agentId of fullParticipantSet) {
        if (!candidateSet.has(agentId)) return null;
      }
      const taskRow = yield* takeFirstOption(
        this.db.selectFrom("tasks").selectAll().where("id", "=", taskId),
      );
      return Option.isNone(taskRow)
        ? null
        : rowToTask(taskRow.value as TaskRow);
    });
  }

  /**
   * Spec D1 (#598) — `task/leave` self-only handler body.
   *
   * Removes the caller from `task_participants` and from every
   * `conversation_participants` row under the task in one transaction.
   * Captures pre-mutation per-conversation membership so the leaver
   * still receives their own removal notification fan-out post-commit.
   * If removal empties `task_participants`, transitions the task to
   * `status = 'closed'` and returns the closed task row so the handler
   * can fan out `TaskClosedNotificationDefinition` alongside the
   * per-conversation notifications.
   *
   * Idempotent: returns `{ leftConversationIds: [], closedTask: null }`
   * when the caller is not in `task_participants` for the task.
   * Fails with `NotFoundError` when the task does not exist.
   * @internal
   */
  leaveTask(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<TaskLeaveResult, TaskServiceError> {
    return Effect.gen(this, function* () {
      // Existence probe outside the transaction so `not_found` surfaces
      // before any write attempt.
      yield* this.fetchTask(id);
      return yield* catchSqlErrorAsDefect(
        transaction(this.db, (trx) =>
          this.leaveTaskTransaction(trx, id, caller),
        ),
      );
    });
  }

  private leaveTaskTransaction(
    trx: TaskTransaction,
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<TaskLeaveResult, SqlError | Cause.NoSuchElementException> {
    return Effect.gen(this, function* () {
      // Row-level lock on the task BEFORE any participant read.
      // Without `FOR UPDATE`, two concurrent `leaveTask` callers can
      // each see the other under read-committed isolation, each skip
      // `maybeCloseEmptyTask`, and leave the task in a "0 participants
      // but not closed" state (codex review finding 3). The lock
      // serializes leaves per task; the second call sees the post-DELETE
      // state and either no-ops (if it was already deleted) or fires
      // the closure path correctly.
      yield* trx
        .selectFrom("tasks")
        .select("id")
        .where("id", "=", id)
        .forUpdate();
      const taskParticipantRows = yield* trx
        .selectFrom("task_participants")
        .select("agent_id")
        .where("task_id", "=", id)
        .where("agent_id", "=", caller);
      if (taskParticipantRows.length === 0) {
        return { leftConversationIds: [], closedTask: null };
      }
      const leftConversationIds = yield* this.deleteCallerFromConversations(
        trx,
        id,
        caller,
      );
      yield* trx
        .deleteFrom("task_participants")
        .where("task_id", "=", id)
        .where("agent_id", "=", caller);
      const closedTask = yield* this.maybeCloseEmptyTask(trx, id);
      return { leftConversationIds, closedTask };
    });
  }

  private deleteCallerFromConversations(
    trx: TaskTransaction,
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<ReadonlyArray<ConversationId>, SqlError> {
    return Effect.gen(function* () {
      const conversationRows = yield* trx
        .selectFrom("conversation_participants as cp")
        .innerJoin("conversations as c", "c.id", "cp.conversation_id")
        .select("cp.conversation_id")
        .where("c.task_id", "=", id)
        .where("cp.agent_id", "=", caller);
      const ids = conversationRows.map((row) => row.conversation_id);
      if (ids.length > 0) {
        yield* trx
          .deleteFrom("conversation_participants")
          .where("agent_id", "=", caller)
          .where("conversation_id", "in", [...ids]);
      }
      return ids;
    });
  }

  private maybeCloseEmptyTask(
    trx: TaskTransaction,
    id: TaskId,
  ): Effect.Effect<Task | null, SqlError | Cause.NoSuchElementException> {
    return Effect.gen(this, function* () {
      const remaining = yield* trx
        .selectFrom("task_participants")
        .select("agent_id")
        .where("task_id", "=", id)
        .limit(1);
      if (remaining.length > 0) return null;
      const closedRow = yield* takeFirstOrFail(
        trx
          .updateTable("tasks")
          .set({ status: "closed", ended_at: new Date() })
          .where("id", "=", id)
          .returningAll(),
      );
      return rowToTask(closedRow as TaskRow);
    });
  }

  /**
   * Spec D1 (#598) — `task/conversation/{archive,unarchive}` body for
   * the new TM-only handler.
   *
   * Returns the updated `Conversation` (with populated `archivedAt`)
   * so the handler can fan out the legacy `conversations/archived`
   * payload alongside the new `task/conversation/archived` payload
   * inside the dual-emit window. The caller's `TmAuthority` capability
   * is asserted by the handler's `provideServiceEffect` chain, so this
   * body assumes authority is already proven.
   *
   * `ConversationInTask` is required as an R-channel proof.
   * @internal
   */
  archiveTaskConversation(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<
    { conversation: Conversation; archivedAt: string },
    TaskServiceError,
    TmAuthority | ConversationInTask
  > {
    return Effect.gen(this, function* () {
      const tm = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(tm, id);
      const inTask = yield* ConversationInTask;
      yield* assertConversationInTaskMatches(inTask, id, conversationId);
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* () {
          const archivedAt = new Date();
          // Idempotent: if already archived, re-read to surface the
          // existing `archivedAt` rather than overwriting.
          const updatedOpt = yield* takeFirstOption(
            this.db
              .updateTable("conversations")
              .set({ archived_at: archivedAt })
              .where("id", "=", conversationId)
              .where("task_id", "=", id)
              .where("archived_at", "is", null)
              .returningAll(),
          );
          if (Option.isSome(updatedOpt)) {
            const conversation =
              yield* this.conversations.loadById(conversationId);
            return {
              conversation,
              archivedAt: archivedAt.toISOString(),
            };
          }
          const conversation =
            yield* this.conversations.loadById(conversationId);
          if (!conversation.archivedAt) {
            return yield* Effect.fail(
              new NotFoundError({
                message: "Conversation not found in task",
              }),
            );
          }
          return { conversation, archivedAt: conversation.archivedAt };
        }),
      );
    });
  }

  /**
   * Spec D1 (#598) — `task/conversation/unarchive` body. Idempotent
   * (no-op when the conversation is not archived). Returns the
   * updated `Conversation` (with `archivedAt` cleared).
   * @internal
   */
  unarchiveTaskConversation(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<
    { conversation: Conversation },
    TaskServiceError,
    TmAuthority | ConversationInTask
  > {
    return Effect.gen(this, function* () {
      const tm = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(tm, id);
      const inTask = yield* ConversationInTask;
      yield* assertConversationInTaskMatches(inTask, id, conversationId);
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* () {
          yield* this.db
            .updateTable("conversations")
            .set({ archived_at: null })
            .where("id", "=", conversationId)
            .where("task_id", "=", id);
          const conversation =
            yield* this.conversations.loadById(conversationId);
          return { conversation };
        }),
      );
    });
  }

  /**
   * Spec D1 (#598) — `task/conversation/participants/add` body.
   *
   * Inserts a new `conversation_participants` row (idempotent via
   * `ON CONFLICT DO NOTHING`) AND captures the post-mutation membership
   * so the handler can fan out the participants-added notifications.
   * The participant-admitted invariant (caller is in
   * `task_participants` for `taskId`) is enforced by
   * `requireAgentsAreInTaskParticipants` in the handler before this
   * call; the conversation-in-task relationship is enforced by the
   * `ConversationInTask` capability.
   * @internal
   */
  addTaskConversationParticipant(
    id: TaskId,
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<
    { postMutationParticipants: ReadonlyArray<AgentId> },
    TaskServiceError,
    TmAuthority | ConversationInTask
  > {
    return Effect.gen(this, function* () {
      const tm = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(tm, id);
      const inTask = yield* ConversationInTask;
      yield* assertConversationInTaskMatches(inTask, id, conversationId);
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* () {
          yield* this.db
            .insertInto("conversation_participants")
            .values({ conversation_id: conversationId, agent_id: agentId })
            .onConflict((oc) => oc.doNothing());
          const rows = yield* this.db
            .selectFrom("conversation_participants")
            .select("agent_id")
            .where("conversation_id", "=", conversationId);
          return {
            postMutationParticipants: rows.map(
              (row) => row.agent_id,
            ) as ReadonlyArray<AgentId>,
          };
        }),
      );
    });
  }

  /**
   * Spec D1 (#598) — `task/conversation/participants/remove` body.
   *
   * Returns the pre-mutation membership snapshot so the handler can
   * fan out the participants-removed notification to the removed
   * agent (who is no longer in `conversation_participants` post-DELETE).
   * Idempotent: no-op when the agent is not currently in the
   * conversation. The conversation is NOT auto-archived when its
   * `conversation_participants` becomes empty (spec body Goal 2 — left
   * in place; D3 may revisit).
   * @internal
   */
  removeTaskConversationParticipant(
    id: TaskId,
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<
    {
      preMutationParticipants: ReadonlyArray<AgentId>;
      wasParticipant: boolean;
    },
    TaskServiceError,
    TmAuthority | ConversationInTask
  > {
    return Effect.gen(this, function* () {
      const tm = yield* TmAuthority;
      yield* assertTmAuthorityMatchesTask(tm, id);
      const inTask = yield* ConversationInTask;
      yield* assertConversationInTaskMatches(inTask, id, conversationId);
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* () {
          const preRows = yield* this.db
            .selectFrom("conversation_participants")
            .select("agent_id")
            .where("conversation_id", "=", conversationId);
          const preMutationParticipants = preRows.map(
            (row) => row.agent_id,
          ) as ReadonlyArray<AgentId>;
          const wasParticipant = preMutationParticipants.includes(agentId);
          if (!wasParticipant) {
            return { preMutationParticipants, wasParticipant };
          }
          yield* this.db
            .deleteFrom("conversation_participants")
            .where("conversation_id", "=", conversationId)
            .where("agent_id", "=", agentId);
          return { preMutationParticipants, wasParticipant };
        }),
      );
    });
  }
}
