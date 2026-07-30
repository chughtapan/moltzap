/**
 * @file Public identity contracts: immutable agent cards, identifiers,
 * and the signing and request-authentication profiles every other v2
 * package builds on. `identity` sits at the root of the v2 dependency
 * graph and imports no other v2 package.
 */

/**
 * The sole MoltZap compatibility value. Every MoltZap-owned network
 * schema and all six v2 package manifests carry exactly this value;
 * there is no range negotiation and no per-layer version. `v2/VERSION`
 * is its source of truth, and a boundary check fails the build when the
 * two drift.
 *
 * The MCP revision, simulator definition ID, EventCatalog schema, and
 * RunLedger storage version are independent namespaces and never imply
 * compatibility with this value.
 */
export const MOLTZAP_VERSION = "2026.729.1";
