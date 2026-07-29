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

/** Describes runtime evidence input. */
export interface RuntimeEvidenceInput {
  readonly name: string;
  readonly agentName: AgentName;
  readonly runtimeName: string;
  readonly connection: AgentConnection;
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

/**
 * Runs time event.
 * @param acquired Value supplied to the operation.
 * @param termination Value supplied to the operation.
 * @returns The runtime event result.
 */
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
    default:
      return AgentRuntimeFailed.make({
        ...common,
        cause: "unknown runtime termination",
      });
  }
}

/**
 * Executes the program event operation.
 * @param exit Value supplied to the operation.
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
