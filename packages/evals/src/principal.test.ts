import { assert, describe, it } from "@effect/vitest";
import { agentId } from "@moltzap/protocol/testing";
import {
  NanoclawGatewayError,
  NanoclawGatewayInput,
  NanoclawGatewayOutput,
  type NanoclawGateway,
  type OpenClawGateway,
  OpenClawGatewayRequest,
  OpenClawGatewayRequestFailed,
  OpenClawGatewayResponse,
  OpenClawGatewaySucceeded,
  type StartedAgent,
} from "@moltzap/simulator/runtime";
import { makeAgentHandle } from "@moltzap/simulator/network";
import { Deferred, Effect, Option, Ref, Schema, Stream } from "effect";
import {
  NanoclawPrincipalInputSent,
  NanoclawPrincipalOutputReceived,
  OpenClawPrincipalFinalOutput,
  OpenClawPrincipalInstructionAttempted,
} from "./events.js";
import { decodeEvaluationCaseId, decodeEvaluationEvidenceId } from "./model.js";
import {
  type EmitEvaluationEvent,
  nanoclawPrincipalDriver,
  openClawPrincipalDriver,
  type PrincipalInstruction,
} from "./principal.js";

const TARGET_NAME = "evaluation-target";
const TARGET_ID = agentId("00000000-0000-4000-8000-000000000701");
const CASE_ID = decodeEvaluationCaseId("EVAL-005");
const ATTEMPT_ID = "principal-test-attempt";
const INSTRUCTION_TEXT = "Create a MoltZap conversation with the case peer.";
const SUBMITTED_RECORD_ID = "principal-test:submitted";
const OUTPUT_RECORD_ID = "principal-test:output";
const OUTPUT_EVIDENCE_ID = decodeEvaluationEvidenceId(OUTPUT_RECORD_ID);
const test = it.effect;

const INSTRUCTION: PrincipalInstruction = {
  caseId: CASE_ID,
  message: INSTRUCTION_TEXT,
};

const OPENCLAW_RESPONSE = Schema.decodeSync(OpenClawGatewayResponse)({
  runId: "openclaw-principal-test",
  status: "ok",
  summary: "completed",
  result: {
    payloads: [{ text: "Conversation created." }],
  },
});

const NANOCLAW_OUTPUT = NanoclawGatewayOutput.make({
  text: "Conversation created.",
});

type EvaluationEvent = Parameters<EmitEvaluationEvent>[0];

interface EventRecorder {
  readonly events: Ref.Ref<readonly EvaluationEvent[]>;
  readonly emit: EmitEvaluationEvent;
}

function makeEventRecorder(): Effect.Effect<EventRecorder> {
  return Effect.gen(function* () {
    const events = yield* Ref.make<readonly EvaluationEvent[]>([]);
    const emit: EmitEvaluationEvent = (event) =>
      Ref.updateAndGet(events, (recorded) => [...recorded, event]).pipe(
        Effect.map((recorded) => {
          const eventId =
            recorded.length === 1 ? SUBMITTED_RECORD_ID : OUTPUT_RECORD_ID;
          return {
            runId: "principal-test",
            eventId,
            logicalSequence: recorded.length - 1,
            elapsedNanos: BigInt(recorded.length - 1),
            observedAt: recorded.length - 1,
            producer: "principal-test",
            event,
          };
        }),
      );
    return { events, emit };
  });
}

function target<Gateway>(
  gateway: Gateway,
): StartedAgent<typeof TARGET_NAME, Gateway> {
  return {
    agent: makeAgentHandle(TARGET_NAME, TARGET_ID),
    gateway,
    termination: Effect.never,
  };
}

function idempotencyKey(instructionNumber: number): string {
  return `${ATTEMPT_ID}:${CASE_ID}:${String(instructionNumber)}`;
}

