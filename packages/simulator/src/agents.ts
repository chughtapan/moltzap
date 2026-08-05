/** @file Autonomous agent runtime contracts and shipped implementations. */

/** Re-exports the public API from `./agents/agent.js`. */
export {
  AgentRuntimeDefinitionError,
  RuntimeCompleted,
  RuntimeExited,
  RuntimeFailed,
  RuntimeSignaled,
  runtimeConfigurationProjection,
  type AgentRuntime,
  type AgentRuntimeInput,
  type RunningAgent,
  type RuntimeTermination,
} from "./agents/agent.js";

/** Re-exports the container descriptor boundary from `./agents/container.js`. */
export {
  defineContainerRuntime,
  stoppedBeforeAttach,
  type Application,
  type ContainerRuntime,
  type CredentialName,
  type File,
  type Image,
  type Resources,
} from "./agents/container.js";

/** Re-exports the public API from `./agents/roster.js`. */
export type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentsService,
  RuntimeGatewayOf,
  StartedAgent,
  StartedAgents,
} from "./agents/roster.js";

/** Re-exports the public API from `./agents/openclaw/runtime.js`. */
export {
  openClawRuntime,
  type OpenClawRuntimeAcquisitionError,
  type OpenClawRuntimeOptions,
  type OpenClawSandboxConfig,
  type OpenClawToolsConfig,
} from "./agents/openclaw/runtime.js";

/** Re-exports the public API from `./agents/openclaw/gateway.js`. */
export {
  OpenClawGatewayRequest,
  OpenClawGatewayRequestError,
  OpenClawGatewayResponse,
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
  type OpenClawGateway,
} from "./agents/openclaw/gateway.js";

/** Re-exports the public API from `./agents/nanoclaw/runtime.js`. */
export {
  nanoclawRuntime,
  type NanoClawRuntimeAcquisitionError,
  type NanoClawRuntimeOptions,
} from "./agents/nanoclaw/runtime.js";

/** Re-exports the public API from `./agents/nanoclaw/gateway.js`. */
export {
  NanoClawGatewayError,
  NanoClawGatewayInput,
  NanoClawGatewayOutput,
  type NanoClawGateway,
} from "./agents/nanoclaw/gateway.js";

/** Re-exports the runtime acquisition failure from `./agents/agent.js`. */
export { RuntimeAcquisitionError } from "./agents/agent.js";
