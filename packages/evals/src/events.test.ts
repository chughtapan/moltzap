/** @file Native and semantic observations remain independently selectable. */

import { assert, it } from "@effect/vitest";
import { AgentAddress } from "@moltzap/client";
import {
  OpenClawGatewayRequest,
  OpenClawGatewayResponse,
} from "@moltzap/simulator/agents";
import { Effect, Schema, Stream } from "effect";
import { evaluationCase } from "./cases.js";
import {
  EvaluationEvidenceSelected,
  OpenClawPrincipalFinalOutput,
  OpenClawPrincipalInstructionAttempted,
  projectEvaluationEvidence,
  SocialActionObserved,
} from "./events.js";
import { decodeEvaluationCaseId, decodeEvaluationEvidenceId } from "./model.js";
import { SocialTranscriptItem, transcriptFromLedger } from "./transcript.js";

const caseId = decodeEvaluationCaseId("EVAL-005");
const target = "evaluation-target";
const peer = "evaluation-peer";
const targetAddress = Schema.decodeSync(AgentAddress)(`agent:${target}`);
const peerAddress = Schema.decodeSync(AgentAddress)(`agent:${peer}`);
const gatewayInputId = decodeEvaluationEvidenceId("evidence:gateway-input");
const gatewayOutputId = decodeEvaluationEvidenceId("evidence:gateway-output");
const socialId = decodeEvaluationEvidenceId("evidence:social");
const gatewayResponse = Schema.decodeSync(OpenClawGatewayResponse)({
  runId: "events-test-run",
  status: "ok",
  summary: "completed",
  result: { payloads: [{ text: "I contacted the peer." }] },
});

const gatewayInput = OpenClawPrincipalInstructionAttempted.make({
  caseId,
  agentName: target,
  request: OpenClawGatewayRequest.make({
    message: "Contact the peer.",
    idempotencyKey: "events-test",
  }),
});
const gatewayOutput = OpenClawPrincipalFinalOutput.make({
  caseId,
  agentName: target,
  idempotencyKey: "events-test",
  output: gatewayResponse,
});
const social = SocialActionObserved.make({
  caseId,
  endpointAddress: peerAddress,
  address: targetAddress,
  authorAddress: targetAddress,
  direction: "input",
  content: [{ type: "text", text: "The target replied." }],
});

function record(eventId: string, logicalSequence: number, event: unknown) {
  return { eventId, logicalSequence, event };
}

it("projects and selects a public semantic target action", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const records = [
        record(gatewayInputId, 0, gatewayInput),
        record(gatewayOutputId, 1, gatewayOutput),
        record(socialId, 2, social),
        record(
          "evidence:selection",
          3,
          EvaluationEvidenceSelected.make({
            caseId,
            selectedEventId: socialId,
          }),
        ),
      ];
      const evidence = yield* projectEvaluationEvidence({
        records: Stream.fromIterable(records),
      });

      assert.deepStrictEqual(
        evidence.gateway.map(({ eventId }) => eventId),
        [gatewayInputId, gatewayOutputId],
      );
      assert.deepStrictEqual(
        evidence.social.map(({ eventId }) => eventId),
        [socialId],
      );
      assert.deepStrictEqual(evidence.selectedEventIds, [socialId]);

      const definition = evaluationCase(caseId);
      assert.isDefined(definition);
      if (definition !== undefined) {
        const transcript = yield* transcriptFromLedger(
          { records: Stream.fromIterable(records) },
          definition,
        );
        const selected = transcript.items.find(
          ({ evidenceId }) => evidenceId === socialId,
        );
        assert.instanceOf(selected, SocialTranscriptItem);
        if (selected instanceof SocialTranscriptItem) {
          assert.strictEqual(selected.actorName, target);
          assert.strictEqual(selected.endpointName, peer);
        }
      }
    }),
  ));
