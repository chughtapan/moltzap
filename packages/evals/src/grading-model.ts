/** @file Exact-class ledger projection and grading result contracts. */

import {
  AgentRuntimeReady,
  EndpointMessageReceived,
  ProgramSucceeded,
} from "@moltzap/simulator";
import { Chunk, Effect, Schema, Stream } from "effect";
import { EvaluationResponseSelected } from "./evaluation-events.js";

/** Typed protocol evidence selected from a validated ledger. */
export interface EvaluationEvidence {
  readonly responses: ReadonlyArray<EndpointMessageReceived>;
  readonly finalResponse: EndpointMessageReceived;
}

/**
 * What one check concluded.
 *
 * `unknown` is the load-bearing case. A check that searches for a forbidden
 * substring and finds none has learned nothing about the property it stands
 * for: an agent that paraphrases a secret leaks it without ever spelling it.
 * Reporting that as `passed` turns "I found no violation I can detect" into
 * "the agent behaved correctly", which is how a corpus reports a clean sweep
 * over verdicts nobody can defend.
 */
export const CheckOutcome = {
  passed: "passed",
  failed: "failed",
  unknown: "unknown",
} as const;
export type CheckOutcome = (typeof CheckOutcome)[keyof typeof CheckOutcome];

/** One executable assertion in a code grader. */
export interface GradeCheckResult {
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly detail: string;
}

/**
 * An evaluation is only `passed` when every check decided in its favour.
 * Any undecided check makes the run `inconclusive` rather than passing,
 * so an unverified property is never counted as a verified one.
 */
export const GradeVerdict = {
  passed: "passed",
  failed: "failed",
  inconclusive: "inconclusive",
} as const;
export type GradeVerdict = (typeof GradeVerdict)[keyof typeof GradeVerdict];

/** A grader report retains every assertion instead of reducing to one bit. */
export interface GradeReport {
  readonly verdict: GradeVerdict;
  readonly checks: ReadonlyArray<GradeCheckResult>;
}

/** One `failed` decides the run; otherwise every check must have passed. */
export function verdictOf(
  checks: ReadonlyArray<GradeCheckResult>,
): GradeVerdict {
  if (checks.some((check) => check.outcome === CheckOutcome.failed)) {
    return GradeVerdict.failed;
  }
  if (checks.every((check) => check.outcome === CheckOutcome.passed)) {
    return GradeVerdict.passed;
  }
  return GradeVerdict.inconclusive;
}

/** Invalid or incomplete ledgers are refused rather than graded as failures. */
export class GradingRefused extends Schema.TaggedError<GradingRefused>()(
  "GradingRefused",
  {
    scenarioId: Schema.NonEmptyString,
    detail: Schema.NonEmptyString,
  },
) {}

/**
 * Exact event streams selected from one definition-bound completed ledger.
 * The ledger projection selects only classes declared by that definition.
 */
export interface EvaluationLedgerView {
  readonly programSucceeded: Stream.Stream<ProgramSucceeded>;
  readonly runtimesReady: Stream.Stream<AgentRuntimeReady>;
  readonly messagesReceived: Stream.Stream<EndpointMessageReceived>;
  readonly responsesSelected: Stream.Stream<EvaluationResponseSelected>;
}

/** A grader is ordinary code over exact typed streams from a validated ledger. */
export interface CodeGrader {
  (ledger: EvaluationLedgerView): Effect.Effect<GradeReport, GradingRefused>;
}

export type CodeCheck = (evidence: EvaluationEvidence) => GradeCheckResult;

function refused(scenarioId: string, detail: string): GradingRefused {
  return GradingRefused.make({ scenarioId, detail });
}

function responseIdentityKey(
  messageId: string,
  taskId: string,
  endpointId: string,
  senderId: string,
): string {
  // JSON tuple encoding preserves field boundaries even when identifiers
  // contain delimiter-like text.
  return JSON.stringify([messageId, taskId, endpointId, senderId]);
}

