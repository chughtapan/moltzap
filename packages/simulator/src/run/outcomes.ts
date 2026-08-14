/** @file Conversion of Effect/runtime outcomes into exact ledger events. */

import type { AgentId, AgentName } from "@moltzap/identity";
import { Cause, Exit } from "effect";
import type { RuntimeTermination } from "../agents/index.js";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  ProgramFailed,
  ProgramInterrupted,
  ProgramSucceeded,
} from "../events/core.js";

// safer-arch-ignore no-cross-domain-sibling-import: Converts Effect and runtime outcomes into ledger events, so it names both domains.

/** Describes runtime evidence input. */
export interface RuntimeEvidenceInput {
  readonly agentName: AgentName;
  readonly agentId: AgentId;
  readonly runtimeName: string;
}

/**
 * Runs time event.
 * @param acquired Stable runtime identity observed at acquisition.
 * @param termination Terminal runtime result to project into evidence.
 * @returns The runtime event result.
 */
export function runtimeEvent(
  acquired: RuntimeEvidenceInput,
  termination: RuntimeTermination,
) {
  const common = {
    agentName: acquired.agentName,
    agentId: acquired.agentId,
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
    default:
      return AgentRuntimeFailed.make({
        ...common,
        cause: "unknown runtime termination",
      });
  }
}

/**
 * Executes the program event operation.
 * @param exit Customer program success, failure, or interruption.
 * @returns The program event result.
 */
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

/**
 * Executes the non empty cause operation.
 * @param cause Failure cause to inspect.
 * @returns The non empty cause result.
 */
export function nonEmptyCause(cause: Cause.Cause<unknown>): string {
  const rendered = Cause.pretty(cause).trim();
  return rendered.length === 0 ? "unknown failure" : rendered;
}
