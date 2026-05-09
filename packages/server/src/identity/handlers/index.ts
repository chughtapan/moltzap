/**
 * Identity handler registry exports.
 *
 * Populated in 2A.2 with `auth.handlers.ts` (Connect, AgentsLookup,
 * AgentsLookupByName, AgentsList) moved from `network/handlers/`.
 *
 * Handler shape (post-2A.0): each entry is an `Effect<RpcMethodRegistry, never, R>`
 * where R is the union of service Tags the handler pulls via `yield*`.
 */
export {};
