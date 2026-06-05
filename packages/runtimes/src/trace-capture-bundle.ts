import type { HarnessPayload } from "./trace-capture-payload.js";
import type { AgentId } from "@moltzap/protocol/identity";

interface MessagePart {
  readonly type: string;
  readonly text?: string;
}

export interface TraceCaptureEvent {
  readonly _tag: "Message";
  readonly channelKey: string;
  readonly senderDisplayName: string;
  readonly message: {
    readonly senderId: AgentId;
    readonly conversationId: string;
    readonly id: string;
    readonly createdAt: string;
    readonly parts: ReadonlyArray<MessagePart>;
  };
  readonly recipientAgentIds: ReadonlyArray<AgentId>;
}

export interface ConversationParticipant {
  readonly id: AgentId;
  readonly name: string;
  readonly role: string;
}

export interface ConversationResponse {
  readonly conversationId: string;
  readonly senderId: AgentId;
  readonly text: string;
  readonly messageId: string;
}

export interface ConversationRun {
  readonly participants: ReadonlyArray<ConversationParticipant>;
  readonly responses: ReadonlyArray<ConversationResponse>;
}

export function buildTraceBundle(input: {
  readonly sourcePath: string;
  readonly plan: {
    readonly project: string;
    readonly scenarioId: string;
    readonly name: string;
    readonly description: string;
    readonly requirements: Readonly<Record<string, unknown>>;
  };
  readonly runId: string;
  readonly targetAgent: {
    readonly agentId: AgentId;
    readonly agentName: string;
  };
  readonly runtimeStartedAt: string;
  readonly traceEvents: readonly TraceCaptureEvent[];
  readonly conversationRun: ConversationRun;
  readonly payload: HarnessPayload;
}): Readonly<Record<string, unknown>> {
  const namesById = participantNames(input);
  const events = input.traceEvents.map((event) =>
    toBundleEvent(event, namesById),
  );
  const endedAt = new Date().toISOString();
  return {
    runId: input.runId,
    ...planMetadata(input.plan),
    agents: bundleAgents(input.targetAgent, input.conversationRun),
    ...(events.length > 0 ? { events } : {}),
    context: bundleContext(input.payload, input.conversationRun),
    outcomes: bundleOutcomes(input, endedAt),
    metadata: {
      modelName: `moltzap/${input.payload.runtime.kind}`,
      sourcePath: input.sourcePath,
    },
  };
}

function participantNames(input: {
  readonly targetAgent: {
    readonly agentId: AgentId;
    readonly agentName: string;
  };
  readonly conversationRun: ConversationRun;
}) {
  return new Map<string, string>([
    [input.targetAgent.agentId, input.targetAgent.agentName],
    ...input.conversationRun.participants.map(participantNameEntry),
  ]);
}

function planMetadata(plan: {
  readonly project: string;
  readonly scenarioId: string;
  readonly name: string;
  readonly description: string;
  readonly requirements: Readonly<Record<string, unknown>>;
}) {
  return {
    project: plan.project,
    scenarioId: plan.scenarioId,
    name: plan.name,
    description: plan.description,
    requirements: plan.requirements,
  };
}

function bundleAgents(
  targetAgent: { readonly agentId: AgentId; readonly agentName: string },
  conversationRun: ConversationRun,
) {
  return [
    {
      id: targetAgent.agentId,
      name: targetAgent.agentName,
      role: "target",
    },
    ...conversationRun.participants,
  ];
}

function bundleContext(
  payload: HarnessPayload,
  conversationRun: ConversationRun,
) {
  return {
    runtimeKind: payload.runtime.kind,
    conversationKind: payload.conversation.kind,
    responses: conversationRun.responses,
  };
}

function bundleOutcomes(
  input: {
    readonly targetAgent: { readonly agentId: AgentId };
    readonly runtimeStartedAt: string;
    readonly conversationRun: ConversationRun;
  },
  endedAt: string,
) {
  return [
    completedOutcome(
      input.targetAgent.agentId,
      input.runtimeStartedAt,
      endedAt,
    ),
    ...input.conversationRun.participants.map((participant) =>
      completedOutcome(participant.id, input.runtimeStartedAt, endedAt),
    ),
  ];
}

function completedOutcome(
  agentId: AgentId,
  startedAt: string,
  endedAt: string,
) {
  return {
    agentId,
    status: "completed",
    startedAt,
    endedAt,
  };
}

function participantNameEntry(participant: {
  readonly id: AgentId;
  readonly name: string;
}): readonly [string, string] {
  return [participant.id, participant.name];
}

function toBundleEvent(
  event: TraceCaptureEvent,
  namesById: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  return {
    type: "message",
    from: event.senderDisplayName,
    ...singleRecipientName(event, namesById),
    channel: event.channelKey,
    text: eventText(event.message.parts),
    ts: Date.parse(event.message.createdAt),
  };
}

function singleRecipientName(
  event: TraceCaptureEvent,
  namesById: ReadonlyMap<string, string>,
): { readonly to: string } | undefined {
  if (event.recipientAgentIds.length !== 1) {
    return undefined;
  }
  const recipientId = event.recipientAgentIds[0]!;
  return { to: namesById.get(recipientId) ?? recipientId };
}

function eventText(parts: ReadonlyArray<MessagePart>): string {
  return parts
    .filter(
      (part): part is MessagePart & { readonly text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}
