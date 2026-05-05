import { Type } from "@sinclair/typebox";
import { DateTimeString } from "../../helpers.js";
import { defineRpc } from "../../rpc.js";

export const SystemPing = defineRpc({
  name: "system/ping",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object(
    {
      ts: DateTimeString,
    },
    { additionalProperties: false },
  ),
});
