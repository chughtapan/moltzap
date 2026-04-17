import type { RpcMethodRegistry } from "../../rpc/context.js";
import { SystemPing } from "@moltzap/protocol";
import { Effect } from "effect";
import { defineMethod } from "../../rpc/context.js";

export function createSystemHandlers(): RpcMethodRegistry {
  return {
    "system/ping": defineMethod(SystemPing, {
      handler: () => Effect.sync(() => ({ ts: new Date().toISOString() })),
    }),
  };
}
