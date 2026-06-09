/** @file Server WebSocket/session runtime boundary. */

export {
  ConnectionManager,
  sendRpcToClient,
  type AgentConnection,
  type Connection,
  type Originator,
} from "./connection.js";

export { AgentContext, AppContext, agentContextFrom } from "./context.js";

export { peekLiveArm } from "./principal-gate.js";

export type { AppTags } from "./layer-tags.js";
