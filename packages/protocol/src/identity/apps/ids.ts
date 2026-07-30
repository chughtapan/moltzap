import { Schema, type Brand } from "effect";

import { formatString } from "#transport";

/** Represents app id values. */
export type AppId = string & Brand.Brand<"AppId">;
/** Validates and decodes app id values. */
export const appId: Schema.Schema<AppId, string> = formatString("uuid").pipe(
  Schema.brand("AppId"),
  Schema.annotations({ description: "Branded AppId" }),
);

/** Validates and decodes default app id values. */
export const DEFAULT_APP_ID = Schema.decodeSync(appId)(
  "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb",
);