function assertOpenClawSubmitted(
  expectedMessage: string,
  expectedIdempotencyKey: string,
  event?: EvaluationEvent,
): void {
  if (!(event instanceof OpenClawPrincipalInstructionAttempted)) {
    assert.fail("expected an OpenClaw attempted event");
  }
  assert.strictEqual(event.caseId, CASE_ID);
  assert.strictEqual(event.agentName, TARGET_NAME);
  assert.strictEqual(event.agentId, TARGET_ID);
  assert.deepStrictEqual(
    event.request,
    OpenClawGatewayRequest.make({
      message: expectedMessage,
      idempotencyKey: expectedIdempotencyKey,
    }),
  );
}

function assertOpenClawOutput(
  expectedIdempotencyKey: string,
  event?: EvaluationEvent,
): void {
  if (!(event instanceof OpenClawPrincipalFinalOutput)) {
    assert.fail("expected an OpenClaw output event");
  }
  assert.strictEqual(event.caseId, CASE_ID);
  assert.strictEqual(event.agentName, TARGET_NAME);
  assert.strictEqual(event.agentId, TARGET_ID);
  assert.strictEqual(event.idempotencyKey, expectedIdempotencyKey);
  assert.strictEqual(event.output, OPENCLAW_RESPONSE);
}

function recordingOpenClawGateway(
  recorder: EventRecorder,
  requests: Ref.Ref<readonly OpenClawGatewayRequest[]>,
): OpenClawGateway {
  return {
    agent: (request) =>
      Effect.gen(function* () {
        const beforeCall = yield* Ref.get(recorder.events);
        const attempted = beforeCall[beforeCall.length - 1];
        if (!(attempted instanceof OpenClawPrincipalInstructionAttempted)) {
          return assert.fail(
            "expected an attempted event immediately before the native call",
          );
        }
        assert.deepStrictEqual(attempted.request, request);
        yield* Ref.update(requests, (called) => [...called, request]);
        return OPENCLAW_RESPONSE;
      }),
  };
}

function openClawNativeRoundTripTest() {
  return Effect.gen(function* () {
    const recorder = yield* makeEventRecorder();
    const requests = yield* Ref.make<readonly OpenClawGatewayRequest[]>([]);
    const gateway = recordingOpenClawGateway(recorder, requests);
    const driver = yield* openClawPrincipalDriver.make(ATTEMPT_ID);

    const output = yield* driver.drive(
      target(gateway),
      INSTRUCTION,
      recorder.emit,
    );
    const recorded = yield* Ref.get(recorder.events);

    assert.deepStrictEqual(yield* Ref.get(requests), [
      OpenClawGatewayRequest.make({
        message: INSTRUCTION_TEXT,
        idempotencyKey: idempotencyKey(0),
      }),
    ]);
    assert.strictEqual(recorded.length, 2);
    assertOpenClawSubmitted(INSTRUCTION_TEXT, idempotencyKey(0), recorded[0]);
    assertOpenClawOutput(idempotencyKey(0), recorded[1]);
    assert.instanceOf(OPENCLAW_RESPONSE, OpenClawGatewaySucceeded);
    assert.deepStrictEqual(output, Option.some(OUTPUT_EVIDENCE_ID));
  });
}

function openClawUniqueKeysTest() {
  return Effect.gen(function* () {
    const recorder = yield* makeEventRecorder();
    const requests = yield* Ref.make<readonly OpenClawGatewayRequest[]>([]);
    const driver = yield* openClawPrincipalDriver.make(ATTEMPT_ID);
    const gateway = recordingOpenClawGateway(recorder, requests);
    const secondMessage = "Send a second principal instruction.";

    yield* driver.drive(target(gateway), INSTRUCTION, recorder.emit);
    yield* driver.drive(
      target(gateway),
      { caseId: CASE_ID, message: secondMessage },
      recorder.emit,
    );

    const [first, second] = yield* Ref.get(requests);
    assert.strictEqual(first?.idempotencyKey, idempotencyKey(0));
    assert.strictEqual(second?.idempotencyKey, idempotencyKey(1));
    assert.notStrictEqual(first?.idempotencyKey, second?.idempotencyKey);
    const recorded = yield* Ref.get(recorder.events);
    assertOpenClawSubmitted(INSTRUCTION_TEXT, idempotencyKey(0), recorded[0]);
    assertOpenClawOutput(idempotencyKey(0), recorded[1]);
    assertOpenClawSubmitted(secondMessage, idempotencyKey(1), recorded[2]);
    assertOpenClawOutput(idempotencyKey(1), recorded[3]);
  });
}

