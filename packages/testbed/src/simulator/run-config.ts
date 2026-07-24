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
import type {
  AgentSlotName,
  ImageDigest,
  MaterializedRunSpec,
} from "./run-spec.js";
import type { EventLogHandle } from "./event-log.js";
import type { EnvironmentMount } from "./environment-mount.js";
import type { WorldDriver } from "./world-driver.js";
import type {
  AgentLaunchFailed,
  LoggingProxyFailed,
  MountFailed,
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
export type ServerContainerHandle = {
  readonly imageDigest: ImageDigest;
  /** Direct server URL; agents connect through their per-agent proxied URLs instead. */
  readonly serverUrl: ServerUrl;
};

/** One launched slot: its runtime handle and the proxied URL it connects through. */
export type LaunchedAgent = {
  readonly slot: AgentSlotName;
  readonly agentId: AgentId;
  readonly runtime: SimulatorRuntime;
  readonly serverUrl: ServerUrl;
};

/** Everything launch brings up; released in reverse order at scope close. */
export type LaunchedWorld = {
  readonly server: ServerContainerHandle;
  readonly agents: ReadonlyArray<LaunchedAgent>;
};

// ---------------------------------------------------------------------------
// Agent-runner contract
// ---------------------------------------------------------------------------

/** Collaborators launch wires per slot: mounts, per-agent endpoints, and the event log. */
export type LaunchDeps = {
  readonly mounts: EnvironmentMount;
  readonly world: WorldDriver;
  readonly log: EventLogHandle;
};

/**
 * Launch contract: bring up the server container, allocate each slot's
 * proxied endpoint, prepare mounts, spawn runtimes, and await readiness
 * — collection in, addressable collection out. Partial multi-agent
 * launch tears down already-started members in reverse order and fails
 * with the failing slot's error; teardown of the returned world runs at
 * scope close and never fails (incomplete reversal is evented and lands
 * in `result.json.teardownComplete`).
 */
export interface AgentRunner {
  launch(
    spec: MaterializedRunSpec,
    deps: LaunchDeps,
  ): Effect.Effect<
    LaunchedWorld,
    ServerLaunchFailed | AgentLaunchFailed | MountFailed | LoggingProxyFailed,
    Scope.Scope
  >;
}

/** Create the v0 agent runner (Docker server container + shipped adapters + StubRuntime). */
export function makeAgentRunner(): AgentRunner {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}
