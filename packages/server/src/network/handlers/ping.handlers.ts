import type { RpcMethodRegistry } from "../../transport/context.js";
import { NetworkPing } from "@moltzap/protocol";
import { Effect } from "effect";
import { defineNetworkMethod } from "../../transport/define-layered-method.js";

export const pingHandlers: RpcMethodRegistry = [
  defineNetworkMethod(NetworkPing, {
    handler: () => Effect.sync(() => ({ ts: new Date().toISOString() })),
  }),
];
