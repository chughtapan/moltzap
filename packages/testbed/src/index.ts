/**
 * @file Public exports for launching and supervising connected-agent testbeds.
 */
// safer-arch-ignore no-folder-cycle: the simulator folder builds on the root's runtime adapters, and the cc-judge compat adapter has to stay at its published root path while executing on the simulator (chughtapan/moltzap#812 §2, "Trace-capture fold"); the direction of knowledge is one-way per file, and the entry-point path is a protected surface.
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
  type InstallMode,
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
