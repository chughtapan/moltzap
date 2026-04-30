import { Type, type Static } from "@sinclair/typebox";

/**
 * Generic logical time frontier for one delivery domain.
 *
 * The domain is usually a conversation. `epoch` is a local monotonic sequence
 * number for that domain, and `vector` records the latest observed count per
 * participant or producer id. Servers may use this as admission metadata, but
 * clients only report what they have actually observed.
 */
export const LogicalClockSchema = Type.Object(
  {
    domainId: Type.String({ minLength: 1 }),
    epoch: Type.Integer({ minimum: 0 }),
    vector: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type LogicalClock = Static<typeof LogicalClockSchema>;
