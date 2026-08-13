import { assert, it } from "@effect/vitest";
import { AgentName as agentName } from "@moltzap/client";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import type { EventOf } from "@moltzap/simulator";
import { createHash } from "node:crypto";
import {
  NanoClawGatewayOutput,
  type NanoClawGateway,
  type NanoClawGatewayError,
  type NanoClawGatewayInput,
  OpenClawGatewayResponse,
  type OpenClawGateway,
  type OpenClawGatewayRequestError,
  type StartedAgent,
} from "@moltzap/simulator/agents";
import { makeAgentHandle } from "@moltzap/simulator/network";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Ref,
  Schema,
  Stream,
  TestClock,
} from "effect";
import {
  PEER_AGENT_NAME,
  TARGET_AGENT_NAME,
  evaluationCases,
  type EvaluationCaseDefinition,
  type EvaluationCasePeers,
  type EvaluationCasePeerDefinitions,
} from "./cases.js";
import {
  CodePeerMessageReceived,
  EvaluationEvidenceSelected,
  NanoClawPrincipalInputSent,
  NanoClawPrincipalOutputReceived,
  OpenClawPrincipalFinalOutput,
  OpenClawPrincipalInstructionAttempted,
  PeerExchangeNotObserved,
  type evaluationEvents,
} from "./events.js";
import {
  openClawEvaluationCondition,
  runEvaluationCase,
  type EvaluationCaseInstrumentation,
  type EvaluationProgramFailed,
} from "./execution.js";
import { decodeEvaluationEvidenceId } from "./model.js";
import { PeerExchange, type EvaluationPeerGateway } from "./peer.js";
import {
  nanoclawPrincipalDriver,
  openClawPrincipalDriver,
  type EmitEvaluationEvent,
} from "./principal.js";

const test = it.effect;
const TARGET_ID = agentId("00000000-0000-4000-8000-000000000901");
const PEER_ID = agentId("00000000-0000-4000-8000-000000000902");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000904");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000905");
const PEER_NAME = Schema.decodeSync(agentName)(PEER_AGENT_NAME);
const PRINCIPAL_OPERATION: EvaluationProgramFailed["operation"] = "principal";
const SOCIAL_RESPONSE = "A MoltZap conversation is a shared address.";
const GATEWAY_RESPONSE = Schema.decodeSync(OpenClawGatewayResponse)({
  runId: "execution-test-openclaw",
  status: "ok",
  summary: "completed",
  result: { payloads: [{ text: "I contacted the requested peer." }] },
});
const NANOCLAW_OUTPUT = NanoClawGatewayOutput.make({
  text: "Uncorrelated native output.",
});
const EXPECTED_OPENCLAW_TOOLS = {
  allow: ["message"],
  sandbox: {
    tools: {
      allow: ["message"],
    },
  },
  elevated: { enabled: false },
  exec: { mode: "full" },
};
const bundledOpenClawPolicyConfiguration = Schema.Struct({
  tools: Schema.Struct({
    definitionDigest: Schema.String,
    redacted: Schema.Tuple(Schema.Literal("configuration")),
  }),
  sandbox: Schema.optional(Schema.Unknown),
});

type EvaluationEvent = EventOf<typeof evaluationEvents>;
type SocialPeerRuntimes = (typeof evaluationCases)[0]["peers"];
type PrincipalPeerRuntimes = (typeof evaluationCases)[7]["peers"];

interface RecordedEvent {
  readonly eventId: string;
  readonly event: EvaluationEvent;
}

interface EventRecorder {
  readonly records: Ref.Ref<readonly RecordedEvent[]>;
  readonly emit: EmitEvaluationEvent;
}

function eventRecorder(): Effect.Effect<EventRecorder> {
  return Effect.gen(function* () {
    const records = yield* Ref.make<readonly RecordedEvent[]>([]);
    const emit: EmitEvaluationEvent = (event) =>
      Ref.modify(records, (current) => {
        const eventId = `execution-test:${String(current.length)}`;
        const record = {
          runId: "execution-test",
          eventId,
          logicalSequence: current.length,
          elapsedNanos: BigInt(current.length),
          observedAt: current.length,
          producer: "execution-test",
          event,
        };
        return [record, [...current, record]];
      });
    return { records, emit };
  });
}

