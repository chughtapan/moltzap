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
import { Effect, PubSub, Queue, Ref, Schema, Stream } from "effect";
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
 * NanoClaw. A question selects runtime-native output while an instruction does
 * not expose output to the case program.
 */
export interface PrincipalDriver<Gateway, Failure> {
  readonly observe: <Name extends string>(
    target: StartedAgent<Name, Gateway>,
    caseId: EvaluationCaseId,
    emit: EmitEvaluationEvent,
  ) => Effect.Effect<never, Failure | LedgerFailure>;
  readonly instruct: <Name extends string>(
    target: StartedAgent<Name, Gateway>,
    instruction: PrincipalInstruction,
    emit: EmitEvaluationEvent,
  ) => Effect.Effect<void, Failure | LedgerFailure>;
  readonly ask: <Name extends string>(
    target: StartedAgent<Name, Gateway>,
    instruction: PrincipalInstruction,
    emit: EmitEvaluationEvent,
  ) => Effect.Effect<EvaluationEvidenceId, Failure | LedgerFailure>;
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

function askOpenClaw<Name extends string>(
  state: OpenClawDriverState,
  target: StartedAgent<Name, OpenClawGateway>,
  instruction: PrincipalInstruction,
  emit: EmitEvaluationEvent,
): Effect.Effect<
  EvaluationEvidenceId,
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
        request,
      }),
    );
    const response = yield* target.gateway.agent(request);
    const output = yield* emit(
      OpenClawPrincipalFinalOutput.make({
        caseId: instruction.caseId,
        agentName: decodeAgentName(target.agent.name),
        idempotencyKey,
        output: response,
      }),
    );
    return evidenceId(output);
  }).pipe(Effect.withSpan("evals.principal.openclaw"));
}

/** Build an OpenClaw adapter whose native RPC keys are unique per attempt. */
export const openClawPrincipalDriver = Object.freeze({
  make: (attemptId: string) =>
    Ref.make(0).pipe(
      Effect.map((nextInstruction) =>
        Object.freeze({
          observe: () => Effect.never,
          instruct: <Name extends string>(
            target: StartedAgent<Name, OpenClawGateway>,
            instruction: PrincipalInstruction,
            emit: EmitEvaluationEvent,
          ) =>
            askOpenClaw(
              { attemptId, nextInstruction },
              target,
              instruction,
              emit,
            ).pipe(Effect.asVoid),
          ask: <Name extends string>(
            target: StartedAgent<Name, OpenClawGateway>,
            instruction: PrincipalInstruction,
            emit: EmitEvaluationEvent,
          ) =>
            askOpenClaw(
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

function instructNanoClaw<Name extends string>(
  target: StartedAgent<Name, NanoClawGateway>,
  instruction: PrincipalInstruction,
  emit: EmitEvaluationEvent,
): Effect.Effect<void, NanoClawGatewayError | LedgerFailure> {
  return Effect.gen(function* () {
    const input = NanoClawGatewayInput.make({
      text: instruction.message,
    });
    yield* target.gateway.submit(input);
    yield* emit(
      NanoClawPrincipalInputSent.make({
        caseId: instruction.caseId,
        agentName: decodeAgentName(target.agent.name),
        input,
      }),
    );
  }).pipe(Effect.withSpan("evals.principal.nanoclaw"));
}

interface NanoClawDriverState {
  readonly askGate: Effect.Semaphore;
  readonly outputEvidence: PubSub.PubSub<EvaluationEvidenceId>;
}

function askNanoClaw<Name extends string>(
  state: NanoClawDriverState,
  target: StartedAgent<Name, NanoClawGateway>,
  instruction: PrincipalInstruction,
  emit: EmitEvaluationEvent,
): Effect.Effect<EvaluationEvidenceId, NanoClawGatewayError | LedgerFailure> {
  return state.askGate.withPermits(1)(
    Effect.scoped(
      Effect.gen(function* () {
        const outputs = yield* PubSub.subscribe(state.outputEvidence);
        yield* instructNanoClaw(target, instruction, emit);
        return yield* Queue.take(outputs);
      }),
    ),
  );
}

function observeNanoClaw<Name extends string>(
  state: NanoClawDriverState,
  target: StartedAgent<Name, NanoClawGateway>,
  caseId: EvaluationCaseId,
  emit: EmitEvaluationEvent,
): Effect.Effect<never, NanoClawGatewayError | LedgerFailure> {
  return target.gateway.outputs.pipe(
    Stream.runForEach((output) =>
      Effect.gen(function* () {
        const record = yield* emit(
          NanoClawPrincipalOutputReceived.make({
            caseId,
            agentName: decodeAgentName(target.agent.name),
            output,
          }),
        );
        yield* PubSub.publish(state.outputEvidence, evidenceId(record));
      }),
    ),
    Effect.andThen(Effect.never),
    Effect.withSpan("evals.principal.nanoclaw.outputs"),
  );
}

/**
 * Drive NanoClaw only through its native owner-local socket.
 *
 * Socket output has no request identifiers. Questions therefore serialize and
 * select the next output observed after their input is accepted.
 */
export const nanoclawPrincipalDriver: PrincipalDriverFactory<
  NanoClawGateway,
  NanoClawGatewayError
> = Object.freeze({
  make: () =>
    Effect.gen(function* () {
      const state = {
        askGate: yield* Effect.makeSemaphore(1),
        outputEvidence: yield* PubSub.unbounded<EvaluationEvidenceId>(),
      } satisfies NanoClawDriverState;
      return Object.freeze({
        observe: <Name extends string>(
          target: StartedAgent<Name, NanoClawGateway>,
          caseId: EvaluationCaseId,
          emit: EmitEvaluationEvent,
        ) => observeNanoClaw(state, target, caseId, emit),
        instruct: instructNanoClaw,
        ask: <Name extends string>(
          target: StartedAgent<Name, NanoClawGateway>,
          instruction: PrincipalInstruction,
          emit: EmitEvaluationEvent,
        ) => askNanoClaw(state, target, instruction, emit),
      });
    }).pipe(Effect.withSpan("nanoclawPrincipalDriver")),
});
