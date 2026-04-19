import type * as Effect from "effect/Effect";

// Tagged error classes for the Runtime interface.
// Each names the failure mode and carries the data the CLI needs to print.

export class SpawnFailed {
  readonly _tag = "SpawnFailed" as const;
  constructor(
    readonly agentName: string,
    readonly cause: Error,
  ) {}
}

export class ProcessExitedEarly {
  readonly _tag = "ProcessExitedEarly" as const;
  constructor(
    readonly agentName: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {}
}
