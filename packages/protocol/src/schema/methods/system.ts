import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString } from "../../helpers.js";

export const SystemPingParamsSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const SystemPingResultSchema = Type.Object(
  {
    ts: DateTimeString,
  },
  { additionalProperties: false },
);

export type SystemPingParams = Static<typeof SystemPingParamsSchema>;
export type SystemPingResult = Static<typeof SystemPingResultSchema>;
