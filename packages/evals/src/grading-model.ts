/** @file Exact-class ledger projection and refusal semantics. */

import type {
  AgentRuntimeReady,
  EndpointMessageReceived,
  ProgramSucceeded,
} from "@moltzap/simulator";
import { Array as Arr, Chunk, Effect, Schema, Stream } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type { EvaluationResponseSelected } from "./evaluation-events.js";

/** Typed protocol evidence selected from a validated ledger. */
export class EvaluationEvidence {
  readonly responses: NonEmptyReadonlyArray<EndpointMessageReceived>;
  readonly finalResponse: EndpointMessageReceived;

  constructor({
    responses,
  }: {
    readonly responses: NonEmptyReadonlyArray<EndpointMessageReceived>;
  }) {
    this.responses = Object.freeze(Arr.map(responses, (response) => response));
    this.finalResponse = Arr.lastNonEmpty(this.responses);
    Object.freeze(this);
  }
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

/** The exact customer-selected deliveries required by one grader. */
interface EvidenceRequest {
  readonly scenarioId: string;
  readonly endpointName: string;
  readonly targetName: string;
  readonly expectedResponses: number;
}

function refused(scenarioId: string, detail: string): GradingRefused {
  return GradingRefused.make({ scenarioId, detail });
}

function responseIdentityKey(
  messageId: string,
  endpointId: string,
  senderId: string,
): string {
  // JSON tuple encoding preserves field boundaries even when identifiers
  // contain delimiter-like text.
  return JSON.stringify([messageId, endpointId, senderId]);
}

function indexResponses(
  messages: readonly EndpointMessageReceived[],
): ReadonlyMap<string, EndpointMessageReceived> {
  const responses = new Map<string, EndpointMessageReceived>();
  for (const message of messages) {
    const key = responseIdentityKey(
      message.messageId,
      message.endpointId,
      message.senderId,
    );
    // The earliest canonical delivery wins if malformed evidence repeats an
    // identity.
    if (!responses.has(key)) {
      responses.set(key, message);
    }
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
      selection.endpointId,
      selection.targetId,
    ),
  );
}

function selectedResponses(
  selections: readonly EvaluationResponseSelected[],
  messages: readonly EndpointMessageReceived[],
): readonly EndpointMessageReceived[] {
  const responses = indexResponses(messages);
  return selections.flatMap((selection) => {
    const response = responseFor(selection, responses);
    return response === undefined ? [] : [response];
  });
}

function ensureProgramSucceeded(
  scenarioId: string,
  succeeded: readonly ProgramSucceeded[],
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
  ready: readonly AgentRuntimeReady[],
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
  selections: readonly EvaluationResponseSelected[],
): readonly EvaluationResponseSelected[] {
  return selections.filter(
    (selection) =>
      selection.scenarioId === scenarioId &&
      selection.endpointName === endpointName &&
      selection.targetName === target.agentName &&
      selection.targetId === target.agentId,
  );
}

function resolveSelectedResponses(
  request: EvidenceRequest,
  target: AgentRuntimeReady,
  selections: readonly EvaluationResponseSelected[],
  messages: readonly EndpointMessageReceived[],
): Effect.Effect<
  NonEmptyReadonlyArray<EndpointMessageReceived>,
  GradingRefused
> {
  const relevant = relevantSelections(
    request.scenarioId,
    request.endpointName,
    target,
    selections,
  );
  const responses = selectedResponses(relevant, messages);
  if (responses.length !== relevant.length) {
    return Effect.fail(
      refused(
        request.scenarioId,
        "selected response does not match canonical delivery evidence",
      ),
    );
  }
  if (responses.length !== request.expectedResponses) {
    return Effect.fail(
      refused(
        request.scenarioId,
        `ledger has ${String(responses.length)} selected target responses at ${request.endpointName}; expected ${String(request.expectedResponses)}`,
      ),
    );
  }
  if (!Arr.isNonEmptyReadonlyArray(responses)) {
    return Effect.fail(
      refused(
        request.scenarioId,
        `ledger has no selected target response at ${request.endpointName}`,
      ),
    );
  }
  return Effect.succeed(responses);
}

/** Resolve customer selection policy against canonical network deliveries. */
export const evidenceFromLedger = Effect.fn("evals.evidenceFromLedger")(
  function* (ledger: EvaluationLedgerView, request: EvidenceRequest) {
    const collected = yield* Effect.all({
      succeeded: Stream.runCollect(ledger.programSucceeded),
      ready: Stream.runCollect(ledger.runtimesReady),
      messages: Stream.runCollect(ledger.messagesReceived),
      selected: Stream.runCollect(ledger.responsesSelected),
    });
    const succeeded = Chunk.toReadonlyArray(collected.succeeded);
    yield* ensureProgramSucceeded(request.scenarioId, succeeded);
    const target = yield* ensureTargetReady(
      request.scenarioId,
      request.targetName,
      Chunk.toReadonlyArray(collected.ready),
    );
    const responses = yield* resolveSelectedResponses(
      request,
      target,
      Chunk.toReadonlyArray(collected.selected),
      Chunk.toReadonlyArray(collected.messages),
    );
    return new EvaluationEvidence({ responses });
  },
);
