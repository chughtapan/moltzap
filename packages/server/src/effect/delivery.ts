import { Context, Effect } from "effect";
import { sql } from "kysely";
import { tryDb } from "./services.js";

const DELIVERY_TRACKING_THRESHOLD = 20;

export interface DeliveryService {
  shouldTrack(conversationId: string): Effect.Effect<boolean, Error, never>;

  recordSent(
    messageId: string,
    agentIds: string[],
  ): Effect.Effect<void, Error, never>;

  recordDelivered(
    messageId: string,
    agentId: string,
  ): Effect.Effect<void, Error, never>;

  getDeliveryStatus(messageId: string): Effect.Effect<
    Array<{
      agentId: string;
      status: string;
      deliveredAt?: string;
      readAt?: string;
    }>,
    Error,
    never
  >;
}

export class Delivery extends Context.Tag("Delivery")<
  Delivery,
  DeliveryService
>() {}

const shouldTrack = (conversationId: string): Effect.Effect<boolean, Error> =>
  Effect.map(
    tryDb((db) =>
      db
        .selectFrom("conversation_participants")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("conversation_id", "=", conversationId)
        .executeTakeFirstOrThrow(),
    ),
    (result) => result.count < DELIVERY_TRACKING_THRESHOLD,
  );

const recordSent = (
  messageId: string,
  agentIds: string[],
): Effect.Effect<void, Error> => {
  if (agentIds.length === 0) return Effect.void;

  return Effect.asVoid(
    tryDb((db) =>
      db
        .insertInto("message_delivery")
        .values(
          agentIds.map((agentId) => ({
            message_id: messageId,
            agent_id: agentId,
            status: "sent" as const,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute(),
    ),
  );
};

const recordDelivered = (
  messageId: string,
  agentId: string,
): Effect.Effect<void, Error> =>
  Effect.asVoid(
    tryDb((db) =>
      db
        .updateTable("message_delivery")
        .set({ status: "delivered", delivered_at: sql`now()` })
        .where("message_id", "=", messageId)
        .where("agent_id", "=", agentId)
        .where("status", "=", "sent")
        .execute(),
    ),
  );

const getDeliveryStatus = (
  messageId: string,
): Effect.Effect<
  Array<{
    agentId: string;
    status: string;
    deliveredAt?: string;
    readAt?: string;
  }>,
  Error
> =>
  Effect.map(
    tryDb((db) =>
      db
        .selectFrom("message_delivery")
        .select(["agent_id", "status", "delivered_at", "read_at"])
        .where("message_id", "=", messageId)
        .execute(),
    ),
    (rows) =>
      rows.map((r) => ({
        agentId: r.agent_id,
        status: r.status,
        deliveredAt: r.delivered_at ? r.delivered_at.toISOString() : undefined,
        readAt: r.read_at ? r.read_at.toISOString() : undefined,
      })),
  );

export const DeliveryLive: DeliveryService = {
  shouldTrack,
  recordSent,
  recordDelivered,
  getDeliveryStatus,
};

export const DeliveryLayer = Effect.provideService(
  Effect.void,
  Delivery,
  DeliveryLive,
).pipe(Effect.toLayer(Delivery));
