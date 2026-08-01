/**
 * @file Public barrel for task-layer conformance properties.
 *
 * Task-layer conformance properties.
 *
 * Task / conversation / message invariants — fan-out cardinality,
 * store-and-replay, payload opacity, task-boundary isolation,
 * conversation lifecycle, archive lifecycle, task-close lifecycle.
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
// `task` + `conversation` family per-method properties. Each
// `register*` exercises one wire method end-to-end on the family.
import {
  CONVERSATION_FAMILY_PROPERTIES,
  registerConversationCreateAndList,
  registerTaskCreate,
  registerTaskLeave,
  registerTaskRequestReject,
} from "./conversation-family.js";

export {
  registerArchiveLifecycle,
  registerConversationCreateAndList,
  registerConversationLifecycle,
  registerFanOutCardinality,
  registerPayloadOpacity,
  registerStoreAndReplay,
  registerTaskBoundaryIsolation,
  registerTaskCloseLifecycle,
  registerTaskCreate,
  registerTaskLeave,
  registerTaskRequestReject,
};

/**
 * All task-layer property registrars: delivery subset first, then the
 * `app/conversation/*` family.
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
  ...CONVERSATION_FAMILY_PROPERTIES,
];
