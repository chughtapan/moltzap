/**
 * @file Public barrel — protocol layer DAG.
 *
 * The protocol package is the leaf in the workspace dependency
 * graph, and internally it is split into layers with their own
 * one-way dependency order. Re-exports below are arranged in DAG
 * order so the file itself is the manifest.
 *
 * ```mermaid
 * flowchart TD
 *   engine[engine/] --> app[app/]
 *   engine --> task[task/]
 *   engine --> transport[transport/]
 *   app --> task
 *   app --> identity[identity/]
 *   app --> transport
 *   task --> identity
 *   task --> transport
 *   network[network/] --> identity
 *   network --> transport
 *   identity --> transport
 *   transport --> schema[schema-primitives]
 * ```
 *
 * `transport/` is the wire bottom (frames, the descriptor factory, the
 * mux, the low principal tags). `engine/` is the TOP: the genuine
 * `Requirement` union + capability middlewares + the server/client engine
 * groups, which couple to the full catalog (`rpc-registry`) and the
 * task-layer capability tags. A `task/*` method may reference `identity/*`
 * types (e.g. `AgentId`); the reverse import is forbidden. The server's
 * Tag-allowlist hierarchy in `@moltzap/server-core` mirrors this DAG: a
 * handler may pull services only from layers at-or-below its own home layer.
 */
export {
  PROTOCOL_VERSION,
  compareProtocolVersion,
  checkProtocolRange,
  InvalidProtocolVersionError,
} from "./version.js";

// Opaque pagination token for the cursor-paginated list RPCs.
export { listCursorSchema } from "./schema-primitives.js";
export type { ListCursor } from "./schema-primitives.js";

// Brand aliases the wire id types resolve to. Re-exported so downstream
// `.d.ts` emit can name them via the package entry (not the deep
// `dist/schema-primitives.js` path) — TS2742 portability.
export type { BrandedString } from "./schema-primitives.js";

// Shared pagination limits for the cursor-paginated list RPCs.
export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  ListLimitSchema,
} from "./pagination.js";

export * from "./transport/index.js";
export * from "./identity/index.js";
export * from "./network/index.js";
export * from "./task/index.js";
export * from "./app/index.js";
export * from "./engine/index.js";

export {
  serverRpcMethods,
  agentClientRpcMethods,
  appCallableRpcMethods,
  notificationDefinitions,
  decodeServerInbound,
} from "./rpc-registry.js";
export type {
  AnyServerRpcDefinition,
  AnyAgentClientRpcDefinition,
  AnyAppCallbackRpcDefinition,
  AnyNotificationDefinition,
  DecodedServerInbound,
  DecodedResponseSuccess,
  DecodedResponseError,
} from "./rpc-registry.js";
