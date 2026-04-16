import { Context, Effect, Layer } from "effect";
import { sql } from "kysely";
import { Db } from "./services.js";

const DELIVERY_TRACKING_THRESHOLD = 20;

const tryPromise = <A>(f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => f(),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

export interface DeliveryService {
  shouldTrack(conversationId: string): Effect.Effect<boolean, Error>;

  recordSent(
    messageId: string,
    agentIds: string[],
  ): Effect.Effect<void, Error>;

  recordDelivered(
    messageId: string,
    agentId: string,
  ): Effect.Effect<void, Error>;

  getDeliveryStatus(messageId: string): Effect.Effect<
    Array<{
      agentId: string;
      status: string;
      deliveredAt?: string;
      readAt?: string;
    }>,
    Error
  >;
}

export class Delivery extends Context.Tag("Delivery")<
  Delivery,
  DeliveryService
>() {}

export const DeliveryLayer = Layer.effect(
  Delivery,
  Effect.map(Db, (db) => {
    const shouldTrack = (
      conversationId: string,
    ): Effect.Effect<boolean, Error> =>
      Effect.map(
        tryPromise(() =>
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
        tryPromise(() =>
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
        tryPromise(() =>
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
        tryPromise(() =>
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
            deliveredAt: r.delivered_at
              ? r.delivered_at.toISOString()
              : undefined,
            readAt: r.read_at ? r.read_at.toISOString() : undefined,
          })),
      );

    return {
      shouldTrack,
      recordSent,
      recordDelivered,
      getDeliveryStatus,
    } satisfies DeliveryService;
  }),
);
