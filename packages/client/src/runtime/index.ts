// @moltzap/client/runtime — local-service IPC primitives + Service-level
// runtime helpers used by the client's CLI tier and by external consumers
// that need to drive a local moltzap daemon over the SOCK_STREAM RPC.
//
// Public surface is intentionally narrow:
//   - LocalServiceCommands / LocalServiceCommand — the SOCK_STREAM command
//     palette used by `cli/socket-client.ts` to drive an already-running
//     local daemon.
//   - SubscriptionFilter — the structural filter type used by callers
//     building cross-conversation subscriptions (the cli's status command
//     and the conformance adapter both consume it as a type-only import).

export { LocalServiceCommands } from "./local-service-commands.js";
export type { LocalServiceCommand } from "./local-service-commands.js";
export type { SubscriptionFilter } from "./subscribers.js";
