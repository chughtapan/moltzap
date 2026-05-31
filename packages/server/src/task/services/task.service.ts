import { Cause, Effect, Option } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import type {
  Conversation,
  ListCursor,
  Task,
  TaskParticipant,
  TaskStatus,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId, ConversationId } from "@moltzap/protocol/task";
import type { Db } from "../../db/client.js";
import type { Database } from "../../db/database.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "../../db/effect-kysely-toolkit.js";
import {
  decodeListCursor,
  keysetWhere,
  paginate,
  sortKeyExpr,
  type InvalidCursorError,
} from "../../db/list-cursor.js";
import type { Transaction } from "../../db/kysely-vendor.js";
import {
  DEFAULT_PAGE_LIMIT,
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
  ConversationInTask,
  TaskReadAccess,
  assertConversationInTaskMatches,
  assertTaskReadAccessMatchesTask,
} from "@moltzap/protocol/task";

/**
 * Package-scoped error union. Exported so the capability obtain helpers
 * (in `app/capability-providers.ts` and the composites in
 * `task/services/`) can declare matching error channels without
 * over-narrowing.
 * @internal
 */
export type TaskServiceError =
  | ForbiddenError
  | NotFoundError
  | ParticipantNotAdmittedError
  | ConversationServiceError
  | MessageServiceError;

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

export interface TaskCreateInput {
  readonly appId: string;
  readonly invitedAgentIds?: readonly AgentId[];
}

export interface TaskListInput {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TaskListPage {
  readonly tasks: readonly Task[];
  readonly nextCursor?: ListCursor;
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
 * Return shape of `TaskService.leaveTask`. The handler fans out one
 * removal notification per `leftConversationIds`, plus
 * `TaskClosedNotificationDefinition` when `closedTask` is non-null.
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
          return rowToTask(row as TaskRow);
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
   * `task/created { task }` or `task/failed { taskId, reason }`
   * without a second SELECT.
   */
  setStatus(
    id: TaskId,
    status: "active" | "failed",
  ): Effect.Effect<Task, TaskServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const row = yield* takeFirstOrFail(
          this.db
            .updateTable("tasks")
            .set({ status })
            .where("id", "=", id)
            .where("status", "=", "waiting")
            .returningAll(),
        );
        return rowToTask(row as TaskRow);
      }),
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
  ): Effect.Effect<TaskListPage, InvalidCursorError> {
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    return Effect.gen(this, function* () {
      const pos =
        input.cursor === undefined
          ? undefined
          : yield* decodeListCursor(input.cursor);
      return yield* catchSqlErrorAsDefect(
        Effect.gen(this, function* () {
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
            rows as readonly TaskRow[],
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

  close(id: TaskId): Effect.Effect<Task, TaskServiceError> {
    return this.closeWithLifecycle(id).pipe(
      Effect.map((closed) => closed.task),
    );
  }

  closeWithLifecycle(
    id: TaskId,
  ): Effect.Effect<TaskCloseLifecycle, TaskServiceError> {
    // App-ownership (`assertAppOwnsTask`) is enforced by the app-arm
    // handler before this call; this body assumes authority is proven.
    return catchSqlErrorAsDefect(
      transaction(this.db, (trx) => this.closeLifecycleTransaction(trx, id)),
    );
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
   * Fetch a task and assert it is open for mutation
   * (`waiting | active`). Closed / failed tasks fail with
   * `ForbiddenError`. Authority is the obtain helper's
   * responsibility: this body performs no auth check, only the
   * existence + status gate.
   */
  loadOpenTask(id: TaskId): Effect.Effect<Task, TaskServiceError> {
    return Effect.gen(this, function* () {
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
    target: AgentId,
  ): Effect.Effect<TaskParticipant, TaskServiceError> {
    // App-ownership asserted by the handler before this call.
    return Effect.gen(this, function* () {
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
    target: AgentId,
  ): Effect.Effect<void, TaskServiceError> {
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
   * Relationship check consumed by `obtainConversationInTask`.
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
   * Helper consumed by `obtainAgentInTaskParticipants`. Fails closed
   * with `ForbiddenError` when the agent is absent or pending
   * (`admitted_at IS NULL`).
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

  /**
   * Participant-membership check for the `task/conversation/*` admin
   * handlers. The invariant is "agent has a row in
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
   * Participant-set dedup for `task/create` under the bundled
   * DEFAULT_APP. Returns the extant task whose `task_participants`
   * set is exactly `{creator} ∪ invitedAgentIds` for the given
   * `appId`, or `null` if no match exists.
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
    // Closed tasks are excluded so a fresh `task/create` after a close
    // mints a new task instead of returning the dead one.
    return this.db
      .selectFrom("tasks")
      .innerJoin("task_participants", "task_participants.task_id", "tasks.id")
      .where("tasks.app_id", "=", appId)
      .where("task_participants.agent_id", "=", creator)
      .where("tasks.status", "!=", "closed")
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
      // but not closed" state. The lock serializes leaves per task; the
      // second call sees the post-DELETE state and either no-ops (if it
      // was already deleted) or fires the closure path correctly.
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
   * `task/conversation/archive` body.
   *
   * Returns the updated `Conversation` (with populated `archivedAt`)
   * so the handler can fan out the `task/conversation/archived`
   * notification. App-ownership (`assertAppOwnsTask`) is asserted by the
   * app-arm handler before this call, so this body assumes authority is
   * proven. `ConversationInTask` is required as an R-channel proof.
   * @internal
   */
  archiveTaskConversation(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<
    { conversation: Conversation; archivedAt: string },
    TaskServiceError,
    ConversationInTask
  > {
    return Effect.gen(this, function* () {
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
   * `task/conversation/unarchive` body. Idempotent (no-op when the
   * conversation is not archived). Returns the updated `Conversation`
   * (with `archivedAt` cleared).
   * @internal
   */
  unarchiveTaskConversation(
    id: TaskId,
    conversationId: ConversationId,
  ): Effect.Effect<
    { conversation: Conversation },
    TaskServiceError,
    ConversationInTask
  > {
    return Effect.gen(this, function* () {
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
   * `task/conversation/participants/add` body.
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
    ConversationInTask
  > {
    return Effect.gen(this, function* () {
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
   * `task/conversation/participants/remove` body.
   *
   * Returns the pre-mutation membership snapshot so the handler can
   * fan out the participants-removed notification to the removed
   * agent (who is no longer in `conversation_participants` post-DELETE).
   * Idempotent: no-op when the agent is not currently in the
   * conversation. The conversation is NOT auto-archived when its
   * `conversation_participants` becomes empty.
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
    ConversationInTask
  > {
    return Effect.gen(this, function* () {
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
