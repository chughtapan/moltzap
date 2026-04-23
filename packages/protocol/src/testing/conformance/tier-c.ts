/**
 * Tier C — Delivery correctness, multi-connection (C1–C4). Covers AC7.
 *
 * Each property spins up N TestClients (see design doc §10 Multi-connection
 * orchestration) and asserts on the merged capture buffer.
 */
import type { ConformanceRunContext } from "./runner.js";

/** C1 — fan-out cardinality: one send ⇒ exactly N delivered events. */
export function registerC1FanOut(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** C2 — store-and-replay: offline-then-reconnect delivers missed events. */
export function registerC2StoreReplay(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** C3 — payload opacity: bytes in ≡ bytes out. */
export function registerC3PayloadOpacity(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** C4 — task-boundary isolation: subscribers see only their task's events. */
export function registerC4TaskIsolation(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}
