import { AgentName as agentName } from "@moltzap/identity";
import { Schema } from "effect";
import { EventCatalog } from "./catalog.js";

/** The run ledger is allocated and run-scoped acquisition has begun. */
export class RunStarted extends Schema.TaggedClass<RunStarted>()(
  "moltzap.run-started/v1",
  {
    definitionId: Schema.NonEmptyString,
  },
) {}

/** A roster runtime completed acquisition and readiness. */
export class AgentRuntimeReady extends Schema.TaggedClass<AgentRuntimeReady>()(
  "moltzap.agent-runtime-ready/v1",
  {
    agentName: agentName,
    runtime: Schema.NonEmptyString,
  },
) {}

/** A roster runtime failed before it established readiness. */
export class AgentRuntimeStartFailed extends Schema.TaggedClass<AgentRuntimeStartFailed>()(
  "moltzap.agent-runtime-start-failed/v1",
  {
    agentName: agentName,
    runtime: Schema.NonEmptyString,
    cause: Schema.NonEmptyString,
  },
) {}

/** An autonomous runtime completed normally. */
export class AgentRuntimeCompleted extends Schema.TaggedClass<AgentRuntimeCompleted>()(
  "moltzap.agent-runtime-completed/v1",
  {
    agentName: agentName,
    runtime: Schema.NonEmptyString,
  },
) {}

/** An autonomous runtime completed with a recorded failure. */
export class AgentRuntimeFailed extends Schema.TaggedClass<AgentRuntimeFailed>()(
  "moltzap.agent-runtime-failed/v1",
  {
    agentName: agentName,
    runtime: Schema.NonEmptyString,
    cause: Schema.NonEmptyString,
  },
) {}

/** A roster runtime process terminated with an operating-system exit code. */
export class AgentProcessExited extends Schema.TaggedClass<AgentProcessExited>()(
  "moltzap.agent-process-exited/v1",
  {
    agentName: agentName,
    runtime: Schema.NonEmptyString,
    code: Schema.NonNegativeInt,
  },
) {}

/** A roster runtime process terminated because it received a signal. */
export class AgentProcessSignaled extends Schema.TaggedClass<AgentProcessSignaled>()(
  "moltzap.agent-process-signaled/v1",
  {
    agentName: agentName,
    runtime: Schema.NonEmptyString,
    signal: Schema.NonEmptyString,
  },
) {}

/** The customer program returned successfully. */
export class ProgramSucceeded extends Schema.TaggedClass<ProgramSucceeded>()(
  "moltzap.program-succeeded/v1",
  {},
) {}

/** The customer program failed with a typed failure or defect. */
export class ProgramFailed extends Schema.TaggedClass<ProgramFailed>()(
  "moltzap.program-failed/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}

/** The customer program was interrupted. */
export class ProgramInterrupted extends Schema.TaggedClass<ProgramInterrupted>()(
  "moltzap.program-interrupted/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}

/** Run lifecycle events emitted by the run kernel. */
export const runEvents = EventCatalog.make(
  RunStarted,
  ProgramSucceeded,
  ProgramFailed,
  ProgramInterrupted,
);

/** Runtime lifecycle events emitted by the roster supervisor. */
export const runtimeEvents = EventCatalog.make(
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentProcessExited,
  AgentProcessSignaled,
);

/** The exact event classes readable from every simulator run ledger. */
export const coreEvents = EventCatalog.merge(runEvents, runtimeEvents);