function openClawFailureTest() {
  return Effect.gen(function* () {
    const recorder = yield* makeEventRecorder();
    const failure = OpenClawGatewayRequestFailed.make({
      detail: "native agent RPC rejected the instruction",
    });
    const gateway: OpenClawGateway = {
      agent: () => Effect.fail(failure),
    };
    const driver = yield* openClawPrincipalDriver.make(ATTEMPT_ID);

    const observed = yield* driver
      .drive(target(gateway), INSTRUCTION, recorder.emit)
      .pipe(Effect.flip);
    const recorded = yield* Ref.get(recorder.events);

    assert.instanceOf(observed, OpenClawGatewayRequestFailed);
    assert.strictEqual(observed.detail, failure.detail);
    assert.strictEqual(recorded.length, 1);
    assertOpenClawSubmitted(INSTRUCTION_TEXT, idempotencyKey(0), recorded[0]);
    assert.isFalse(
      recorded.some((event) => event instanceof OpenClawPrincipalFinalOutput),
    );
  });
}

function assertNanoclawInput(
  expectedText: string,
  event?: EvaluationEvent,
): void {
  if (!(event instanceof NanoclawPrincipalInputSent)) {
    assert.fail("expected a NanoClaw input event");
  }
  assert.strictEqual(event.caseId, CASE_ID);
  assert.strictEqual(event.agentName, TARGET_NAME);
  assert.strictEqual(event.agentId, TARGET_ID);
  assert.deepStrictEqual(
    event.input,
    NanoclawGatewayInput.make({ text: expectedText }),
  );
}

function assertNanoclawOutput(event?: EvaluationEvent): void {
  if (!(event instanceof NanoclawPrincipalOutputReceived)) {
    assert.fail("expected a NanoClaw output event");
  }
  assert.strictEqual(event.caseId, CASE_ID);
  assert.strictEqual(event.agentName, TARGET_NAME);
  assert.strictEqual(event.agentId, TARGET_ID);
  assert.deepStrictEqual(event.output, NANOCLAW_OUTPUT);
}

function recordingNanoclawGateway(
  inputs: Ref.Ref<readonly NanoclawGatewayInput[]>,
  outputPulls: Ref.Ref<number>,
): NanoclawGateway {
  return {
    submit: (input) => Ref.update(inputs, (received) => [...received, input]),
    outputs: Stream.fromEffect(
      Ref.updateAndGet(outputPulls, (count) => count + 1).pipe(
        Effect.as(NANOCLAW_OUTPUT),
      ),
    ).pipe(Stream.concat(Stream.never)),
  };
}

function nanoclawOutputObservationTest() {
  return Effect.gen(function* () {
    const recorder = yield* makeEventRecorder();
    const inputs = yield* Ref.make<readonly NanoclawGatewayInput[]>([]);
    const outputPulls = yield* Ref.make(0);
    const outputRecorded = yield* Deferred.make<undefined>();
    const gateway = recordingNanoclawGateway(inputs, outputPulls);
    const driver = yield* nanoclawPrincipalDriver.make(ATTEMPT_ID);
    const emit: EmitEvaluationEvent = (event) =>
      recorder
        .emit(event)
        .pipe(
          Effect.tap(() =>
            event instanceof NanoclawPrincipalOutputReceived
              ? Deferred.succeed(outputRecorded, undefined)
              : Effect.void,
          ),
        );

    yield* driver
      .observe(target(gateway), CASE_ID, emit)
      .pipe(Effect.forkScoped);
    yield* Deferred.await(outputRecorded);

    const recorded = yield* Ref.get(recorder.events);
    assert.strictEqual(recorded.length, 1);
    assertNanoclawOutput(recorded[0]);
    assert.strictEqual(yield* Ref.get(outputPulls), 1);
  }).pipe(Effect.scoped);
}

