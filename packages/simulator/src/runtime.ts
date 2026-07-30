/** @file Autonomous agent runtime contracts and shipped implementations. */

/** Re-exports the public API from `./runtime/runtime.js`. */
export {
  AgentRuntimeDefinitionError,
  RuntimeCompleted,
  RuntimeExited,
  RuntimeFailed,
  RuntimeSignaled,
  defineRuntime,
  runtimeConfigurationProjection,
  type AgentRuntime,
  type AgentRuntimeDefinition,
  type AgentRuntimeInput,
  type RunningAgent,
  type RuntimeTermination,
} from "./runtime/runtime.js";

/** Re-exports the public API from `./runtime/roster.js`. */
export type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentRosterRequirements,
  AgentsService,
  RuntimeGatewayOf,
  StartedAgent,
  StartedAgents,
} from "./runtime/roster.js";

/** Re-exports the public API from `./runtime/effect.js`. */
export {
  EffectRuntimeStartFailed,
  effectRuntime,
  type EffectAgent,
  type EffectRuntimeContext,
  type EffectRuntimeOptions,
} from "./runtime/effect.js";

/** Re-exports the public API from `./runtime/openclaw/runtime.js`. */
export {
  openClawRuntime,
  type OpenClawRuntimeAcquisitionError,
  type OpenClawRuntimeOptions,
  type OpenClawSandboxConfig,
  type OpenClawToolsConfig,
} from "./runtime/openclaw/runtime.js";

/** Re-exports the public API from `./runtime/openclaw/gateway.js`. */
export {
  OpenClawGatewayRequest,
  OpenClawGatewayRequestFailed,
  OpenClawGatewayResponse,
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
  type OpenClawGateway,
} from "./runtime/openclaw/gateway.js";

/** Re-exports the public API from `./runtime/nanoclaw/runtime.js`. */
export {
  nanoclawRuntime,
  type NanoclawRuntimeAcquisitionError,
  type NanoclawRuntimeOptions,
} from "./runtime/nanoclaw/runtime.js";

/** Re-exports the public API from `./runtime/nanoclaw/gateway.js`. */
export {
  NanoclawGatewayError,
  NanoclawGatewayInput,
  NanoclawGatewayOutput,
  type NanoclawGateway,
} from "./runtime/nanoclaw/gateway.js";

/** Re-exports the public API from `./runtime/process.js`. */
export { RuntimeAcquisitionFailed } from "./runtime/process.js";

/** Re-exports the public API from `./runtime/packages.js`. */
export type { InstallMode } from "./runtime/packages.js";
