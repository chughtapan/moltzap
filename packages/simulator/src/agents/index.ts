/** @file Autonomous agent runtime contracts and shipped implementations. */

/** Re-exports the autonomous runtime contract. */
export {
  type AgentRuntime,
  AgentRuntimeDefinitionError,
  type AgentRuntimeInput,
  type RunningAgent,
  RuntimeCompleted,
  runtimeConfigurationProjection,
  RuntimeExited,
  RuntimeFailed,
  RuntimeSignaled,
  type RuntimeTermination,
} from "./agent.js";

/** Re-exports the container descriptor boundary. */
export {
  type Application,
  type ApplicationEndpoint,
  type ContainerAgentRuntime,
  type ContainerRuntime,
  type CredentialName,
  defineContainerRuntime,
  type File,
  image,
  type Image,
  type Resources,
  routableBridgeEndpoint,
  stoppedBeforeAttach,
} from "./container.js";

/** Re-exports the keyed runtime roster. */
export type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentsService,
  RuntimeGatewayOf,
  StartedAgent,
  StartedAgents,
} from "./roster.js";

/** Re-exports the OpenClaw runtime definition. */
export {
  openClawRuntime,
  type OpenClawRuntimeOptions,
  type OpenClawSandboxConfig,
  type OpenClawToolsConfig,
} from "./openclaw/runtime.js";

/** Re-exports the OpenClaw principal gateway. */
export {
  type OpenClawGateway,
  OpenClawGatewayRequest,
  OpenClawGatewayRequestError,
  OpenClawGatewayResponse,
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
} from "./openclaw/gateway.js";

/** Re-exports the NanoClaw runtime definition. */
export {
  nanoclawRuntime,
  type NanoClawRuntimeOptions,
} from "./nanoclaw/runtime.js";

/** Re-exports the NanoClaw principal gateway. */
export {
  type NanoClawGateway,
  NanoClawGatewayError,
  NanoClawGatewayInput,
  NanoClawGatewayOutput,
} from "./nanoclaw/gateway.js";

/** Re-exports the runtime acquisition failure. */
export { RuntimeAcquisitionError } from "./agent.js";
