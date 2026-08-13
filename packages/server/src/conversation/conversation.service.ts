// safer-arch-ignore folder-explicit-api-required: ConversationService is the deliberate concrete service boundary paired with the public conversation index.
import {
  type Db,
  DbTag,
  sql,
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "#db";
import {
  type Conversation,
  type ConversationId,
  ConversationFullError,
} from "@moltzap/protocol/conversation";
import {
  type AgentId,
  type UserId,
  AgentNotFoundError,
} from "@moltzap/protocol/identity";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Effect, Layer, Option } from "effect";
import { ForbiddenError } from "@moltzap/protocol/rpc";
import { type ConnectionManager, ConnectionManagerTag } from "#socket";

const MAX_GROUP_PARTICIPANTS = 256;
const GROUP_OVERFLOW_MSG = `Group cannot exceed ${MAX_GROUP_PARTICIPANTS} participants`;

interface ConversationColumns {
  readonly id: ConversationId;
  readonly name: string | null;
  readonly created_by_id: AgentId;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CreateConversationOptions {
  readonly name?: string;
  readonly agentIds: readonly AgentId[];
  readonly creatorAgentId: AgentId;
}

function mapConversation(row: ConversationColumns): Conversation {
  return {
    id: row.id,
    name: row.name ?? undefined,
    createdBy: row.created_by_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Implements conversation service. */
export class ConversationService {
  private readonly db: Db;
  private readonly connections: ConnectionManager;

  constructor(db: Db, connections: ConnectionManager) {
    this.db = db;
    this.connections = connections;
  }

  create(input: CreateConversationOptions): Effect.Effect<Conversation> {
    return catchSqlErrorAsDefect(this.createConversationEffect(input));
  }

  private createConversationEffect(
    input: CreateConversationOptions,
  ): Effect.Effect<Conversation, SqlError> {
    return Effect.gen(
      function* (this: ConversationService) {
        const created = yield* this.insertConversation(input);
        yield* this.subscribeCreatedConversation(input, created.id);
        yield* this.logConversationCreated(input, created.id);
        return created;
      }.bind(this),
    );
  }

  /**
   * Loads the owner of every requested agent.
   * @param agentIds Value supplied to the operation.
   * @internal
   * @returns The rows result.
   */
  loadAgentOwners(
    agentIds: readonly AgentId[],
  ): Effect.Effect<
    ReadonlyMap<AgentId, UserId>,
    AgentNotFoundError | SqlError
  > {
    return Effect.gen(
      function* (this: ConversationService) {
        const rows =
          agentIds.length === 0
            ? []
            : yield* this.db
                .selectFrom("agents")
                .select(["id", "owner_user_id"])
                .where("id", "in", [...agentIds]);
        const ownerByAgentId = new Map<AgentId, UserId>();
        for (const row of rows) {
          ownerByAgentId.set(row.id, row.owner_user_id);
        }
        for (const agentId of agentIds) {
          if (!ownerByAgentId.has(agentId)) {
            return yield* new AgentNotFoundError({
              message: `Agent ${agentId} not found`,
            });
          }
        }
        return ownerByAgentId;
      }.bind(this),
    );
  }

  /**
   * Rejects a membership that exceeds the group limit. The caller passes the
   * resulting member count; membership is fixed at creation, so this is the
   * only capacity gate.
   * @param memberCount Value supplied to the operation.
   * @internal
   * @returns The capacity assertion result.
   */
  assertGroupCapacity(
    memberCount: number,
  ): Effect.Effect<void, ConversationFullError> {
    if (memberCount <= MAX_GROUP_PARTICIPANTS) {
      return Effect.void;
    }
    return Effect.fail(
      new ConversationFullError({ message: GROUP_OVERFLOW_MSG }),
    );
  }

  private insertConversation(
    input: CreateConversationOptions,
  ): Effect.Effect<Conversation, SqlError> {
    return transaction(this.db, (trx) =>
      Effect.gen(
        function* (this: ConversationService) {
          const conv = yield* takeFirstOrFail(
            trx
              .insertInto("conversations")
              .values({
                name: input.name ?? null,
                created_by_id: input.creatorAgentId,
              })
              .returningAll(),
          );
          // The creator joins the conversation it opens; membership is the
          // creator plus every named participant.
          yield* trx.insertInto("conversation_participants").values({
            conversation_id: conv.id,
            agent_id: input.creatorAgentId,
          });
          for (const agentId of input.agentIds) {
            yield* trx
              .insertInto("conversation_participants")
              .values({ conversation_id: conv.id, agent_id: agentId })
              .onConflict((oc) => oc.doNothing());
          }
          return mapConversation(conv);
        }.bind(this),
      ),
    );
  }

  private subscribeCreatedConversation(
    input: CreateConversationOptions,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    // Mirrors `insertConversation`'s membership set.
    const memberAgentIds = [input.creatorAgentId, ...input.agentIds];
    return this.connections.addConversationToAgents(
      memberAgentIds,
      conversationId,
    );
  }

  private logConversationCreated(
    input: CreateConversationOptions,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    const participantCount = input.agentIds.length + 1;
    return Effect.logInfo("Conversation created").pipe(
      Effect.annotateLogs({
        conversationId,
        participantCount,
      }),
    );
  }

  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          const rows = yield* this.db
            .selectFrom("conversation_participants")
            .select("agent_id")
            .where("conversation_id", "=", conversationId);

          return rows.map((r) => r.agent_id);
        }.bind(this),
      ),
    );
  }

  getConversationIds(agentId: AgentId): Effect.Effect<ConversationId[]> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          const rows = yield* this.db
            .selectFrom("conversation_participants")
            .select("conversation_id")
            .where("agent_id", "=", agentId);
          return rows.map((r) => r.conversation_id);
        }.bind(this),
      ),
    );
  }

  assertConversationParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          const rowOpt = yield* takeFirstOption(
            this.db
              .selectFrom("conversation_participants")
              .select(sql`1`.as("exists"))
              .where("conversation_id", "=", conversationId)
              .where("agent_id", "=", agentId),
          );

          if (Option.isNone(rowOpt)) {
            return yield* new ForbiddenError({
              message: "Not a participant in this conversation",
            });
          }
        }.bind(this),
      ),
    );
  }
}

/** Identifies the conversation service in the server runtime context. */
export class ConversationServiceTag extends Context.Tag(
  "moltzap/ConversationService",
)<ConversationServiceTag, ConversationService>() {}

/** Constructs the conversation service from its storage and connection ports. */
export const conversationServiceLive = Layer.effect(
  ConversationServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const connections = yield* ConnectionManagerTag;
    return new ConversationService(db, connections);
  }).pipe(Effect.withSpan("ConversationServiceLive")),
);
