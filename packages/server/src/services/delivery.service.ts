import type { Db } from "../db/client.js";
import type { ParticipantRef } from "@moltzap/protocol";
import { sql } from "kysely";

const DELIVERY_TRACKING_THRESHOLD = 20;

/**
 * Tracks sent/delivered/read status per-message per-recipient.
 * Only tracks for DMs and small groups (< 20 participants).
 */
export class DeliveryService {
  constructor(private db: Db) {}

  async shouldTrack(conversationId: string): Promise<boolean> {
    const result = await this.db
      .selectFrom("conversation_participants")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("conversation_id", "=", conversationId)
      .executeTakeFirstOrThrow();
    return result.count < DELIVERY_TRACKING_THRESHOLD;
  }

  async recordSent(
    messageId: string,
    recipients: ParticipantRef[],
  ): Promise<void> {
    if (recipients.length === 0) return;

    await this.db
      .insertInto("message_delivery")
      .values(
        recipients.map((r) => ({
          message_id: messageId,
          participant_type: r.type,
          participant_id: r.id,
          status: "sent" as const,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async recordDelivered(
    messageId: string,
    participant: ParticipantRef,
  ): Promise<void> {
    await this.db
      .updateTable("message_delivery")
      .set({ status: "delivered", delivered_at: sql`now()` })
      .where("message_id", "=", messageId)
      .where("participant_type", "=", participant.type)
      .where("participant_id", "=", participant.id)
      .where("status", "=", "sent")
      .execute();
  }

  async getDeliveryStatus(messageId: string): Promise<
    Array<{
      participantType: string;
      participantId: string;
      status: string;
      deliveredAt?: string;
      readAt?: string;
    }>
  > {
    const rows = await this.db
      .selectFrom("message_delivery")
      .select([
        "participant_type",
        "participant_id",
        "status",
        "delivered_at",
        "read_at",
      ])
      .where("message_id", "=", messageId)
      .execute();

    return rows.map((r) => ({
      participantType: r.participant_type,
      participantId: r.participant_id,
      status: r.status,
      deliveredAt: r.delivered_at ? r.delivered_at.toISOString() : undefined,
      readAt: r.read_at ? r.read_at.toISOString() : undefined,
    }));
  }
}
