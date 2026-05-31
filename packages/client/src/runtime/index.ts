/**
 * @file Local-service IPC primitives and runtime helpers for the client CLI.
 *
 * The notification consumption surface is Stream-based via
 * `MoltZapAgentClient.subscribe(def, refinement?)`.
 */

export { LocalServiceCommands } from "./local-service-commands.js";
export type { LocalServiceCommand } from "./local-service-commands.js";
