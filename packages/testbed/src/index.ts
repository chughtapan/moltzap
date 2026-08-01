/**
 * @file Public exports for launching and supervising connected-agent testbeds.
 */
export {
  AgentName,
  type LogSlice,
  type ReadyOutcome,
  type Runtime,
  type RuntimeServerHandle,
  ServerUrl,
  type SpawnInput,
  type WorkspaceFile,
} from "./runtime.js";

export { awaitAgentReadyByPolling } from "./await-agent-ready.js";

export {
  createOpenClawAdapter,
  OpenClawAdapter,
  type OpenClawAdapterDeps,
  type OpenClawAdapterOptions,
} from "./openclaw-adapter.js";

export {
  NanoclawAdapter,
  type NanoclawAdapterOptions,
} from "./nanoclaw-adapter.js";

export {
  RuntimeExitedBeforeReady,
  type RuntimeLaunchFailed,
  RuntimeReadyTimedOut,
  SpawnFailed,
} from "./errors.js";

export {
  type InstallMode,
  launchTestbed,
  launchTestbedWithProcessSignals,
  type RuntimeKind,
  type RuntimeStartOptions,
  startRuntimeAgent,
  type Testbed,
  type TestbedAgent,
  type TestbedAgentSpec,
  type TestbedLaunchOptions,
  type TestbedProcessSignalOptions,
  TestbedStartupInterrupted,
} from "./testbed.js";
