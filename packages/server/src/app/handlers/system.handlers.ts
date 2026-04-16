import type { RpcMethodRegistry } from "../../rpc/context.js";
import type { SystemPingParams } from "@moltzap/protocol";
import { validators } from "@moltzap/protocol";
import { defineMethod } from "../../rpc/context.js";

export function createSystemHandlers(): RpcMethodRegistry {
  return {
    "system/ping": defineMethod<SystemPingParams>({
      validator: validators.systemPingParams,
      handler: async () => {
        return { ts: new Date().toISOString() };
      },
    }),
  };
}