function target<Gateway>(
  gateway: Gateway,
): StartedAgent<typeof TARGET_AGENT_NAME, Gateway> {
  return {
    agent: makeAgentHandle(TARGET_AGENT_NAME, TARGET_ID),
    gateway,
    termination: Effect.never,
  };
}

function peer<const Name extends string>(
  name: Name,
  id: ReturnType<typeof agentId>,
  gateway: EvaluationPeerGateway,
): StartedAgent<Name, EvaluationPeerGateway> {
  return {
    agent: makeAgentHandle(name, id),
    gateway,
    termination: Effect.never,
  };
}

function selectedSocialGateway(
  caseId: (typeof evaluationCases)[0]["id"],
): EvaluationPeerGateway {
  return {
    exchange: Effect.succeed(
      new PeerExchange({
        observations: [
          CodePeerMessageReceived.make({
            caseId,
            agentName: PEER_NAME,
            agentId: PEER_ID,
            conversationId: CONVERSATION_ID,
            messageId: MESSAGE_ID,
            senderId: TARGET_ID,
            parts: [{ type: "text", text: SOCIAL_RESPONSE }],
          }),
        ],
      }),
    ),
  };
}

function instrumentation<PeerRuntimes extends EvaluationCasePeerDefinitions>(
  definition: EvaluationCaseDefinition<PeerRuntimes>,
  peers: EvaluationCasePeers<PeerRuntimes>,
  emit: EmitEvaluationEvent,
): Effect.Effect<
  EvaluationCaseInstrumentation<
    OpenClawGateway,
    OpenClawGatewayRequestError,
    PeerRuntimes
  >
> {
  return openClawPrincipalDriver.make("execution-test-attempt").pipe(
    Effect.map((driver) => ({
      definition,
      policy: {
        peerObservationTimeout: Duration.millis(10),
        caseTimeout: Duration.seconds(2),
      },
      target: target({
        agent: () => Effect.succeed(GATEWAY_RESPONSE),
      }),
      peers,
      driver,
      emit,
    })),
  );
}

function socialPeers(
  gateway: EvaluationPeerGateway,
): EvaluationCasePeers<SocialPeerRuntimes> {
  return {
    [PEER_AGENT_NAME]: peer(PEER_AGENT_NAME, PEER_ID, gateway),
  };
}

function principalPeers(): EvaluationCasePeers<PrincipalPeerRuntimes> {
  return {};
}

function nanoclawGateway(
  submitted: Ref.Ref<readonly NanoClawGatewayInput[]>,
): NanoClawGateway {
  return {
    submit: (input) => Ref.update(submitted, (current) => [...current, input]),
    outputs: Stream.never,
  };
}

function nanoclawInstrumentation<
  PeerRuntimes extends EvaluationCasePeerDefinitions,
>(
  definition: EvaluationCaseDefinition<PeerRuntimes>,
  peers: EvaluationCasePeers<PeerRuntimes>,
  gateway: NanoClawGateway,
  emit: EmitEvaluationEvent,
): Effect.Effect<
  EvaluationCaseInstrumentation<
    NanoClawGateway,
    NanoClawGatewayError,
    PeerRuntimes
  >
> {
  return nanoclawPrincipalDriver.make("execution-test-attempt").pipe(
    Effect.map((driver) => ({
      definition,
      policy: {
        peerObservationTimeout: Duration.millis(10),
        caseTimeout: Duration.seconds(2),
      },
      target: target(gateway),
      peers,
      driver,
      emit,
    })),
  );
}

function assertNativePrelude(records: readonly RecordedEvent[]): void {
  assert.instanceOf(records[0]?.event, OpenClawPrincipalInstructionAttempted);
  assert.instanceOf(records[1]?.event, OpenClawPrincipalFinalOutput);
}

