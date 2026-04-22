// Tagged error classes for the Runtime interface.
// Each names the failure mode and carries the data the CLI needs to print.

export class SpawnFailed extends Error {
  readonly _tag = "SpawnFailed" as const;
  constructor(
    readonly agentName: string,
    override readonly cause: Error,
  ) {
    super(`Failed to spawn agent "${agentName}": ${cause.message}`, { cause });
  }
}

export class RuntimeReadyTimedOut extends Error {
  readonly _tag = "RuntimeReadyTimedOut" as const;
  constructor(
    readonly agentName: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Runtime for agent "${agentName}" did not become ready within ${String(timeoutMs)}ms`,
    );
  }
}

export class RuntimeExitedBeforeReady extends Error {
  readonly _tag = "RuntimeExitedBeforeReady" as const;
  constructor(
    readonly agentName: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `Runtime for agent "${agentName}" exited before readiness (exitCode=${String(exitCode)})`,
    );
  }
}

export type RuntimeLaunchFailed =
  | SpawnFailed
  | RuntimeReadyTimedOut
  | RuntimeExitedBeforeReady;
