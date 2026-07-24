/**
 * @file RunConfig / agent-runner (contract 1, launch half): runtime
 * assignment and launch of the heterogeneous agent collection plus the
 * per-run server container. The existing `Runtime` interface is part of
 * this contract's surface; `SimulatorRuntime` adds the ongoing
 * exit/status signal without changing the existing export (additive-only
 * until consumer ladder rung 2).
 */
import type { Effect, Scope } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { Runtime, ServerUrl } from "../runtime.js";
import type { AgentFacingRunSpec, SlotName, ImageDigest } from "./run-spec.js";
import type { EventLog, ServerStorageAccess } from "./event-log.js";
import type { Mounts, MountHandle } from "./mounts.js";
import type { World } from "./world.js";
import type { Secrets } from "./recording.js";
import type {
  AgentLaunchFailed,
  LoggingProxyFailed,
  MountFailed,
  ProvisioningFailed,
  ServerLaunchFailed,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Runtime surface extension
// ---------------------------------------------------------------------------

/** Terminal process status observed for a runtime. */
export type RuntimeExit = {
  readonly exitCode: number | null;
  /** Signal name when the process died from a signal; exitCode is null in that case. */
  readonly signal: string | undefined;
};

/**
 * The simulator's runtime contract: the existing `Runtime` plus an
 * ongoing exit signal the episode lifecycle consumes for its
 * on-agent-crash policy. Both shipped adapters and StubRuntime implement
 * it; StubRuntime doubles as the reference implementation.
 */
export interface SimulatorRuntime extends Runtime {
  /** Resolves exactly once, when the runtime's OS process exits. */
  awaitExit(): Effect.Effect<RuntimeExit, never, never>;
}

// ---------------------------------------------------------------------------
// Launched world
// ---------------------------------------------------------------------------

/** The per-run server container (one run, one world). */
export type ServerHandle = {
  readonly imageDigest: ImageDigest;
  /** Direct server URL; agents connect through their per-agent proxied URLs instead. */
  readonly serverUrl: ServerUrl;
  /** This run's storage volume; the transcript drain reads it and nothing else. */
  readonly storage: ServerStorageAccess;
};

/** One launched slot: its runtime handle and the proxied URL it connects through. */
export type LaunchedAgent = {
  readonly slot: SlotName;
  readonly agentId: AgentId;
  readonly runtime: SimulatorRuntime;
  readonly serverUrl: ServerUrl;
};

/** What reverse teardown reports; incompleteness is evented and lands in `result.json.teardownComplete`. */
export type TeardownReport = {
  readonly complete: boolean;
  readonly failures: ReadonlyArray<string>;
};

/**
 * Everything launch brings up. `mounts` aggregates every slot's
 * `MountHandle`, so `run` can race each proxy-health channel
 * against episode termination. `run` calls `teardown` explicitly
 * during shutdown, before the event log seals, so the teardown report is
 * evented and recorded; scope close re-runs it as an idempotent backstop
 * for abnormal exits.
 */
export type Society = {
  readonly server: ServerHandle;
  readonly agents: ReadonlyArray<LaunchedAgent>;
  readonly mounts: ReadonlyArray<MountHandle>;
  teardown(): Effect.Effect<TeardownReport, never, never>;
};

// ---------------------------------------------------------------------------
// Agent-runner contract
// ---------------------------------------------------------------------------

/** Collaborators launch wires per slot: mounts, per-agent endpoints, the event log, and the secret registry. */
export type LaunchDeps = {
  readonly mounts: Mounts;
  readonly world: World;
  readonly log: EventLog;
  readonly secrets: Secrets;
};

/**
 * Launch contract: bring up the server container, provision per-run
 * identities (agent registrations and the observer credential against
 * the fresh server, every minted credential registered in `deps.secrets`
 * before any process spawns), allocate each slot's proxied endpoint,
 * prepare mounts, spawn runtimes, and await readiness — collection in,
 * addressable collection out. The spec arrives condition-stripped
 * (`AgentFacingRunSpec`), so treatment labels cannot reach launch-derived
 * channels. Partial multi-agent launch tears down already-started members
 * in reverse order and fails with the failing slot's error.
 */
export interface Launcher {
  launch(
    spec: AgentFacingRunSpec,
    deps: LaunchDeps,
  ): Effect.Effect<
    Society,
    | ServerLaunchFailed
    | ProvisioningFailed
    | AgentLaunchFailed
    | MountFailed
    | LoggingProxyFailed,
    Scope.Scope
  >;
}

/** Create the v0 agent runner (Docker server container + shipped adapters + StubRuntime). */
export function makeLauncher(): Launcher {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}