function nanoclawUncorrelatedOutputTest() {
  return Effect.gen(function* () {
    const recorder = yield* makeEventRecorder();
    const inputs = yield* Ref.make<readonly NanoclawGatewayInput[]>([]);
    const outputPulls = yield* Ref.make(0);
    const gateway = recordingNanoclawGateway(inputs, outputPulls);
    const driver = yield* nanoclawPrincipalDriver.make(ATTEMPT_ID);
    const secondMessage = "Submit another principal instruction.";

    const firstOutput = yield* driver.drive(
      target(gateway),
      INSTRUCTION,
      recorder.emit,
    );
    const secondOutput = yield* driver.drive(
      target(gateway),
      { caseId: CASE_ID, message: secondMessage },
      recorder.emit,
    );
    const recorded = yield* Ref.get(recorder.events);

    assert.deepStrictEqual(yield* Ref.get(inputs), [
      NanoclawGatewayInput.make({ text: INSTRUCTION_TEXT }),
      NanoclawGatewayInput.make({ text: secondMessage }),
    ]);
    assert.strictEqual(recorded.length, 2);
    assertNanoclawInput(INSTRUCTION_TEXT, recorded[0]);
    assertNanoclawInput(secondMessage, recorded[1]);
    assert.isTrue(Option.isNone(firstOutput));
    assert.isTrue(Option.isNone(secondOutput));
    assert.strictEqual(yield* Ref.get(outputPulls), 0);
  });
}

function nanoclawSubmitFailureTest() {
  return Effect.gen(function* () {
    const recorder = yield* makeEventRecorder();
    const failure = NanoclawGatewayError.make({
      operation: "submit",
      detail: "native socket rejected the input",
    });
    const gateway: NanoclawGateway = {
      submit: (input) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            input,
            NanoclawGatewayInput.make({ text: INSTRUCTION_TEXT }),
          );
          return yield* Effect.fail(failure);
        }),
      outputs: Stream.fromEffect(
        Effect.dieMessage("NanoClaw outputs were consumed after submit failed"),
      ),
    };
    const driver = yield* nanoclawPrincipalDriver.make(ATTEMPT_ID);

    const observed = yield* driver
      .drive(target(gateway), INSTRUCTION, recorder.emit)
      .pipe(Effect.flip);

    assert.instanceOf(observed, NanoclawGatewayError);
    assert.strictEqual(observed.operation, failure.operation);
    assert.strictEqual(observed.detail, failure.detail);
    assert.deepStrictEqual(yield* Ref.get(recorder.events), []);
  });
}

// @agent-code-guard/regression-only: native gateway ordering and failure tests pin the principal/social boundary without replacing runtime semantics
describe("runtime-native principal drivers", () => {
  test(
    "records OpenClaw submission before its native agent call and preserves its terminal output",
    openClawNativeRoundTripTest,
  );

  test(
    "does not fabricate OpenClaw terminal evidence after its native call fails",
    openClawFailureTest,
  );

  test(
    "keeps OpenClaw idempotency keys unique across sequential instructions",
    openClawUniqueKeysTest,
  );

  test(
    "records sequential NanoClaw inputs without consuming or correlating output frames",
    nanoclawUncorrelatedOutputTest,
  );

  test(
    "records NanoClaw output frames through an independent scoped observer",
    nanoclawOutputObservationTest,
  );

  test(
    "does not record NanoClaw input or consume output after submit fails",
    nanoclawSubmitFailureTest,
  );
});
