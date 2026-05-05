import { Effect, Either, Option } from "effect";
import {
  endpointAddress as brandEndpointAddress,
  type EndpointAddress,
  type AgentId as ActorAgentId,
} from "@moltzap/protocol/network";
import {
  agentId as makeAgentId,
  taskId as makeTaskId,
  type Static,
  type Conversation,
  type Message,
  type Part,
  type Task,
  type TaskParticipant,
  type TaskStatus,
} from "@moltzap/protocol";
import { TaskId, AgentId } from "@moltzap/protocol/schemas/primitives";
import type { Db } from "../db/client.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "../db/effect-kysely-toolkit.js";
import { forbidden, notFound, type RpcFailure } from "../runtime/index.js";
import type { ConversationService } from "./conversation.service.js";
import type { MessageService } from "./message.service.js";

type BrandedTaskId = Static<typeof TaskId>;
type BrandedAgentId = Static<typeof AgentId>;

const ERR_NOT_FOUND = "Task not found";
const ERR_NO_TM = "No task manager registered for task";
const ERR_NOT_TM = "Caller is not the registered task manager for this task";
const ERR_NOT_PARTICIPANT = "Caller is not a participant of this task";
const ERR_TM_OWNED_BY_OTHER =
  "Task already has a different task manager registered";
const ERR_CONV_NOT_IN_TASK =
  "Conversation does not belong to the specified task";
const ERR_TASK_NOT_OPEN = "Task is not open for mutation";

const DEFAULT_TASK_LIST_LIMIT = 50;
const DEFAULT_TASK_MESSAGES_LIMIT = 50;

interface TaskRow {
  readonly id: string;
  readonly app_id: string | null;
  readonly initiator_agent_id: string;
  readonly status: TaskStatus;
  readonly tm_endpoint_address: string | null;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly created_at: Date;
}

const TM_AGENT_PREFIX = "tm:agent:";

export function endpointAddressForAgent(
  agent: ActorAgentId | BrandedAgentId,
): EndpointAddress {
  return brandEndpointAddress(`${TM_AGENT_PREFIX}${agent}`);
}

