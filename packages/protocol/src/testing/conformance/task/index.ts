/**
 * @file Public barrel for task-layer conformance properties.
 *
 * Task-layer conformance properties.
 *
 * Task / conversation / message invariants — fan-out cardinality,
 * store-and-replay, payload opacity, task-boundary isolation,
 * conversation lifecycle, archive lifecycle, model equivalence,
 * task-close lifecycle.
 *
 * Each `register*` lives in its own file. This barrel re-exports them
 * by name AND aggregates them into `TASK_PROPERTIES` for the
 * `_shared/suite.ts` aggregator.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerFanOutCardinality } from "./fan-out-cardinality.js";
import { registerStoreAndReplay } from "./store-and-replay.js";
import { registerPayloadOpacity } from "./payload-opacity.js";
import { registerTaskBoundaryIsolation } from "./task-boundary-isolation.js";
import { registerConversationLifecycle } from "./conversation-lifecycle.js";
import { registerTaskCloseLifecycle } from "./task-close-lifecycle.js";
import { registerArchiveLifecycle } from "./archive-lifecycle.js";
import { registerModelEquivalence } from "./model-equivalence.js";

export {
  registerFanOutCardinality,
  registerStoreAndReplay,
  registerPayloadOpacity,
  registerTaskBoundaryIsolation,
  registerConversationLifecycle,
  registerTaskCloseLifecycle,
  registerArchiveLifecycle,
  registerModelEquivalence,
};

/**
 * All task-layer property registrars, ordered per architect plan §2
 * (delivery subset first, then `model-equivalence` from rpc-semantics).
 */
export const TASK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerFanOutCardinality,
  registerStoreAndReplay,
  registerPayloadOpacity,
  registerTaskBoundaryIsolation,
  registerConversationLifecycle,
  registerTaskCloseLifecycle,
  registerArchiveLifecycle,
  registerModelEquivalence,
];
