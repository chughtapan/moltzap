/**
 * Module-level telemetry singleton.
 *
 * Every instrumentation site across server-core, client, channel plugins, and
 * consumer apps calls telemetry.emit(event). The helper fans out to two sinks:
 *   1. pino (if configured) - structured JSON log line
 *   2. subscribers (if any) - synchronous in-process callbacks
 *
 * Design notes:
 *   - Both sinks are wrapped in try/catch. Observability failures must NEVER
 *     crash the caller.
 *   - enabled:false is a full no-op (intended for MOLTZAP_TELEMETRY_ENABLED=false).
 *   - reset() is for test isolation. Apps call configure() once at startup.
 *   - Singleton is module-scoped. In vitest fork/thread pools, each worker
 *     gets its own copy. Within a worker, tests must call reset() in afterEach
 *     (see @moltzap/observability/test-utils for a shared helper).
 */

import type { Logger } from "pino";
import type { TelemetryEvent, TelemetryHandler } from "./events.js";

interface TelemetryState {
  logger: Logger | null;
  enabled: boolean;
  subscribers: Set<TelemetryHandler>;
}

const state: TelemetryState = {
  logger: null,
  enabled: false,
  subscribers: new Set(),
};

function safeInvokeLogger(event: TelemetryEvent): void {
  if (!state.logger) return;
  try {
    state.logger.info(event, event.event);
  } catch {
    // Observability must never crash the caller. Swallow.
  }
}

function safeInvokeSubscribers(event: TelemetryEvent): void {
  for (const handler of state.subscribers) {
    try {
      handler(event);
    } catch (err) {
      // One subscriber's exception must not block peers. Log to pino if
      // available so the failure is still observable, then continue.
      if (state.logger) {
        try {
          state.logger.warn(
            { handlerErr: err instanceof Error ? err.message : String(err) },
            "telemetry subscriber threw",
          );
        } catch {
          // Logger itself is broken. Nothing we can do.
        }
      }
    }
  }
}

export const telemetry = {
  /** Configure the singleton. Typically called once at app startup. */
  configure(opts: { logger?: Logger; enabled?: boolean }): void {
    if (opts.logger !== undefined) state.logger = opts.logger;
    if (opts.enabled !== undefined) state.enabled = opts.enabled;
  },

  /** Emit a telemetry event. Fires pino + subscribers. No-op if disabled. */
  emit(event: TelemetryEvent): void {
    if (!state.enabled) return;
    safeInvokeLogger(event);
    safeInvokeSubscribers(event);
  },

  /** Subscribe to every telemetry event. Returns an unsubscribe function. */
  subscribe(handler: TelemetryHandler): () => void {
    state.subscribers.add(handler);
    return () => {
      state.subscribers.delete(handler);
    };
  },

  /** Reset all singleton state. Tests call this in afterEach. */
  reset(): void {
    state.logger = null;
    state.enabled = false;
    state.subscribers.clear();
  },
};
