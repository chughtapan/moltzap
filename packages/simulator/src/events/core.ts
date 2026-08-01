import { conversationId, messageId } from "@moltzap/protocol/conversation";
import { agentId, agentName } from "@moltzap/protocol/identity";
import { messagePartsSchema } from "@moltzap/protocol/message";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import { Schema } from "effect";
import { EventCatalog } from "./catalog.js";
import { CommittedRouterMessage } from "../network/router.js";

const messageParts = messagePartsSchema();

/** The run ledger is allocated and run-scoped acquisition has begun. */
export class RunStarted extends Schema.TaggedClass<RunStarted>()(
  "moltzap.run-started/v1",
  {
    definitionId: Schema.NonEmptyString,
  },
) {}

/** The run-scoped router is accepting participant connections. */
export class RouterStarted extends Schema.TaggedClass<RouterStarted>()(
  "moltzap.router-started/v1",
  {
    routerUrl: serverBaseUrlSchema,
  },
) {}

/** Router acquisition failed before the data plane became available. */
export class RouterStartFailed extends Schema.TaggedClass<RouterStartFailed>()(
  "moltzap.router-start-failed/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}

/** Router release or stopped-router evidence collection failed. */
export class RouterStopFailed extends Schema.TaggedClass<RouterStopFailed>()(
  "moltzap.router-stop-failed/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}

/** A roster runtime has acquired its identity and completed readiness. */
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

/** A participant allocated a conversation address for a nonempty group. */
export class ConversationOpened extends Schema.TaggedClass<ConversationOpened>()(
  "moltzap.conversation-opened/v1",
  {
    openedBy: agentId,
    conversationId: conversationId,
    participants: Schema.NonEmptyArray(agentId),
  },
) {}

/** A controlled endpoint committed a message through the data plane. */
export class EndpointMessageSent extends Schema.TaggedClass<EndpointMessageSent>()(
  "moltzap.endpoint-message-sent/v1",
  {
    endpointId: agentId,
    conversationId: conversationId,
    messageId: messageId,
    parts: messageParts,
  },
) {}

/** A controlled endpoint received a message through the data plane. */
export class EndpointMessageReceived extends Schema.TaggedClass<EndpointMessageReceived>()(
  "moltzap.endpoint-message-received/v1",
  {
    endpointId: agentId,
    conversationId: conversationId,
    messageId: messageId,
    senderId: agentId,
    parts: messageParts,
  },
) {}

/**
 * The router durably committed one message. Payload content remains an
 * endpoint concern so this evidence also works with content-blind routers.
 */
export class RouterMessageCommitted extends Schema.TaggedClass<RouterMessageCommitted>()(
  "moltzap.router-message-committed/v1",
  {
    ...CommittedRouterMessage.fields,
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

/** An active link policy discarded one committed message before delivery. */
export class LinkMessageDropped extends Schema.TaggedClass<LinkMessageDropped>()(
  "moltzap.link-message-dropped/v1",
  {
    from: agentId,
    to: agentId,
    conversationId: conversationId,
    messageId: messageId,
    reason: Schema.optional(Schema.String),
  },
) {}

/** Active link policies deferred one delivery by a known total duration. */
export class LinkMessageDelayed extends Schema.TaggedClass<LinkMessageDelayed>()(
  "moltzap.link-message-delayed/v1",
  {
    from: agentId,
    to: agentId,
    conversationId: conversationId,
    messageId: messageId,
    delayMillis: Schema.NonNegative,
  },
) {}

/** An active link policy parked one delivery until its lease clears. */
export class LinkMessageHeld extends Schema.TaggedClass<LinkMessageHeld>()(
  "moltzap.link-message-held/v1",
  {
    from: agentId,
    to: agentId,
    conversationId: conversationId,
    messageId: messageId,
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

/** Router events emitted by the run-scoped router integration. */
export const routerEvents = EventCatalog.make(
  RouterStarted,
  RouterStartFailed,
  RouterStopFailed,
  RouterMessageCommitted,
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

/** Data-plane events emitted by controlled endpoint operations. */
export const endpointEvents = EventCatalog.make(
  ConversationOpened,
  EndpointMessageSent,
  EndpointMessageReceived,
);

/** Directed-link state and delivery events emitted by link control. */
export const linkEvents = EventCatalog.make(
  LinkDown,
  LinkUp,
  LinkPolicySet,
  LinkPolicyCleared,
  LinkMessageDropped,
  LinkMessageDelayed,
  LinkMessageHeld,
);

/** The exact event classes readable from every simulator run ledger. */
export const coreEvents = EventCatalog.merge(
  runEvents,
  routerEvents,
  runtimeEvents,
  endpointEvents,
  linkEvents,
);
