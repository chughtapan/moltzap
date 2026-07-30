import { type Cause, Effect, Option } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import type { AppId, AgentId } from "@moltzap/protocol/identity";
import {
  type Task,
  type TaskParticipant,
  type TaskStatus,
  type TaskId,
  TaskNotFoundError,
} from "@moltzap/protocol/task";
import {
  type Conversation,
  type ConversationId,
  ConversationNotFoundError,
  ParticipantNotAdmittedError,
} from "@moltzap/protocol/conversation";
import {
  type ListCursor,
  DEFAULT_PAGE_LIMIT,
  ForbiddenError,
} from "@moltzap/protocol/rpc";
import {
  type Db,
  type Database,
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
  decodeListCursor,
  keysetWhere,
  paginate,
  sortKeyExpr,
  type InvalidCursorError,
  type Transaction,
} from "#db";
import type { ConversationService } from "#conversation";
import type { MessageService } from "#message";
const ERR_NOT_FOUND = "Task not found";
const ERR_NOT_PARTICIPANT = "Caller is not a participant of this task";
const ERR_CONV_NOT_IN_TASK =
  "Conversation does not belong to the specified task";
const ERR_TASK_NOT_OPEN = "Task is not open for mutation";

function absurdTaskStatus(status: never): never {
  throw new Error(`unreachable task status: ${JSON.stringify(status)}`);
}

interface TaskRow {
  readonly id: TaskId;
  readonly app_id: string;
  readonly initiator_agent_id: AgentId;
  readonly status: TaskStatus;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly created_at: Date;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    appId: row.app_id,
    initiatorAgentId: row.initiator_agent_id,
    status: row.status,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function positionOfTaskRow(row: TaskRow): {
  readonly sortKey: string;
  readonly id: string;
} {
  return { sortKey: row.created_at.toISOString(), id: row.id };
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

interface TaskCreateInput {
  readonly appId: AppId;
  readonly invitedAgentIds?: readonly AgentId[];
}

interface TaskListInput {
  readonly limit?: number;
  readonly cursor?: string;
}

interface TaskListPage {
  readonly tasks: readonly Task[];
  readonly nextCursor?: ListCursor;
}

interface TaskCloseLifecycle {
  readonly task: Task;
  readonly participantAgentIds: readonly AgentId[];
  readonly archivedConversations: ReadonlyArray<{
    readonly conversationId: ConversationId;
    readonly archivedAt: string;
    readonly participantAgentIds: readonly AgentId[];
  }>;
}

/**
 * Return shape of `TaskService.leaveTask`. The handler fans out one
 * removal notification per `leftConversationIds`, plus
 * `TaskClosedNotificationDefinition` when `closedTask` is non-null.
 */
interface TaskLeaveResult {
  readonly leftConversationIds: readonly ConversationId[];
  readonly closedTask: Task | null;
}

type TaskTransaction = Transaction<Database>;
interface ArchivedConversationRow {
  readonly id: ConversationId;
  readonly archived_at: Date | null;
}
interface ConversationParticipantRow {
  readonly conversation_id: ConversationId;
  readonly agent_id: AgentId;
}
interface AgentIdRow {
  readonly agent_id: AgentId;
}

function conversationIdsFromRows(
  rows: readonly ArchivedConversationRow[],
): ConversationId[] {
  const ids: ConversationId[] = [];
  for (const row of rows) {
    ids.push(row.id);
  }
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
  for (const row of rows) {
    agentIds.push(row.agent_id);
  }
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
      archivedAt:
        /* Safe because the surrounding invariant establishes this asserted shape. */ row.archived_at!.toISOString(),
      participantAgentIds: participantsByConversation.get(row.id) ?? [],
    });
  }
  return archivedConversations;
}

/** Implements task service. */
export class TaskService {
  private readonly db: Db;
  private readonly conversations: ConversationService;
  private readonly messages: MessageService;

  constructor(
    db: Db,
    conversations: ConversationService,
    messages: MessageService,
  ) {
    this.db = db;
    this.conversations = conversations;
    this.messages = messages;
  }

