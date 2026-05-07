import type { RpcMethodRegistry } from "../../rpc/context.js";
import { NetworkPing } from "@moltzap/protocol";
import { Effect } from "effect";
import { defineNetworkMethod } from "../../rpc/define-layered-method.js";

export function createPingHandlers(): RpcMethodRegistry {
  return [
    defineNetworkMethod(NetworkPing, {
      handler: () => Effect.sync(() => ({ ts: new Date().toISOString() })),
    }),
  ];
}
