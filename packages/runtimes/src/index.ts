/**
 * @file Public exports for runtime adapter orchestration.
 */
export {
  AgentName,
  ServerUrl,
  type WorkspaceFile,
  type RuntimeServerHandle,
  type SpawnInput,
  type LogSlice,
  type ReadyOutcome,
  type Runtime,
} from "./runtime.js";

export { awaitAgentReadyByPolling } from "./await-agent-ready.js";

export {
  type OpenClawAdapterDeps,
  type WorkspaceOpenClawAdapterInput,
  OpenClawAdapter,
  createWorkspaceOpenClawAdapter,
} from "./openclaw-adapter.js";

export {
  type NanoclawAdapterDeps,
  NanoclawAdapter,
} from "./nanoclaw-adapter.js";

export {
  SpawnFailed,
  RuntimeExitedBeforeReady,
  RuntimeReadyTimedOut,
  type RuntimeLaunchFailed,
} from "./errors.js";

export {
  type RuntimeKind,
  type RuntimeAgentSpec,
  type RuntimeFleet,
  type RuntimeFleetAgent,
  type RuntimeFleetLaunchOptions,
  type RuntimeFleetProcessSignalOptions,
  type RuntimeStartOptions,
  RuntimeFleetStartupInterrupted,
  startRuntimeAgent,
  launchRuntimeFleet,
  launchRuntimeFleetWithProcessSignals,
} from "./fleet.js";
