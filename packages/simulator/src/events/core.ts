/** @file Closed simulator lifecycle event declarations and their subcatalogs. */

import { AgentId as agentId, AgentName as agentName } from "@moltzap/identity";
import { Schema } from "effect";
import { EventCatalog } from "./catalog.js";

/** The run ledger is allocated and run-scoped acquisition has begun. */
export class RunStarted extends Schema.TaggedClass<RunStarted>()(
  "moltzap.run-started/v1",
  {
    definitionId: Schema.NonEmptyString,
  },
) {}

/** The run-scoped Router is accepting participant connections. */
export class RouterStarted extends Schema.TaggedClass<RouterStarted>()(
  "moltzap.router-started/v1",
  {
    routerUrl: Schema.URL,
  },
) {}

/** Router acquisition failed before the data plane became available. */
export class RouterStartFailed extends Schema.TaggedClass<RouterStartFailed>()(
  "moltzap.router-start-failed/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}

/** Router release or stopped-Router evidence collection failed. */
export class RouterStopFailed extends Schema.TaggedClass<RouterStopFailed>()(
  "moltzap.router-stop-failed/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}

/** A roster runtime completed acquisition and readiness. */
export class AgentRuntimeReady extends Schema.TaggedClass<AgentRuntimeReady>()(
  "moltzap.agent-runtime-ready/v1",
  {
    agentName: agentName,
    agentId: agentId,
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
    agentId: agentId,
    runtime: Schema.NonEmptyString,
  },
) {}

/** An autonomous runtime completed with a recorded failure. */
export class AgentRuntimeFailed extends Schema.TaggedClass<AgentRuntimeFailed>()(
  "moltzap.agent-runtime-failed/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
    cause: Schema.NonEmptyString,
  },
) {}

/** A roster runtime process terminated with an operating-system exit code. */
export class AgentProcessExited extends Schema.TaggedClass<AgentProcessExited>()(
  "moltzap.agent-process-exited/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
    code: Schema.NonNegativeInt,
  },
) {}

/** A roster runtime process terminated because it received a signal. */
export class AgentProcessSignaled extends Schema.TaggedClass<AgentProcessSignaled>()(
  "moltzap.agent-process-signaled/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
    signal: Schema.NonEmptyString,
  },
) {}

/** Every way one harvest target resolves when the live application is read. */
const harvestedFileOutcome = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("text"),
    content: Schema.String,
    byteLength: Schema.NonNegativeInt,
  }),
  Schema.Struct({
    _tag: Schema.Literal("oversize"),
    byteLength: Schema.NonNegativeInt,
    limitBytes: Schema.NonNegativeInt,
  }),
  Schema.Struct({ _tag: Schema.Literal("absent") }),
  Schema.Struct({
    _tag: Schema.Literal("unreadable"),
    cause: Schema.NonEmptyString,
  }),
);

/** Decoded outcome of reading one harvest target. */
export type HarvestedFileOutcome = typeof harvestedFileOutcome.Type;

/**
 * One workspace file read back from a live application after the customer
 * program ended. `relativePath` is the experiment's own name for the file, or
 * the runtime's label for a file it harvests on the experiment's behalf.
 */
export class AgentWorkspaceFileHarvested extends Schema.TaggedClass<AgentWorkspaceFileHarvested>()(
  "moltzap.agent-workspace-file/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
    relativePath: Schema.NonEmptyString,
    outcome: harvestedFileOutcome,
  },
) {}

/** A directed participant link transitioned from available to unavailable. */
export class LinkDown extends Schema.TaggedClass<LinkDown>()(
  "moltzap.link-down/v1",
  {
    from: agentId,
    to: agentId,
  },
) {}

/** A directed participant link transitioned from unavailable to available. */
export class LinkUp extends Schema.TaggedClass<LinkUp>()("moltzap.link-up/v1", {
  from: agentId,
  to: agentId,
}) {}

/** A described policy became active on one directed participant link. */
export class LinkPolicySet extends Schema.TaggedClass<LinkPolicySet>()(
  "moltzap.link-policy-set/v1",
  {
    from: agentId,
    to: agentId,
    policy: Schema.NonEmptyString,
  },
) {}

/** A described policy stopped shaping one directed participant link. */
export class LinkPolicyCleared extends Schema.TaggedClass<LinkPolicyCleared>()(
  "moltzap.link-policy-cleared/v1",
  {
    from: agentId,
    to: agentId,
    policy: Schema.NonEmptyString,
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

/** Router lifecycle events emitted by the run-scoped Router integration. */
export const routerEvents = EventCatalog.make(
  RouterStarted,
  RouterStartFailed,
  RouterStopFailed,
);

/** Runtime lifecycle events emitted by the roster supervisor. */
export const runtimeEvents = EventCatalog.make(
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentProcessExited,
  AgentProcessSignaled,
  AgentWorkspaceFileHarvested,
);

/** Directed-link state events emitted by link control. */
export const linkEvents = EventCatalog.make(
  LinkDown,
  LinkUp,
  LinkPolicySet,
  LinkPolicyCleared,
);

/** The exact event classes readable from every simulator run ledger. */
export const coreEvents = EventCatalog.merge(
  runEvents,
  routerEvents,
  runtimeEvents,
  linkEvents,
);
