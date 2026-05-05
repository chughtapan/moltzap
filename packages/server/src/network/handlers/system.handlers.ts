import type { RpcMethodRegistry } from "../../rpc/context.js";
import { SystemPing } from "@moltzap/protocol";
import { Effect } from "effect";
import { defineNetworkMethod } from "../../rpc/define-layered-method.js";

export function createSystemHandlers(): RpcMethodRegistry {
  return [
    defineNetworkMethod(SystemPing, {
      handler: () => Effect.sync(() => ({ ts: new Date().toISOString() })),
    }),
  ];
}
