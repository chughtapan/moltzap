/**
 * Shared test helpers for moltzap packages that use the telemetry singleton.
 *
 * Every test package should import `resetTelemetry` and call it in afterEach
 * to prevent cross-test contamination. The singleton's mutable state (logger,
 * enabled, subscribers) leaks across tests within the same vitest worker
 * otherwise.
 *
 * Usage (in a test file or setup file):
 *   import { afterEach } from "vitest";
 *   import { resetTelemetry } from "@moltzap/observability/test-utils";
 *   afterEach(resetTelemetry);
 */

import { telemetry } from "./telemetry.js";

export function resetTelemetry(): void {
  telemetry.reset();
}

/**
 * Subscribe to telemetry for the duration of one test. Returns the captured
 * events array and an unsubscribe function (auto-called by resetTelemetry but
 * available for explicit teardown).
 */
export function captureTelemetry(): {
  events: import("./events.js").TelemetryEvent[];
  stop: () => void;
} {
  const events: import("./events.js").TelemetryEvent[] = [];
  const stop = telemetry.subscribe((e) => events.push(e));
  telemetry.configure({ enabled: true });
  return { events, stop };
}
