import { Option, Schema } from "effect";
import type { HarnessPayload } from "./trace-capture-payload.js";
import { AgentId } from "@moltzap/protocol/identity";
import type { SimulatorEvent } from "./simulator/index.js";

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

interface ConversationParticipant {
  readonly id: AgentId;
  readonly name: string;
  readonly role: string;
}

interface ConversationResponse {
  readonly conversationId: string;
  readonly senderId: AgentId;
  readonly text: string;
  readonly messageId: string;
}

export interface ConversationRun {
  readonly participants: ReadonlyArray<ConversationParticipant>;
  readonly responses: ReadonlyArray<ConversationResponse>;
}

/** Who spoke, what came back, and the message timeline, read off one recording. */
export interface RecordedConversation {
  readonly targetAgentId: AgentId;
  readonly participants: ReadonlyArray<ConversationParticipant>;
  readonly responses: ReadonlyArray<ConversationResponse>;
  readonly traceEvents: ReadonlyArray<TraceCaptureEvent>;
}

type TranscriptRow = Extract<
  SimulatorEvent,
  { readonly _tag: "transcript.message" }
>;

/** One recorded message with its sender decoded to the protocol identity. */
type AttributedRow = {
  readonly row: TranscriptRow;
  readonly senderId: AgentId;
};

const decodeAgentId = Schema.decodeUnknownOption(AgentId);

/**
 * Project a sealed recording's events onto the bundle shape cc-judge
 * grades. Sender attribution is the event-log join the recording is
 * built for: `agent.ready` carries the slot's authenticated agent id,
 * and every transcript row carries the sender id it maps to. Any sender
 * that is not a ready slot is the principal, the only other identity a
 * v0 run mints.
 *
 * `undefined` means the recording cannot be attributed — no ready event
 * for the target slot, or an id that is not a protocol agent id. A
 * partial attribution would read to a grader as a short conversation
 * rather than as a broken recording.
 */
export function projectRecordedConversation(input: {
  readonly events: ReadonlyArray<SimulatorEvent>;
  readonly targetSlot: string;
  readonly principalName: string;
}): RecordedConversation | undefined {
  const slots = new Map<string, AgentId>();
  for (const event of input.events) {
    if (event._tag !== "agent.ready") continue;
    const agentId = Option.getOrUndefined(decodeAgentId(event.agentId));
    if (agentId === undefined) return undefined;
    slots.set(event.agent, agentId);
  }
  const targetAgentId = slots.get(input.targetSlot);
  if (targetAgentId === undefined) return undefined;

  const rows = attributedRows(input.events);
  if (rows === undefined) return undefined;

  const principals = principalSenders(rows, new Set(slots.values()));
  const namesById = displayNames(slots, principals, input.principalName);

  return {
    targetAgentId,
    participants: principals.map((id) => ({
      id,
      name: namesById.get(id) ?? id,
      role: "sender",
    })),
    responses: rows
      .filter((entry) => entry.senderId === targetAgentId)
      .map(toConversationResponse),
    traceEvents: rows.map((entry) => toTraceCaptureEvent(entry, namesById)),
  };
}

/** Senders that are not a ready slot: the principals of this run, first-seen order. */
function principalSenders(
  rows: ReadonlyArray<AttributedRow>,
  slotIds: ReadonlySet<string>,
): ReadonlyArray<AgentId> {
  const seen = new Map<string, AgentId>();
  for (const entry of rows) {
    if (slotIds.has(entry.senderId)) continue;
    seen.set(entry.senderId, entry.senderId);
  }
  return [...seen.values()];
}

function displayNames(
  slots: ReadonlyMap<string, AgentId>,
  principals: ReadonlyArray<AgentId>,
  principalName: string,
): ReadonlyMap<string, string> {
  return new Map<string, string>([
    ...[...slots].map(([slot, id]): readonly [string, string] => [id, slot]),
    ...principals.map((id, index): readonly [string, string] => [
      id,
      principals.length === 1
        ? principalName
        : `${principalName}-${String(index + 1)}`,
    ]),
  ]);
}

function attributedRows(
  events: ReadonlyArray<SimulatorEvent>,
): ReadonlyArray<AttributedRow> | undefined {
  const attributed: Array<AttributedRow> = [];
  for (const event of events) {
    if (event._tag !== "transcript.message") continue;
    const senderId = Option.getOrUndefined(decodeAgentId(event.senderId));
    if (senderId === undefined) return undefined;
    attributed.push({ row: event, senderId });
  }
  return attributed;
}

/**
 * The recorded wire message, decoded rather than asserted: the event's
 * `message` is JSON from disk, so the fields this bundle reads are
 * checked here and a body that carries neither survives as an empty
 * message instead of a shape error mid-projection.
 */
const RecordedMessageBody = Schema.Struct({
  id: Schema.optionalWith(Schema.String, { default: () => "" }),
  parts: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
    { default: () => [] },
  ),
});

function messageBody(row: TranscriptRow): {
  readonly id: string;
  readonly parts: ReadonlyArray<MessagePart>;
} {
  return Option.getOrElse(
    Schema.decodeUnknownOption(RecordedMessageBody)(row.message),
    () => ({ id: "", parts: [] as ReadonlyArray<MessagePart> }),
  );
}

function toConversationResponse(entry: AttributedRow): ConversationResponse {
  const body = messageBody(entry.row);
  return {
    conversationId: entry.row.conversationId,
    senderId: entry.senderId,
    text: eventText(body.parts),
    messageId: body.id,
  };
}

function toTraceCaptureEvent(
  entry: AttributedRow,
  namesById: ReadonlyMap<string, string>,
): TraceCaptureEvent {
  const body = messageBody(entry.row);
  return {
    _tag: "Message",
    channelKey: entry.row.conversationId,
    senderDisplayName: namesById.get(entry.senderId) ?? entry.senderId,
    message: {
      senderId: entry.senderId,
      conversationId: entry.row.conversationId,
      id: body.id,
      createdAt: new Date(entry.row.createdAtWallTime).toISOString(),
      parts: body.parts,
    },
    // Storage holds no per-recipient delivery set; delivery evidence
    // lives in the recording's `moltzap.message.delivered` spans, so the
    // bundle names no recipient rather than guessing one.
    recipientAgentIds: [],
  };
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