function indexResponses(
  messages: ReadonlyArray<EndpointMessageReceived>,
): ReadonlyMap<string, EndpointMessageReceived> {
  const responses = new Map<string, EndpointMessageReceived>();
  for (const message of messages) {
    const key = responseIdentityKey(
      message.messageId,
      message.taskId,
      message.endpointId,
      message.senderId,
    );
    // The earliest canonical delivery wins if malformed evidence repeats an
    // identity.
    if (!responses.has(key)) responses.set(key, message);
  }
  return responses;
}

function responseFor(
  selection: EvaluationResponseSelected,
  responses: ReadonlyMap<string, EndpointMessageReceived>,
): EndpointMessageReceived | undefined {
  return responses.get(
    responseIdentityKey(
      selection.messageId,
      selection.taskId,
      selection.endpointId,
      selection.targetId,
    ),
  );
}

function selectedResponses(
  selections: ReadonlyArray<EvaluationResponseSelected>,
  messages: ReadonlyArray<EndpointMessageReceived>,
): ReadonlyArray<EndpointMessageReceived> {
  const responses = indexResponses(messages);
  return selections.flatMap((selection) => {
    const response = responseFor(selection, responses);
    return response === undefined ? [] : [response];
  });
}

function ensureProgramSucceeded(
  scenarioId: string,
  succeeded: ReadonlyArray<ProgramSucceeded>,
): Effect.Effect<void, GradingRefused> {
  return succeeded.length > 0
    ? Effect.void
    : Effect.fail(
        refused(scenarioId, "the evaluation program did not succeed"),
      );
}

function ensureTargetReady(
  scenarioId: string,
  targetName: string,
  ready: ReadonlyArray<AgentRuntimeReady>,
): Effect.Effect<AgentRuntimeReady, GradingRefused> {
  const target = ready.find((event) => event.agentName === targetName);
  return target === undefined
    ? Effect.fail(
        refused(scenarioId, `ledger has no ready runtime for ${targetName}`),
      )
    : Effect.succeed(target);
}

function relevantSelections(
  scenarioId: string,
  endpointName: string,
  target: AgentRuntimeReady,
  selections: ReadonlyArray<EvaluationResponseSelected>,
): ReadonlyArray<EvaluationResponseSelected> {
  return selections.filter(
    (selection) =>
      selection.scenarioId === scenarioId &&
      selection.endpointName === endpointName &&
      selection.targetName === target.agentName &&
      selection.targetId === target.agentId,
  );
}

/** Resolve customer selection policy against canonical network deliveries. */
export const evidenceFromLedger = Effect.fn("evals.evidenceFromLedger")(
  function* (
    ledger: EvaluationLedgerView,
    scenarioId: string,
    endpointName: string,
    targetName: string,
  ) {
    const collected = yield* Effect.all({
      succeeded: Stream.runCollect(ledger.programSucceeded),
      ready: Stream.runCollect(ledger.runtimesReady),
      messages: Stream.runCollect(ledger.messagesReceived),
      selected: Stream.runCollect(ledger.responsesSelected),
    });
    const succeeded = Chunk.toReadonlyArray(collected.succeeded);
    yield* ensureProgramSucceeded(scenarioId, succeeded);
    const target = yield* ensureTargetReady(
      scenarioId,
      targetName,
      Chunk.toReadonlyArray(collected.ready),
    );
    const selections = relevantSelections(
      scenarioId,
      endpointName,
      target,
      Chunk.toReadonlyArray(collected.selected),
    );
    const responses = selectedResponses(
      selections,
      Chunk.toReadonlyArray(collected.messages),
    );
    const finalResponse = responses.at(-1);
    if (finalResponse === undefined) {
      return yield* Effect.fail(
        refused(
          scenarioId,
          `ledger has no selected target response at ${endpointName}`,
        ),
      );
    }
    if (responses.length !== selections.length) {
      return yield* Effect.fail(
        refused(
          scenarioId,
          "selected response does not match canonical delivery evidence",
        ),
      );
    }
    return { responses, finalResponse };
  },
);
