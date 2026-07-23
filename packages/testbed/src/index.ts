/**
 * @file Public exports for launching and supervising connected-agent testbeds.
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
  type OpenClawAdapterOptions,
  OpenClawAdapter,
  createOpenClawAdapter,
} from "./openclaw-adapter.js";

export {
  type NanoclawAdapterOptions,
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
  type TestbedAgentSpec,
  type Testbed,
  type TestbedAgent,
  type TestbedLaunchOptions,
  type TestbedProcessSignalOptions,
  type RuntimeStartOptions,
  TestbedStartupInterrupted,
  startRuntimeAgent,
  launchTestbed,
  launchTestbedWithProcessSignals,
} from "./testbed.js";
