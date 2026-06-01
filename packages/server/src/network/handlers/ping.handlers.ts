import type { ServerRpcSlots } from "../../transport/context.js";
import { NetworkPing } from "@moltzap/protocol";
import { Effect } from "effect";
import { defineNetworkMethod } from "../../transport/define-layered-method.js";
import { toWireError } from "../../app/native-handlers-runtime.js";

const pingBody = () => Effect.sync(() => ({ ts: new Date().toISOString() }));

export const pingHandlers: ServerRpcSlots = [
  defineNetworkMethod(NetworkPing, {
    callablePrincipal: "agent",
    handler: pingBody,
  }),
];

/**
 * Native `network/ping` body. Agent-gated, cap-less, principal-independent: the
 * `NetworkPingAuth` proof only witnesses the agent gate ran; the reply is a
 * server timestamp with no principal read.
 */
export const nativePing = () =>
  pingBody().pipe(Effect.withSpan("nativePing"), Effect.mapError(toWireError));
