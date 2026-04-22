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
