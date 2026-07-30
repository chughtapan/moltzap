/**
 * @file Protocol package root.
 *
 * The root surface is intentionally tiny: concrete protocol-owned socket
 * lifecycle classes only. Domain descriptors, schemas, requirement tags, and
 * testing helpers live behind focused package subpaths.
 */

/** Re-exports the public API from `#socket`. */
export { MoltZapAgentClient, MoltZapAppClient, MoltZapServer } from "#socket";
/** Re-exports the public API from `#socket`. */
export type {
  AgentClientOptions,
  AppClientOptions,
  ConnectResult,
  MoltZapServerOptions,
  MoltZapServerSession,
  RpcCallOptions,
} from "#socket";
// safer-arch-ignore no-folder-cycle: Task and conversation wire contracts mutually reference task ownership and initial-conversation payloads by protocol design.
// safer-arch-ignore no-package-mesh: The protocol package is a catalog of peer wire domains; the sparse task/conversation cycle is explicit and schema-only.
