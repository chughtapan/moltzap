import type { Db } from "../db/client.js";
import { sql } from "kysely";
import { Effect } from "effect";
import { RpcFailure } from "../runtime/index.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOrFail,
} from "../db/effect-kysely-toolkit.js";

const DELIVERY_TRACKING_THRESHOLD = 20;

/**
 * Tracks sent/delivered/read status per-message per-recipient.
 * Only tracks for DMs and small groups (< 20 participants).
 */
export class DeliveryService {
  constructor(private db: Db) {}

  shouldTrack(conversationId: string): Effect.Effect<boolean, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const result = yield* takeFirstOrFail(
          this.db
            .selectFrom("conversation_participants")
            .select(sql<number>`count(*)::int`.as("count"))
            .where("conversation_id", "=", conversationId),
          "participant count not returned",
        );
        return result.count < DELIVERY_TRACKING_THRESHOLD;
      }),
    );
  }

  recordSent(
    messageId: string,
    agentIds: string[],
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        if (agentIds.length === 0) return;

        yield* this.db
          .insertInto("message_delivery")
          .values(
            agentIds.map((agentId) => ({
              message_id: messageId,
              agent_id: agentId,
              status: "sent" as const,
            })),
          )
          .onConflict((oc) => oc.doNothing());
      }),
    );
  }

  recordDelivered(
    messageId: string,
    agentId: string,
  ): Effect.Effect<void, RpcFailure> {
    return this.recordDeliveredBatch(messageId, [agentId]);
  }

  recordDeliveredBatch(
    messageId: string,
    agentIds: string[],
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        if (agentIds.length === 0) return;
        yield* this.db
          .updateTable("message_delivery")
          .set({ status: "delivered", delivered_at: sql`now()` })
          .where("message_id", "=", messageId)
          .where("agent_id", "in", agentIds)
          .where("status", "=", "sent");
      }),
    );
  }

  getDeliveryStatus(messageId: string): Effect.Effect<
    Array<{
      agentId: string;
      status: string;
      deliveredAt?: string;
      readAt?: string;
    }>,
    RpcFailure
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("message_delivery")
          .select(["agent_id", "status", "delivered_at", "read_at"])
          .where("message_id", "=", messageId);

        return rows.map((r) => ({
          agentId: r.agent_id,
          status: r.status,
          deliveredAt: r.delivered_at
            ? r.delivered_at.toISOString()
            : undefined,
          readAt: r.read_at ? r.read_at.toISOString() : undefined,
        }));
      }),
    );
  }
}