function rowToTask(row: TaskRow): Task {
  return {
    id: makeTaskId(row.id),
    appId: row.app_id,
    initiatorAgentId: makeAgentId(row.initiator_agent_id),
    status: row.status,
    tmEndpointAddress: row.tm_endpoint_address,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function rowToParticipant(row: {
  readonly task_id: string;
  readonly agent_id: string;
  readonly admitted_at: Date | null;
}): TaskParticipant {
  return {
    taskId: makeTaskId(row.task_id),
    agentId: makeAgentId(row.agent_id),
    admittedAt: row.admitted_at ? row.admitted_at.toISOString() : null,
  };
}

export interface TaskCreateInput {
  readonly appId?: string;
  readonly invitedAgentIds?: readonly BrandedAgentId[];
}

export interface TaskListInput {
  readonly appId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export interface TaskMessagesInput {
  readonly limit?: number;
}

export interface TaskMessagesSinceInput {
  readonly sinceSeq: string;
  readonly limit?: number;
}

export interface RegisterTmResult {
  readonly taskId: BrandedTaskId;
  readonly tmEndpointAddress: EndpointAddress;
}

export interface CreateConversationInput {
  readonly type: "dm" | "group";
  readonly name?: string;
  readonly participantAgentIds: readonly BrandedAgentId[];
}

export interface StoreMessageInput {
  readonly conversationId: string;
  readonly senderAgentId: BrandedAgentId;
  readonly parts: readonly Part[];
  readonly replyToId?: string;
}

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
  ) {}

  create(
    initiator: BrandedAgentId,
    input: TaskCreateInput,
  ): Effect.Effect<Task, RpcFailure> {
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
    id: BrandedTaskId,
    caller: BrandedAgentId,
  ): Effect.Effect<
    { task: Task; participants: TaskParticipant[] },
    RpcFailure
  > {
    return Effect.gen(this, function* () {
      const task = yield* this.requireReadAccess(id, caller);
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
    caller: BrandedAgentId,
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
    id: BrandedTaskId,
    caller: BrandedAgentId,
  ): Effect.Effect<Task, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireTmAuthority(id, caller);
      const row = yield* catchSqlErrorAsDefect(
        takeFirstOrFail(
          this.db
            .updateTable("tasks")
            .set({ status: "closed", ended_at: new Date() })
            .where("id", "=", id)
            .returningAll(),
        ),
      );
      return rowToTask(row as TaskRow);
    });
  }

  registerTm(
    id: BrandedTaskId,
    caller: BrandedAgentId,
  ): Effect.Effect<RegisterTmResult, RpcFailure> {
    return Effect.gen(this, function* () {
      const task = yield* this.fetchTask(id);
      if (task.initiatorAgentId !== caller) {
        return yield* Effect.fail(
          forbidden("Only the task initiator may register a task manager"),
        );
      }
      const expected = endpointAddressForAgent(caller);
      // Atomic claim: only succeeds if the column is currently null (first
      // registration) or already equals `expected` (idempotent re-register).
      // Closes the read-then-update race.
      const updated = yield* catchSqlErrorAsDefect(
        this.db
          .updateTable("tasks")
          .set({ tm_endpoint_address: expected })
          .where("id", "=", id)
          .where((eb) =>
            eb.or([
              eb("tm_endpoint_address", "is", null),
              eb("tm_endpoint_address", "=", expected),
            ]),
          )
          .returning("id"),
      );
      if (updated.length === 0) {
        return yield* Effect.fail(forbidden(ERR_TM_OWNED_BY_OTHER));
      }
      return { taskId: id, tmEndpointAddress: expected };
    });
  }

  unregisterTm(
    id: BrandedTaskId,
    caller: BrandedAgentId,
  ): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireTmAuthority(id, caller);
      yield* catchSqlErrorAsDefect(
        this.db
          .updateTable("tasks")
          .set({ tm_endpoint_address: null })
          .where("id", "=", id),
      );
    });
  }

  // Decode `tm_endpoint_address` (raw `string | null` from Kysely codegen)
  // through the `EndpointAddress` brand BEFORE comparing.
  requireTmAuthority(
    id: BrandedTaskId,
    caller: BrandedAgentId,
  ): Effect.Effect<Task, RpcFailure> {
    return Effect.gen(this, function* () {
      const task = yield* this.fetchTask(id);
      if (task.status === "closed" || task.status === "failed") {
        return yield* Effect.fail(forbidden(ERR_TASK_NOT_OPEN));
      }
      if (task.tmEndpointAddress === null) {
        return yield* Effect.fail(forbidden(ERR_NO_TM));
      }
      const recorded = brandEndpointAddress(task.tmEndpointAddress);
      const expected = endpointAddressForAgent(caller);
      if (recorded !== expected) {
        return yield* Effect.fail(forbidden(ERR_NOT_TM));
      }
      return task;
    });
  }

  requireReadAccess(
    id: BrandedTaskId,
    caller: BrandedAgentId,
  ): Effect.Effect<Task, RpcFailure> {
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
        return yield* Effect.fail(forbidden(ERR_NOT_PARTICIPANT));
      }
      return task;
    });
  }

  addParticipant(
    id: BrandedTaskId,
    caller: BrandedAgentId,
    target: BrandedAgentId,
  ): Effect.Effect<TaskParticipant, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireTmAuthority(id, caller);
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
    id: BrandedTaskId,
    caller: BrandedAgentId,
    target: BrandedAgentId,
  ): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireTmAuthority(id, caller);
      yield* catchSqlErrorAsDefect(
        this.db
          .deleteFrom("task_participants")
          .where("task_id", "=", id)
          .where("agent_id", "=", target),
      );
    });
  }

  createConversation(
    id: BrandedTaskId,
    caller: BrandedAgentId,
    input: CreateConversationInput,
  ): Effect.Effect<Conversation, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireTmAuthority(id, caller);
      // ConversationService.create wraps its own transaction; we follow
      // the stamp UPDATE in the same Effect so a failure in either
      // surfaces a typed RpcFailure. A crash between the two leaves an
      // unstamped conversation that `requireConversationInTask` rejects
      // (fail-closed): the row exists but `task_id` is NULL, so any
      // tasks/* mutation against it gets ERR_CONV_NOT_IN_TASK.
      const conversation = yield* this.conversations.create(
        input.type,
        input.name,
        [...input.participantAgentIds],
        caller,
      );
      yield* catchSqlErrorAsDefect(
        this.db
          .updateTable("conversations")
          .set({ task_id: id })
          .where("id", "=", conversation.id),
      );
      return conversation;
    });
  }

  closeConversation(
    id: BrandedTaskId,
    caller: BrandedAgentId,
    conversationId: string,
  ): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireTmAuthority(id, caller);
      yield* this.archiveConversationInTask(id, conversationId);
    });
  }

  storeMessage(
    id: BrandedTaskId,
    caller: BrandedAgentId,
    input: StoreMessageInput,
  ): Effect.Effect<Message, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireTmAuthority(id, caller);
      yield* this.requireConversationInTask(id, input.conversationId);
      const message = yield* this.messages.send(
        input.conversationId,
        [...input.parts],
        input.senderAgentId,
        input.replyToId,
      );
      // Stamp the message's task_id so cross-task queries (Phase 6
      // `tasks/getMessages`, future TM-routed reads) can scope by the
      // denormalized FK without joining through `conversations`.
      yield* catchSqlErrorAsDefect(
        this.db
          .updateTable("messages")
          .set({ task_id: id })
          .where("id", "=", message.id),
      );
      return message;
    });
  }

  getMessages(
    id: BrandedTaskId,
    caller: BrandedAgentId,
    input: TaskMessagesInput,
  ): Effect.Effect<{ messages: Message[]; hasMore: boolean }, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireReadAccess(id, caller);
      const limit = input.limit ?? DEFAULT_TASK_MESSAGES_LIMIT;
      return yield* this.fetchTaskMessages(id, caller, { limit });
    });
  }

  getMessagesSince(
    id: BrandedTaskId,
    caller: BrandedAgentId,
    input: TaskMessagesSinceInput,
  ): Effect.Effect<{ messages: Message[]; hasMore: boolean }, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireReadAccess(id, caller);
      const limit = input.limit ?? DEFAULT_TASK_MESSAGES_LIMIT;
      return yield* this.fetchTaskMessages(id, caller, {
        limit,
        sinceSeq: input.sinceSeq,
      });
    });
  }

  private fetchTask(id: BrandedTaskId): Effect.Effect<Task, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const opt = yield* takeFirstOption(
          this.db.selectFrom("tasks").selectAll().where("id", "=", id),
        );
        if (Option.isNone(opt)) {
          return yield* Effect.fail(notFound(ERR_NOT_FOUND));
        }
        return rowToTask(opt.value as TaskRow);
      }),
    );
  }

  private requireConversationInTask(
    id: BrandedTaskId,
    conversationId: string,
  ): Effect.Effect<void, RpcFailure> {
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
        return yield* Effect.fail(notFound("Conversation not found"));
      }
      if (linkedOpt.value.task_id !== id) {
        return yield* Effect.fail(forbidden(ERR_CONV_NOT_IN_TASK));
      }
    });
  }

  private archiveConversationInTask(
    id: BrandedTaskId,
    conversationId: string,
  ): Effect.Effect<void, RpcFailure> {
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
      yield* this.requireConversationInTask(id, conversationId);
    });
  }

  private fetchTaskMessages(
    id: BrandedTaskId,
    caller: BrandedAgentId,
    opts: { limit: number; sinceSeq?: string },
  ): Effect.Effect<{ messages: Message[]; hasMore: boolean }, RpcFailure> {
    return Effect.gen(this, function* () {
      const conversationIds = yield* catchSqlErrorAsDefect(
        this.db
          .selectFrom("conversations")
          .select("id")
          .where("task_id", "=", id),
      );
      if (conversationIds.length === 0) {
        return { messages: [], hasMore: false };
      }
      const pages = yield* Effect.all(
        conversationIds.map(({ id: convId }) =>
          Effect.either(
            this.messages.list(convId, caller, { limit: opts.limit + 1 }),
          ),
        ),
        { concurrency: 8 },
      );
      const all: Message[] = [];
      for (const result of pages) {
        const messages = Either.match(result, {
          onLeft: () => [] as readonly Message[],
          onRight: (page) => page.messages,
        });
        for (const message of messages) {
          if (opts.sinceSeq !== undefined && message.id <= opts.sinceSeq) {
            continue;
          }
          all.push(message);
        }
      }
      all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const trimmed = all.slice(0, opts.limit);
      return { messages: trimmed, hasMore: all.length > opts.limit };
    });
  }
}
