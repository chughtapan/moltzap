/**
 * @file Local-service IPC primitives and runtime helpers for the client CLI.
 *
 * The public surface is intentionally narrow: command definitions for the
 * local daemon socket and the subscription filter type consumed by status and
 * conformance adapters.
 */

export { LocalServiceCommands } from "./local-service-commands.js";
export type { LocalServiceCommand } from "./local-service-commands.js";
export type { SubscriptionFilter } from "./subscribers.js";