  create(initiator: AgentId, input: TaskCreateInput): Effect.Effect<Task> {
    return catchSqlErrorAsDefect(
      transaction(this.db, (trx) =>
        Effect.gen(function* () {
          const row = yield* takeFirstOrFail(
            trx
              .insertInto("tasks")
              .values({
                app_id: input.appId,
                initiator_agent_id: initiator,
                status: "waiting",
              })
              .returningAll(),
          );
          // Auto-admit every invited participant at create time. Read
          // paths (`loadTaskWithReadAccess`,
          // `assertAgentInTaskParticipants`, task list scope) gate on
          // `WHERE admitted_at IS NOT NULL`, so a row written with
          // `admitted_at: null` is a pending invite that grants no read
          // access until admitted.
          const admittedAt = new Date();
          yield* trx.insertInto("task_participants").values({
            task_id: row.id,
            agent_id: initiator,
            admitted_at: admittedAt,
          });
          const invited = input.invitedAgentIds ?? [];
          for (const agentId of invited) {
            yield* trx
              .insertInto("task_participants")
              .values({
                task_id: row.id,
                agent_id: agentId,
                admitted_at: admittedAt,
              })
              .onConflict((oc) => oc.doNothing());
          }
          return rowToTask(row);
        }),
      ),
    );
  }

