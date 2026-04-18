/**
 * @moltzap/observability
 *
 * Platform-wide telemetry for MoltZap. See README for event catalog and
 * integration patterns.
 */

export { telemetry } from "./telemetry.js";
export { TelemetryCollector } from "./collector.js";
export { computeMetrics, rollupFromFile, type Metrics } from "./rollup.js";
export {
  SCHEMA_VERSION,
  type TelemetryEvent,
  type TelemetryHandler,
  type AgentConnectedEvent,
  type AgentDisconnectedEvent,
  type ConversationCreatedEvent,
  type MessageSentEvent,
  type MessageReceivedEvent,
  type RpcErrorEvent,
  type RpcErrorReason,
  type InboundReceivedEvent,
  type DispatchStartEvent,
  type DispatchCompleteEvent,
  type OutboundSentEvent,
  type QueueStatsEvent,
  type ConnectionDisconnectEvent,
  type ConnectionReconnectEvent,
} from "./events.js";
