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

export class ProcessExitedEarly extends Error {
  readonly _tag = "ProcessExitedEarly" as const;
  constructor(
    readonly agentName: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`Agent "${agentName}" exited early with code ${String(exitCode)}`);
  }
}
