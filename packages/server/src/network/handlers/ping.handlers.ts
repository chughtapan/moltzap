import type { ServerRpcSlots } from "../../transport/context.js";
import { NetworkPing } from "@moltzap/protocol";
import { Effect } from "effect";
import { defineNetworkMethod } from "../../transport/define-layered-method.js";

export const pingHandlers: ServerRpcSlots = [
  defineNetworkMethod(NetworkPing, {
    callablePrincipal: "agent",
    handler: () => Effect.sync(() => ({ ts: new Date().toISOString() })),
  }),
];
