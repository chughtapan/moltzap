import { Type } from "@sinclair/typebox";
import { TaskId } from "../../schema/primitives.js";
import { defineRpc } from "../../rpc.js";

export const EndpointsRegisterTaskManager = defineRpc({
  name: "endpoints/registerTaskManager",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object(
    {
      taskId: TaskId,
      tmEndpointAddress: Type.String(),
    },
    { additionalProperties: false },
  ),
});

export const EndpointsUnregisterTaskManager = defineRpc({
  name: "endpoints/unregisterTaskManager",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});
