/** @file Runtime-native principal drivers for bundled evaluation conditions. */

import type { CustomerEvents, LedgerFailure } from "@moltzap/simulator";
import {
  type NanoClawGateway,
  type NanoClawGatewayError,
  NanoClawGatewayInput,
  type OpenClawGateway,
  OpenClawGatewayRequest,
  type OpenClawGatewayRequestError,
  type StartedAgent,
} from "@moltzap/simulator/agents";
import { Effect, Option, Ref, Schema, Stream } from "effect";
import {
  type evaluationEvents,
  NanoClawPrincipalInputSent,
  NanoClawPrincipalOutputReceived,
  OpenClawPrincipalFinalOutput,
  OpenClawPrincipalInstructionAttempted,
} from "./events.js";
import {
  decodeEvaluationEvidenceId,
  type EvaluationCaseId,
  type EvaluationEvidenceId,
} from "./model.js";

const decodeAgentName = Schema.decodeSync(
  OpenClawPrincipalInstructionAttempted.fields.agentName,
);

/** Definition-bound customer event writer used by concrete principal drivers. */
export type EmitEvaluationEvent = CustomerEvents<
  typeof evaluationEvents
>["emit"];

/** One instruction supplied by bundled case policy to a native gateway. */
export interface PrincipalInstruction {
  readonly caseId: EvaluationCaseId;
  readonly message: string;
}

/**
 * Evaluation-local adapter over one exact runtime gateway.
 *
 * The simulator never sees this interface and no union combines OpenClaw with
 * NanoClaw. The result identifies a correlated native output when that
 * gateway has one.
 */
export interface PrincipalDriver<Gateway, Failure> {
  readonly observe: <Name extends string>(
    target: StartedAgent<Name, Gateway>,
    caseId: EvaluationCaseId,
    emit: EmitEvaluationEvent,
  ) => Effect.Effect<never, Failure | LedgerFailure>;
  readonly drive: <Name extends string>(
    target: StartedAgent<Name, Gateway>,
    instruction: PrincipalInstruction,
    emit: EmitEvaluationEvent,
  ) => Effect.Effect<
    Option.Option<EvaluationEvidenceId>,
    Failure | LedgerFailure
  >;
}

/** Construct one native principal adapter for an exact evaluation attempt. */
export interface PrincipalDriverFactory<Gateway, Failure> {
  readonly make: (
    attemptId: string,
  ) => Effect.Effect<PrincipalDriver<Gateway, Failure>>;
}

function evidenceId(
  record: Effect.Effect.Success<ReturnType<EmitEvaluationEvent>>,
): EvaluationEvidenceId {
  return decodeEvaluationEvidenceId(record.eventId);
}

interface OpenClawDriverState {
  readonly attemptId: string;
  readonly nextInstruction: Ref.Ref<number>;
}

function driveOpenClaw<Name extends string>(
  state: OpenClawDriverState,
  target: StartedAgent<Name, OpenClawGateway>,
  instruction: PrincipalInstruction,
  emit: EmitEvaluationEvent,
): Effect.Effect<
  Option.Option<EvaluationEvidenceId>,
  OpenClawGatewayRequestError | LedgerFailure
> {
  return Effect.gen(function* () {
    const instructionNumber = yield* Ref.getAndUpdate(
      state.nextInstruction,
      (current) => current + 1,
    );
    const idempotencyKey = [
      state.attemptId,
      instruction.caseId,
      String(instructionNumber),
    ].join(":");
    const request = OpenClawGatewayRequest.make({
      message: instruction.message,
      idempotencyKey,
    });
    yield* emit(
      OpenClawPrincipalInstructionAttempted.make({
        caseId: instruction.caseId,
        agentName: decodeAgentName(target.agent.name),
        agentId: target.agent.id,
        request,
      }),
    );
    const response = yield* target.gateway.agent(request);
    const output = yield* emit(
      OpenClawPrincipalFinalOutput.make({
        caseId: instruction.caseId,
        agentName: decodeAgentName(target.agent.name),
        agentId: target.agent.id,
        idempotencyKey,
        output: response,
      }),
    );
    return Option.some(evidenceId(output));
  }).pipe(Effect.withSpan("evals.principal.openclaw"));
}

/** Build an OpenClaw adapter whose native RPC keys are unique per attempt. */
export const openClawPrincipalDriver = Object.freeze({
  make: (attemptId: string) =>
    Ref.make(0).pipe(
      Effect.map((nextInstruction) =>
        Object.freeze({
          observe: () => Effect.never,
          drive: <Name extends string>(
            target: StartedAgent<Name, OpenClawGateway>,
            instruction: PrincipalInstruction,
            emit: EmitEvaluationEvent,
          ) =>
            driveOpenClaw(
              { attemptId, nextInstruction },
              target,
              instruction,
              emit,
            ),
        }),
      ),
    ),
}) satisfies PrincipalDriverFactory<
  OpenClawGateway,
  OpenClawGatewayRequestError
>;

function driveNanoClaw<Name extends string>(
  target: StartedAgent<Name, NanoClawGateway>,
  instruction: PrincipalInstruction,
  emit: EmitEvaluationEvent,
): Effect.Effect<
  Option.Option<EvaluationEvidenceId>,
  NanoClawGatewayError | LedgerFailure
> {
  return Effect.gen(function* () {
    const input = NanoClawGatewayInput.make({
      text: instruction.message,
    });
    yield* target.gateway.submit(input);
    yield* emit(
      NanoClawPrincipalInputSent.make({
        caseId: instruction.caseId,
        agentName: decodeAgentName(target.agent.name),
        agentId: target.agent.id,
        input,
      }),
    );
    return Option.none<EvaluationEvidenceId>();
  }).pipe(Effect.withSpan("evals.principal.nanoclaw"));
}

function observeNanoClaw<Name extends string>(
  target: StartedAgent<Name, NanoClawGateway>,
  caseId: EvaluationCaseId,
  emit: EmitEvaluationEvent,
): Effect.Effect<never, NanoClawGatewayError | LedgerFailure> {
  return target.gateway.outputs.pipe(
    Stream.runForEach((output) =>
      emit(
        NanoClawPrincipalOutputReceived.make({
          caseId,
          agentName: decodeAgentName(target.agent.name),
          agentId: target.agent.id,
          output,
        }),
      ),
    ),
    Effect.andThen(Effect.never),
    Effect.withSpan("evals.principal.nanoclaw.outputs"),
  );
}

/**
 * Drive NanoClaw only through its native owner-local socket.
 *
 * Socket output is an uncorrelated multi-frame stream, so submitting an input
 * cannot identify a terminal response for evidence selection.
 */
export const nanoclawPrincipalDriver: PrincipalDriverFactory<
  NanoClawGateway,
  NanoClawGatewayError
> = Object.freeze({
  make: () =>
    Effect.succeed(
      Object.freeze({
        observe: observeNanoClaw,
        drive: driveNanoClaw,
      }),
    ),
});
