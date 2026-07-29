/** @file Conversion of Effect/runtime outcomes into exact ledger events. */

import type { AgentName } from "@moltzap/protocol/identity";
import { Cause, Exit } from "effect";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  ProgramFailed,
  ProgramInterrupted,
  ProgramSucceeded,
} from "../events/core.js";
import type { AgentConnection } from "../network/router.js";
import type { RuntimeTermination } from "../runtime/runtime.js";

export interface RuntimeEvidenceInput {
  readonly name: string;
  readonly agentName: AgentName;
  readonly runtimeName: string;
  readonly connection: AgentConnection;
}

export function nonEmptyCause(cause: Cause.Cause<unknown>): string {
  const rendered = Cause.pretty(cause).trim();
  return rendered.length === 0 ? "unknown failure" : rendered;
}

export function runtimeEvent(
  acquired: RuntimeEvidenceInput,
  termination: RuntimeTermination,
) {
  const common = {
    agentName: acquired.agentName,
    agentId: acquired.connection.agent.id,
    runtime: acquired.runtimeName,
  };
  switch (termination._tag) {
    case "RuntimeCompleted":
      return AgentRuntimeCompleted.make(common);
    case "RuntimeFailed":
      return AgentRuntimeFailed.make({
        ...common,
        cause:
          termination.detail.length === 0
            ? "runtime failed without detail"
            : termination.detail,
      });
    case "RuntimeExited":
      return AgentProcessExited.make({
        ...common,
        code: termination.code,
      });
    case "RuntimeSignaled":
      return AgentProcessSignaled.make({
        ...common,
        signal: termination.signal,
      });
  }
}

export function programEvent<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) {
    return ProgramSucceeded.make();
  }
  return Cause.isInterruptedOnly(exit.cause)
    ? ProgramInterrupted.make({
        cause: nonEmptyCause(exit.cause),
      })
    : ProgramFailed.make({
        cause: nonEmptyCause(exit.cause),
      });
}

export function combinedFailure(
  exits: ReadonlyArray<Exit.Exit<unknown, unknown>>,
): Cause.Cause<unknown> | undefined {
  let combined: Cause.Cause<unknown> | undefined;
  for (const exit of exits) {
    if (Exit.isFailure(exit)) {
      combined =
        combined === undefined
          ? exit.cause
          : Cause.sequential(combined, exit.cause);
    }
  }
  return combined;
}
