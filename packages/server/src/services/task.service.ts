import { Effect, Option } from "effect";
import {
  endpointAddress as brandEndpointAddress,
  makeEndpointAddress,
  type EndpointAddress,
  type AgentId as ActorAgentId,
} from "@moltzap/protocol/network";
import { defaultTmAddressForType } from "../network/app-tm-registry.js";
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
  readonly id: string;
  readonly app_id: string | null;
  readonly initiator_agent_id: string;
  readonly status: TaskStatus;
  // Phase 9b consumer-migration (sub-issue #460 round 3 R12): NOT NULL.
  readonly tm_endpoint_address: string;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly created_at: Date;
}

/**
 * Stable TM-endpoint address for a registering agent: `tm:agent:<agentId>`.
 * Persisted in `tasks.tm_endpoint_address` and routed through
 * `network.send` via `AgentEndpointResolver.resolveAll`. Phase 9b
 * consumer-migration (sub-issue #460 amendment) collapsed the volatile
 * per-WS-connection form into a resolver-internal `ConnectionId` lookup
 * — `tm:agent:<agentId>` is the only `EndpointAddress` shape that
 * appears on the wire today.
 */
export function endpointAddressForAgent(
  agent: ActorAgentId | BrandedAgentId,
): EndpointAddress {
  return makeEndpointAddress("agent", agent);
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
   *   `tm:app:<defaultDmTm | defaultGroupTm>` address (R14).
   */
  readonly tmEndpointAddress: EndpointAddress;
}

export interface TaskListInput {
  readonly appId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export interface TaskMessagesInput {
  readonly conversationId: string;
  readonly limit?: number;
}

export interface TaskMessagesSinceInput {
  readonly conversationId: string;
  readonly sinceSeq: string;
  readonly limit?: number;
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

  /**
   * Phase 9b consumer-migration (sub-issue #460 round 3 R14): server-
   * internal helper for the `conversations/create` auto-task path and
   * the `messages/send` auto-DM path. Creates a task whose TM is the
   * default `tm:app:<dm | group>` endpoint, returning the row so the
   * caller can pass `task.id` to `ConversationService.create`.
   *
   * Used by `conversations/create` (server handler) and the
   * `messages/send` agent:<name> path. Custom-TM apps (werewolf etc.)
   * call the public `create` directly with their own
   * `tmEndpointAddress` instead.
   */
  createDefaultTaskForType(
    type: "dm" | "group",
    initiator: BrandedAgentId,
    invitedAgentIds: readonly BrandedAgentId[] = [],
  ): Effect.Effect<Task, RpcFailure> {
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
  requireTmAuthority(
    id: BrandedTaskId,
    caller: BrandedAgentId,
  ): Effect.Effect<Task, RpcFailure> {
    return Effect.gen(this, function* () {
      const task = yield* this.fetchTask(id);
      switch (task.status) {
        case "waiting":
        case "active":
          break;
        case "closed":
        case "failed":
          return yield* Effect.fail(forbidden(ERR_TASK_NOT_OPEN));
        default:
          return absurdTaskStatus(task.status);
      }
      const recorded = yield* Effect.try({
        try: () => brandEndpointAddress(task.tmEndpointAddress),
        catch: () => forbidden(ERR_NOT_TM),
      });
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
      // Phase 9b consumer-migration (sub-issue #460 round 3 R12):
      // `conversations.task_id` is NOT NULL. Pass the task id at
      // insert time inside ConversationService.create's transaction
      // so the row exists with `task_id` set from the start. The
      // pre-R12 post-insert UPDATE pattern retired alongside the
      // nullable column.
      const conversation = yield* this.conversations.create(
        input.type,
        input.name,
        [...input.participantAgentIds],
        caller,
        id,
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
        // No `excludeConnectionId` — the TM is the storeMessage caller
        // but its connection is not the original sender's, so the
        // broadcaster fans out normally.
        undefined,
        // Bypass TM routing: this insert IS the TM acting on a message
        // it already admitted. Without the flag, MessageService.send
        // would re-emit a `messages/received` frame to the TM's own
        // socket via `network.send` — a self-loop on every TM-authored
        // store. Phase 9b codex HIGH-1.
        true,
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
      yield* this.requireConversationInTask(id, input.conversationId);
      return yield* this.messages.list(input.conversationId, caller, {
        limit: input.limit ?? DEFAULT_TASK_MESSAGES_LIMIT,
      });
    });
  }

  getMessagesSince(
    id: BrandedTaskId,
    caller: BrandedAgentId,
    input: TaskMessagesSinceInput,
  ): Effect.Effect<{ messages: Message[]; hasMore: boolean }, RpcFailure> {
    return Effect.gen(this, function* () {
      yield* this.requireReadAccess(id, caller);
      yield* this.requireConversationInTask(id, input.conversationId);
      return yield* this.messages.list(input.conversationId, caller, {
        limit: input.limit ?? DEFAULT_TASK_MESSAGES_LIMIT,
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
}
