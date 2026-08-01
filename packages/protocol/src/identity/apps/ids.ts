import { type Brand, Schema } from "effect";

import { formatString } from "#transport";

export type AppId = string & Brand.Brand<"AppId">;
export const AppId: Schema.Schema<AppId, string> = formatString("uuid").pipe(
  Schema.brand("AppId"),
  Schema.annotations({ description: "Branded AppId" }),
);

export const DEFAULT_APP_ID = Schema.decodeSync(AppId)(
  "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb",
);