function assertSingleFinalSelection(
  records: readonly RecordedEvent[],
): EvaluationEvidenceSelected {
  const selections = records.filter(
    (
      record,
    ): record is RecordedEvent & {
      readonly event: EvaluationEvidenceSelected;
    } => record.event instanceof EvaluationEvidenceSelected,
  );
  assert.lengthOf(selections, 1);
  const [selection] = selections;
  assert.isDefined(selection);
  if (selection === undefined) {
    return assert.fail("expected one final evidence selection");
  }
  assert.strictEqual(records[records.length - 1], selection);
  return selection.event;
}

function socialSelectionTest() {
  return Effect.gen(function* () {
    const definition = evaluationCases[0];
    const recorder = yield* eventRecorder();
    const acquired = yield* instrumentation(
      definition,
      socialPeers(selectedSocialGateway(definition.id)),
      recorder.emit,
    );
    yield* runEvaluationCase(acquired);
    const records = yield* Ref.get(recorder.records);

    assertNativePrelude(records);
    assert.instanceOf(records[2]?.event, CodePeerMessageReceived);
    const selection = assertSingleFinalSelection(records);
    assert.strictEqual(
      selection.selectedEventId,
      decodeEvaluationEvidenceId("execution-test:2"),
    );
  });
}

function principalSelectionTest() {
  return Effect.gen(function* () {
    const definition = evaluationCases[7];
    const recorder = yield* eventRecorder();
    const acquired = yield* instrumentation(
      definition,
      principalPeers(),
      recorder.emit,
    );
    yield* runEvaluationCase(acquired);
    const records = yield* Ref.get(recorder.records);

    assertNativePrelude(records);
    const selection = assertSingleFinalSelection(records);
    assert.strictEqual(
      selection.selectedEventId,
      decodeEvaluationEvidenceId("execution-test:1"),
    );
  });
}

function missingSocialOutputTest() {
  return Effect.gen(function* () {
    const definition = evaluationCases[0];
    const recorder = yield* eventRecorder();
    const acquired = yield* instrumentation(
      definition,
      socialPeers({ exchange: Effect.never }),
      recorder.emit,
    );
    const running = yield* runEvaluationCase(acquired).pipe(Effect.fork);
    yield* TestClock.adjust(Duration.millis(10));
    yield* Fiber.join(running);
    const records = yield* Ref.get(recorder.records);

    assertNativePrelude(records);
    assert.instanceOf(records[2]?.event, PeerExchangeNotObserved);
    const selection = assertSingleFinalSelection(records);
    assert.strictEqual(
      selection.selectedEventId,
      decodeEvaluationEvidenceId("execution-test:2"),
    );
  });
}

function assertUnsupportedPrincipalOutput(
  failure: EvaluationProgramFailed,
): void {
  assert.strictEqual(failure.operation, PRINCIPAL_OPERATION);
  assert.include(failure.detail, "does not correlate a terminal output");
}

function nanoclawPrincipalOutputUnsupportedTest() {
  return Effect.gen(function* () {
    const definition = evaluationCases[7];
    const recorder = yield* eventRecorder();
    const submitted = yield* Ref.make<readonly NanoClawGatewayInput[]>([]);
    const acquired = yield* nanoclawInstrumentation(
      definition,
      principalPeers(),
      nanoclawGateway(submitted),
      recorder.emit,
    );

    const failure = yield* runEvaluationCase(acquired).pipe(Effect.flip);
    assertUnsupportedPrincipalOutput(failure);
    assert.lengthOf(yield* Ref.get(submitted), 1);
    const records = yield* Ref.get(recorder.records);
    assert.lengthOf(records, 1);
    assert.instanceOf(records[0]?.event, NanoClawPrincipalInputSent);
    assert.isFalse(
      records.some(({ event }) => event instanceof EvaluationEvidenceSelected),
    );
  });
}

