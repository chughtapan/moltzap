/**
 * @file User identity identifiers.
 */
import { Schema, type Brand } from "effect";

import { formatString } from "#transport";

/** Represents user id values. */
export type UserId = string & Brand.Brand<"UserId">;
/** Validates and decodes user id values. */
export const userId: Schema.Schema<UserId, string> = formatString("uuid").pipe(
  Schema.brand("UserId"),
  Schema.annotations({ description: "Branded UserId" }),
);
