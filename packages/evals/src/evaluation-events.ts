/** @file Eval-owned semantic evidence declared before each run. */

import { MessageId } from "@moltzap/protocol/conversation";
import { AgentId } from "@moltzap/protocol/identity";
import { TaskId } from "@moltzap/protocol/task";
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
    endpointId: AgentId,
    targetName: Schema.NonEmptyString,
    targetId: AgentId,
    taskId: TaskId,
    messageId: MessageId,
  },
) {}

/** The complete customer event universe shared by MoltZap evaluations. */
export const EvaluationEvents = EventCatalog.make(EvaluationResponseSelected);

/** Turn one awaited protocol delivery into eval-owned semantic evidence. */
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
