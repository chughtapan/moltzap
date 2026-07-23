/**
 * @file Protocol package root.
 *
 * The root surface is intentionally tiny: concrete protocol-owned socket
 * lifecycle classes only. Domain descriptors, schemas, requirement tags, and
 * testing helpers live behind focused package subpaths.
 */

// safer-arch-ignore no-public-vendor-type-leak: The public root re-exports protocol's own #socket subpath, which is package-owned rather than a vendor boundary.
// safer-arch-ignore require-boundary-owned-types: The public root re-exports package-owned #socket domain types as its curated API.

export { MoltZapAgentClient, MoltZapAppClient, MoltZapServer } from "#socket";
export type {
  AgentClientOptions,
  AppClientOptions,
  ConnectResult,
  MoltZapServerOptions,
  MoltZapServerSession,
  RpcCallOptions,
} from "#socket";
