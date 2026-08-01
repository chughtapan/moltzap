import { type Brand, Schema } from "effect";

import { formatString } from "#transport";

export type UserId = string & Brand.Brand<"UserId">;
export const UserId: Schema.Schema<UserId, string> = formatString("uuid").pipe(
  Schema.brand("UserId"),
  Schema.annotations({ description: "Branded UserId" }),
);
