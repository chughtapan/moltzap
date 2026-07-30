/** @file Eval-owned semantic evidence declared before each run. */

import { messageId } from "@moltzap/protocol/conversation";
import { agentId } from "@moltzap/protocol/identity";
import { taskId } from "@moltzap/protocol/task";
import { EventCatalog } from "@moltzap/simulator";
import { Schema } from "effect";
import type { EpisodeResponse } from "./episodes.js";

/**
 * Customer policy selected one delivered response as grading evidence.
 *
 * Core events retain network identities only. This event records the
 * evaluation's endpoint and target roles, then refers back to the canonical
 * delivered message by identity instead of copying its content.
 */
export class EvaluationResponseSelected extends Schema.TaggedClass<EvaluationResponseSelected>()(
  "moltzap.evaluation-response-selected/v1",
  {
    scenarioId: Schema.NonEmptyString,
    endpointName: Schema.NonEmptyString,
    endpointId: agentId,
    targetName: Schema.NonEmptyString,
    targetId: agentId,
    taskId: taskId,
    messageId: messageId,
  },
) {}

/** The complete customer event universe shared by MoltZap evaluations. */
export const evaluationEvents = EventCatalog.make(EvaluationResponseSelected);

/**
 * Turn one awaited protocol delivery into eval-owned semantic evidence.
 * @param scenarioId Value supplied to the operation.
 * @param response Value supplied to the operation.
 * @returns The select evaluation response result.
 */
export function selectEvaluationResponse(
  scenarioId: string,
  response: EpisodeResponse,
): EvaluationResponseSelected {
  return EvaluationResponseSelected.make({
    scenarioId,
    endpointName: response.endpointName,
    endpointId: response.endpointId,
    targetName: response.targetName,
    targetId: response.targetId,
    taskId: response.received.taskId,
    messageId: response.received.message.id,
  });
}
