/**
 * Telemetry event schema for MoltZap platform observability.
 *
 * Single discriminated union covering message lifecycle, dispatch timing,
 * queue depth, connection state, and RPC errors. Each event carries:
 *   - schemaVersion: additive-only field compatibility marker
 *   - ts: milliseconds since epoch
 *   - source: which side of the connection emitted it
 *
 * Rule: new fields MUST be optional until schemaVersion bumps to "2".
 * This keeps every moltzap app consuming `@moltzap/observability` forward-compatible.
 */

export const SCHEMA_VERSION = "1" as const;

interface BaseEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  ts: number;
}

export interface AgentConnectedEvent extends BaseEvent {
  event: "agent.connected";
  source: "server";
  agentId: string;
}

export interface AgentDisconnectedEvent extends BaseEvent {
  event: "agent.disconnected";
  source: "server";
  agentId: string;
}

export interface ConversationCreatedEvent extends BaseEvent {
  event: "conversation.created";
  source: "server";
  convId: string;
  type: "dm" | "group";
  participantIds: string[];
}

export interface MessageSentEvent extends BaseEvent {
  event: "message.sent";
  source: "server";
  msgId: string;
  convId: string;
  senderAgentId: string;
  senderKind: "agent" | "user";
  chars: number;
}

export interface MessageReceivedEvent extends BaseEvent {
  event: "message.received";
  source: "server";
  msgId: string;
  convId: string;
  senderAgentId: string;
  chars: number;
}

export type RpcErrorReason =
  | "method_not_found"
  | "invalid_params"
  | "forbidden_pending_claim"
  | "forbidden_no_active_agent"
  | "handler_rejected"
  | "handler_error";

export interface RpcErrorEvent extends BaseEvent {
  event: "rpc.error";
  source: "server";
  method: string;
  code: number;
  message: string;
  /**
   * Categorizes WHY the RPC failed. Lets rollup separate expected transient
   * conditions (e.g. pending_claim during onboarding) from real failures.
   */
  reason: RpcErrorReason;
  agentId?: string;
  connId?: string;
}

export interface InboundReceivedEvent extends BaseEvent {
  event: "inbound.received";
  source: "agent";
  msgId: string;
  convId: string;
  senderAgentId: string;
  agentId: string;
  chars: number;
}

export interface DispatchStartEvent extends BaseEvent {
  event: "dispatch.start";
  source: "agent";
  msgId: string;
  convId: string;
  agentId: string;
  queueDepth: number;
  inflight: number;
}

export interface DispatchCompleteEvent extends BaseEvent {
  event: "dispatch.complete";
  source: "agent";
  msgId: string;
  convId: string;
  agentId: string;
  durationMs: number;
  outcome: "final" | "skipped" | "error";
  errorReason?: string;
}

export interface OutboundSentEvent extends BaseEvent {
  event: "outbound.sent";
  source: "agent";
  msgId: string;
  replyToMsgId?: string;
  convId: string;
  agentId: string;
  chars: number;
}

export interface QueueStatsEvent extends BaseEvent {
  event: "queue.stats";
  source: "agent";
  agentId: string;
  depth: number;
  inflight: number;
  oldestQueuedAgeMs?: number;
}

export interface ConnectionDisconnectEvent extends BaseEvent {
  event: "connection.disconnect";
  source: "agent";
  agentId: string;
  reason?: string;
}

export interface ConnectionReconnectEvent extends BaseEvent {
  event: "connection.reconnect";
  source: "agent";
  agentId: string;
  attemptN: number;
}

export type TelemetryEvent =
  | AgentConnectedEvent
  | AgentDisconnectedEvent
  | ConversationCreatedEvent
  | MessageSentEvent
  | MessageReceivedEvent
  | RpcErrorEvent
  | InboundReceivedEvent
  | DispatchStartEvent
  | DispatchCompleteEvent
  | OutboundSentEvent
  | QueueStatsEvent
  | ConnectionDisconnectEvent
  | ConnectionReconnectEvent;

export type TelemetryHandler = (event: TelemetryEvent) => void;
