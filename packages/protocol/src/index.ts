/**
 * @file Protocol package root.
 *
 * The root surface is intentionally tiny: concrete protocol-owned socket
 * lifecycle classes only. Domain descriptors, schemas, requirement tags, and
 * testing helpers live behind focused package subpaths.
 */

export { MoltZapAgentClient } from "./socket/agent-client.js";
export { MoltZapAppClient } from "./socket/app-client.js";
export { MoltZapServer } from "./socket/server.js";