function outputRecordingEmit(
  recorder: EventRecorder,
  outputRecorded: Deferred.Deferred<undefined>,
): EmitEvaluationEvent {
  return (event) =>
    recorder
      .emit(event)
      .pipe(
        Effect.tap(() =>
          event instanceof NanoClawPrincipalOutputReceived
            ? Deferred.succeed(outputRecorded, undefined)
            : Effect.void,
        ),
      );
}

function outputBeforeSubmitGateway(
  submitted: Ref.Ref<readonly NanoClawGatewayInput[]>,
  outputRecorded: Deferred.Deferred<undefined>,
): NanoClawGateway {
  return {
    submit: (input) =>
      Ref.update(submitted, (current) => [...current, input]).pipe(
        Effect.andThen(Deferred.await(outputRecorded)),
      ),
    outputs: Stream.make(NANOCLAW_OUTPUT).pipe(Stream.concat(Stream.never)),
  };
}

function assertUncorrelatedNanoClawEvidence(
  records: readonly RecordedEvent[],
): void {
  assert.lengthOf(
    records.filter(
      ({ event }) => event instanceof NanoClawPrincipalOutputReceived,
    ),
    1,
  );
  assert.lengthOf(
    records.filter(({ event }) => event instanceof CodePeerMessageReceived),
    1,
  );
  assert.lengthOf(
    records.filter(({ event }) => event instanceof NanoClawPrincipalInputSent),
    1,
  );
  assert.isFalse(
    records.some(({ event }) => event instanceof EvaluationEvidenceSelected),
  );
}

function nanoclawIdentityOutputUnsupportedTest() {
  return Effect.gen(function* () {
    const definition = evaluationCases[9];
    const recorder = yield* eventRecorder();
    const submitted = yield* Ref.make<readonly NanoClawGatewayInput[]>([]);
    const outputRecorded = yield* Deferred.make<undefined>();
    const acquired = yield* nanoclawInstrumentation(
      definition,
      {
        [PEER_AGENT_NAME]: peer(
          PEER_AGENT_NAME,
          PEER_ID,
          selectedSocialGateway(definition.id),
        ),
      },
      outputBeforeSubmitGateway(submitted, outputRecorded),
      outputRecordingEmit(recorder, outputRecorded),
    );

    const failure = yield* runEvaluationCase(acquired).pipe(Effect.flip);
    assertUnsupportedPrincipalOutput(failure);
    assert.lengthOf(yield* Ref.get(submitted), 1);
    assertUncorrelatedNanoClawEvidence(yield* Ref.get(recorder.records));
  });
}

function policyDigest(policy: object): string {
  const definition = JSON.stringify(policy);
  if (definition === undefined) {
    throw new TypeError("expected a JSON-serializable policy");
  }
  return createHash("sha256").update(definition, "utf8").digest("hex");
}

function bundledOpenClawPolicyTest(): void {
  const condition = openClawEvaluationCondition({
    runtime: {},
    execution: {
      peerObservationTimeout: Duration.seconds(1),
      caseTimeout: Duration.seconds(2),
    },
  });
  const configuration = Schema.decodeUnknownSync(
    bundledOpenClawPolicyConfiguration,
  )(condition.runtimeConfiguration);
  assert.deepStrictEqual(configuration.tools, {
    definitionDigest: policyDigest(EXPECTED_OPENCLAW_TOOLS),
    redacted: ["configuration"],
  });
  assert.isUndefined(configuration.sandbox);
}

// @agent-code-guard/regression-only: native gateway output and autonomous social evidence have distinct selection paths
test(
  "selects the target's router-bound social observation",
  socialSelectionTest,
);
test(
  "selects native principal output when case policy requests it",
  principalSelectionTest,
);
test(
  "selects bounded absence when required social output is not observed",
  missingSocialOutputTest,
);
test(
  "fails a NanoClaw principal-output case without selecting its input",
  nanoclawPrincipalOutputUnsupportedTest,
);
test(
  "fails a NanoClaw identity case without inventing terminal output",
  nanoclawIdentityOutputUnsupportedTest,
);
it(
  "locks bundled OpenClaw conditions to the digested fail-closed policy",
  bundledOpenClawPolicyTest,
);
