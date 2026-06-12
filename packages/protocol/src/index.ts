/**
 * @file Protocol package root.
 *
 * The root surface is intentionally tiny: concrete protocol-owned socket
 * lifecycle classes only. Domain descriptors, schemas, requirement tags, and
 * testing helpers live behind focused package subpaths.
 */

export { MoltZapAgentClient, MoltZapAppClient, MoltZapServer } from "#socket";
export type {
  AgentClientOptions,
  AppClientOptions,
  ConnectResult,
  MoltZapServerOptions,
  MoltZapServerSession,
  RpcCallOptions,
} from "#socket";