  /**
   * Transition a task from `waiting` to `active` or `failed`. The state
   * machine is `waiting → active | failed`, one-way.
   *
   * The `WHERE status = 'waiting'` guard SQL-enforces the one-way
   * invariant: an UPDATE against an already-transitioned task matches
   * zero rows and `takeFirstOrFail` raises (caught as a defect),
   * rather than silently re-writing a terminal `active`/`failed`/
   * `closed` row. The single guarded UPDATE also means a racing read
   * never observes a stale `waiting` row after the verdict resolves.
   *
   * Returns the updated row so the handler can fan out
   * `agent/task/created { task }` or `task/failed { taskId, reason }`
   * without a second SELECT.
   * @param id Value supplied to the operation.
   * @param status Value supplied to the operation.
   * @returns The row result.
   */
  setStatus(id: TaskId, status: "active" | "failed"): Effect.Effect<Task> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: TaskService) {
        const row = yield* takeFirstOrFail(
          this.db
            .updateTable("tasks")
            .set({ status })
            .where("id", "=", id)
            .where("status", "=", "waiting")
            .returningAll(),
        );
        return rowToTask(row);
      }),
    );
  }

  get(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<
    { task: Task; participants: TaskParticipant[] },
    TaskNotFoundError | ForbiddenError
  > {
    return Effect.gen(this, function* (this: TaskService) {
      const task = yield* this.loadTaskWithReadAccess(id, caller);
      const rows = yield* catchSqlErrorAsDefect(
        this.db
          .selectFrom("task_participants")
          .selectAll()
          .where("task_id", "=", id),
      );
      return {
        task,
        participants: rows.map(rowToParticipant),
      };
    });
  }

  list(
    caller: AgentId,
    input: TaskListInput,
  ): Effect.Effect<TaskListPage, InvalidCursorError> {
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    return Effect.gen(this, function* (this: TaskService) {
      const pos =
        input.cursor === undefined
          ? undefined
          : yield* decodeListCursor(input.cursor);
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* (this: TaskService) {
          let query = this.db
            .selectFrom("tasks")
            .innerJoin(
              "task_participants",
              "task_participants.task_id",
              "tasks.id",
            )
            .where("task_participants.agent_id", "=", caller);
          if (pos !== undefined) {
            query = query.where((eb) =>
              keysetWhere(
                eb,
                {
                  sortKey: sortKeyExpr(eb, "tasks.created_at"),
                  id: "tasks.id",
                },
                pos,
              ),
            );
          }
          const rows = yield* query
            .selectAll("tasks")
            .orderBy((eb) => sortKeyExpr(eb, "tasks.created_at"), "desc")
            .orderBy("tasks.id", "asc")
            .limit(limit + 1);
          const { page, nextCursor } = paginate(
            /* Safe because the surrounding invariant establishes this asserted shape. */ rows as readonly TaskRow[],
            limit,
            positionOfTaskRow,
          );
          return {
            tasks: page.map(rowToTask),
            ...(nextCursor !== undefined ? { nextCursor } : {}),
          };
        }),
      );
    });
  }

  close(id: TaskId): Effect.Effect<Task> {
    return this.closeWithLifecycle(id).pipe(
      Effect.map((closed) => closed.task),
    );
  }

  closeWithLifecycle(id: TaskId): Effect.Effect<TaskCloseLifecycle> {
    // App-ownership (`assertAppOwnsTask`) is enforced by the app-arm
    // handler before this call; this body assumes authority is proven.
    return catchSqlErrorAsDefect(
      transaction(this.db, (trx) => this.closeLifecycleTransaction(trx, id)),
    );
  }

  private closeLifecycleTransaction(trx: TaskTransaction, id: TaskId) {
    return Effect.gen(this, function* (this: TaskService) {
      const closedAt = new Date();
      const taskRow = yield* this.closeTaskRow(trx, id, closedAt);
      const archivedRows = yield* this.archiveOpenConversations(
        trx,
        id,
        closedAt,
      );
      const conversationIds = conversationIdsFromRows(archivedRows);
      const participantsByConversation =
        yield* this.readConversationParticipantMap(trx, conversationIds);
      return {
        task: rowToTask(taskRow),
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

  private archiveOpenConversations(
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
   * Fetch a task and assert it is open for mutation
   * (`waiting | active`). Closed / failed tasks fail with
   * `ForbiddenError`. Authority is the obtain helper's
   * responsibility: this body performs no auth check, only the
   * existence + status gate.
   * @param id Value supplied to the operation.
   * @returns The task result.
   */
  loadOpenTask(
    id: TaskId,
  ): Effect.Effect<Task, TaskNotFoundError | ForbiddenError> {
    return Effect.gen(this, function* (this: TaskService) {
      const task = yield* this.fetchTask(id);
      switch (task.status) {
        case "waiting":
        case "active":
          return task;
        case "closed":
        case "failed":
          return yield* Effect.fail(
            new ForbiddenError({ message: ERR_TASK_NOT_OPEN }),
          );
        default:
          return absurdTaskStatus(task.status);
      }
    });
  }

  loadTaskWithReadAccess(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<Task, TaskNotFoundError | ForbiddenError> {
    return Effect.gen(this, function* (this: TaskService) {
      const task = yield* this.fetchTask(id);
      if (task.initiatorAgentId === caller) {
        return task;
      }
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

  addParticipant(id: TaskId, target: AgentId): Effect.Effect<TaskParticipant> {
    // App-ownership asserted by the handler before this call.
    return Effect.gen(this, function* (this: TaskService) {
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

  removeParticipant(id: TaskId, target: AgentId): Effect.Effect<void> {
    // App-ownership asserted by the handler before this call.
    return catchSqlErrorAsDefect(
      this.db
        .deleteFrom("task_participants")
        .where("task_id", "=", id)
        .where("agent_id", "=", target),
    );
  }

  /**
   * Fetch helper consumed by `obtainMessageSendPermission` to populate
   * the composite `MessageSendPermission.task` payload field.
   * @param id Value supplied to the operation.
   * @internal
   * @returns The opt result.
   */
  fetchTask(id: TaskId): Effect.Effect<Task, TaskNotFoundError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: TaskService) {
        const opt = yield* takeFirstOption(
          this.db.selectFrom("tasks").selectAll().where("id", "=", id),
        );
        if (Option.isNone(opt)) {
          return yield* Effect.fail(
            new TaskNotFoundError({ message: ERR_NOT_FOUND }),
          );
        }
        return rowToTask(opt.value);
      }),
    );
  }

  /**
   * Relationship check consumed by `obtainConversationInTask`.
   * @param id Value supplied to the operation.
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The linked opt result.
   */
  assertConversationInTask(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<void, ConversationNotFoundError | ForbiddenError> {
    return Effect.gen(this, function* (this: TaskService) {
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
          new ConversationNotFoundError({ message: "Conversation not found" }),
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
   * Helper consumed by `obtainAgentInTaskParticipants`. Fails closed
   * with `ForbiddenError` when the agent is absent or pending
   * (`admitted_at IS NULL`).
   * @param id Value supplied to the operation.
   * @param agentId Identifier of the agent targeted by the operation.
   * @internal
   * @returns The row opt result.
   */
  assertAgentInTaskParticipants(
    id: TaskId,
    agentId: AgentId,
  ): Effect.Effect<void, ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: TaskService) {
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

  /**
   * Participant-membership check for app conversation mutation handlers. The
   * invariant is "agent has a row in
   * `task_participants(task_id, agent_id)`"; admission state is a
   * separate gate (a row with `admitted_at IS NULL` still passes). The
   * stricter "admitted only" check used by message-send authority is
   * `assertAgentInTaskParticipants`.
   *
   * Fails closed with `ParticipantNotAdmittedError` on the first agent
   * missing from `task_participants` so clients can distinguish
   * "invalid agent id shape" (`InvalidParamsError`) from "agent exists
   * but is not admitted to this task" (this tag) without parsing
   * messages. `SqlError` is caught defectively.
   * @param id Value supplied to the operation.
   * @param agentIds Value supplied to the operation.
   * @internal
   * @returns The rows result.
   */
  requireAgentsAreInTaskParticipants(
    id: TaskId,
    agentIds: readonly AgentId[],
  ): Effect.Effect<void, ParticipantNotAdmittedError> {
    if (agentIds.length === 0) {
      return Effect.void;
    }
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: TaskService) {
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
   * `task/leave` self-only handler body.
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
   * Fails with `TaskNotFoundError` when the task does not exist.
   * @param id Value supplied to the operation.
   * @param caller Value supplied to the operation.
   * @internal
   * @returns The leave task result.
   */
  leaveTask(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<TaskLeaveResult, TaskNotFoundError> {
    return Effect.gen(this, function* (this: TaskService) {
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
    return Effect.gen(this, function* (this: TaskService) {
      // Row-level lock on the task BEFORE any participant read.
      // Without `FOR UPDATE`, two concurrent `leaveTask` callers can
      // each see the other under read-committed isolation, each skip
      // `maybeCloseEmptyTask`, and leave the task in a "0 participants
      // but not closed" state. The lock serializes leaves per task; the
      // second call sees the post-DELETE state and either no-ops or fires the
      // closure path correctly.
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
  ): Effect.Effect<readonly ConversationId[], SqlError> {
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
    return Effect.gen(this, function* (this: TaskService) {
      const remaining = yield* trx
        .selectFrom("task_participants")
        .select("agent_id")
        .where("task_id", "=", id)
        .limit(1);
      if (remaining.length > 0) {
        return null;
      }
      const closedRow = yield* takeFirstOrFail(
        trx
          .updateTable("tasks")
          .set({ status: "closed", ended_at: new Date() })
          .where("id", "=", id)
          .returningAll(),
      );
      return rowToTask(closedRow);
    });
  }

  /**
   * `app/conversation/update` body.
   *
   * Returns the updated `Conversation` (with populated `archivedAt`)
   * so the handler can fan out the archive notification. App-ownership
   * (`assertAppOwnsTask`) is asserted by the
   * app-arm handler before this call, so this body assumes authority is
   * proven. `ConversationInTask` is enforced by requirement middleware.
   * @param id Value supplied to the operation.
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The archived at result.
   */
  archiveConversation(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<
    { conversation: Conversation; archivedAt: string },
    ConversationNotFoundError | ForbiddenError
  > {
    return Effect.gen(this, function* (this: TaskService) {
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* (this: TaskService) {
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
              new ConversationNotFoundError({
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
   * `app/conversation/update` body. Idempotent (no-op when the
   * conversation is not archived). Returns the updated `Conversation`
   * (with `archivedAt` cleared).
   * @param id Value supplied to the operation.
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The conversation result.
   */
  unarchiveConversation(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<
    { conversation: Conversation },
    ConversationNotFoundError | ForbiddenError
  > {
    return Effect.gen(this, function* (this: TaskService) {
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* (this: TaskService) {
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
   * `app/conversation/update` body.
   *
   * Inserts a new `conversation_participants` row (idempotent via
   * `ON CONFLICT DO NOTHING`) AND captures the post-mutation membership
   * so the handler can fan out the participants-added notifications.
   * The participant-admitted invariant (caller is in
   * `task_participants` for `taskId`) is enforced by
   * `requireAgentsAreInTaskParticipants` in the handler before this
   * call; the conversation-in-task relationship is enforced by the
   * `ConversationInTask` requirement.
   * @param conversationId Value supplied to the operation.
   * @param agentId Identifier of the agent targeted by the operation.
   * @internal
   * @returns The rows result.
   */
  addConversationParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<
    { postMutationParticipants: readonly AgentId[] },
    ForbiddenError
  > {
    return Effect.gen(this, function* (this: TaskService) {
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* (this: TaskService) {
          yield* this.db
            .insertInto("conversation_participants")
            .values({ conversation_id: conversationId, agent_id: agentId })
            .onConflict((oc) => oc.doNothing());
          const rows = yield* this.db
            .selectFrom("conversation_participants")
            .select("agent_id")
            .where("conversation_id", "=", conversationId);
          return {
            postMutationParticipants: rows.map((row) => row.agent_id),
          };
        }),
      );
    });
  }

  /**
   * `app/conversation/update` body.
   *
   * Returns the pre-mutation membership snapshot so the handler can
   * fan out the participants-removed notification to the removed
   * agent after their `conversation_participants` row is deleted.
   * Idempotent: no-op when the agent is not currently in the
   * conversation. The conversation is NOT auto-archived when its
   * `conversation_participants` becomes empty.
   * @param conversationId Value supplied to the operation.
   * @param agentId Identifier of the agent targeted by the operation.
   * @internal
   * @returns The pre rows result.
   */
  removeConversationParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<
    {
      preMutationParticipants: readonly AgentId[];
      wasParticipant: boolean;
    },
    ForbiddenError
  > {
    return Effect.gen(this, function* (this: TaskService) {
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* (this: TaskService) {
          const preRows = yield* this.db
            .selectFrom("conversation_participants")
            .select("agent_id")
            .where("conversation_id", "=", conversationId);
          const preMutationParticipants =
            /* Safe because the surrounding invariant establishes this asserted shape. */ preRows.map(
              (row) => row.agent_id,
            ) as readonly AgentId[];
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
