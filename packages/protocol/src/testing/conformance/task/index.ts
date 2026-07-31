/**
 * @file Public barrel for delivery-layer conformance properties.
 *
 * Conversation / message delivery invariants — fan-out cardinality,
 * store-and-replay, payload opacity.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `TASK_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerFanOutCardinality } from "./fan-out-cardinality.js";
import { registerStoreAndReplay } from "./store-and-replay.js";
import { registerPayloadOpacity } from "./payload-opacity.js";

/** Re-exports the public API from `current module`. */
export {
  registerFanOutCardinality,
  registerStoreAndReplay,
  registerPayloadOpacity,
};

/** All delivery-layer property registrars. */
export const TASK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [registerFanOutCardinality, registerStoreAndReplay, registerPayloadOpacity];
