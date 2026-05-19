/**
 * @file Local-service IPC primitives and runtime helpers for the client CLI.
 *
 * Spec B (#596) deleted the three-field `SubscriptionFilter` re-export — the
 * notification consumption surface is now Stream-based via
 * `MoltZapWsClient.subscribe(def, refinement?)`.
 */

export { LocalServiceCommands } from "./local-service-commands.js";
export type { LocalServiceCommand } from "./local-service-commands.js";
