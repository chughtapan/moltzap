/** @file Public HarnessEndpoint contract tests for autonomous evaluation peers. */

import { assert, it } from "@effect/vitest";
import {
  AgentAddress,
  type Content,
  type HarnessEndpoint,
  type InboundDelivery,
  PostId,
  type SendInput,
} from "@moltzap/client";
import { Deferred, Effect, Either, Queue, Schema, Stream } from "effect";
import { decodeEvaluationCaseId } from "./model.js";
import {
  EvaluationPeerFailed,
  type EvaluationPeerObservation,
  idlePeer,
  openingPeer,
  reactivePeer,
  runEvaluationPeerApplication,
} from "./peer.js";

const CASE_ID = decodeEvaluationCaseId("EVAL-005");
const LOCAL_NAME = "evaluation-peer";
const TARGET_NAME = "evaluation-target";
const LOCAL_ADDRESS = Schema.decodeSync(AgentAddress)(`agent:${LOCAL_NAME}`);
const TARGET_ADDRESS = Schema.decodeSync(AgentAddress)(`agent:${TARGET_NAME}`);
const POST_ID = Schema.decodeSync(PostId)(`pst_${"A".repeat(43)}`);
const TARGET_OPENING = [{ type: "text", text: "Can you help?" }] as const;
const PEER_REPLY = [{ type: "text", text: "Yes, I can help." }] as const;
const TARGET_FOLLOW_UP = [
  { type: "text", text: "Thank you for helping." },
] as const;
const OPENING_OBSERVATIONS = [
  {
    endpointAddress: LOCAL_ADDRESS,
    address: TARGET_ADDRESS,
    authorAddress: LOCAL_ADDRESS,
    direction: "output",
    content: TARGET_OPENING,
  },
  {
    endpointAddress: LOCAL_ADDRESS,
    address: TARGET_ADDRESS,
    authorAddress: TARGET_ADDRESS,
    direction: "input",
    content: TARGET_FOLLOW_UP,
  },
] as const;

function delivery(content: Content): InboundDelivery {
  return {
    message: {
      kind: "direct",
      postId: POST_ID,
      address: TARGET_ADDRESS,
      sender: TARGET_ADDRESS,
      content,
    },
    acknowledge: Effect.void,
  };
}

function observationFields(observation: EvaluationPeerObservation) {
  return {
    endpointAddress: observation.endpointAddress,
    address: observation.address,
    authorAddress: observation.authorAddress,
    direction: observation.direction,
    content: observation.content,
  };
}

it.effect(
  "consumes target deliveries and sends to their explicit address",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<InboundDelivery>();
      const sends: SendInput[] = [];
      yield* Queue.offer(queue, delivery(TARGET_OPENING));
      yield* Queue.offer(queue, delivery(TARGET_FOLLOW_UP));
      const endpoint: HarnessEndpoint = {
        send: (input) =>
          Effect.sync(() => {
            sends.push(input);
          }),
        messages: Stream.fromQueue(queue),
      };
      const plan = reactivePeer(CASE_ID, TARGET_NAME, ["Yes, I can help."]);

      const exchange = yield* runEvaluationPeerApplication(
        { endpointAddress: LOCAL_ADDRESS, endpoint },
        plan.plan,
      ).pipe(Effect.scoped);

      assert.lengthOf(sends, 1);
      assert.strictEqual(sends[0]?.to, TARGET_ADDRESS);
      assert.deepStrictEqual(sends[0]?.content, PEER_REPLY);
      assert.deepStrictEqual(exchange.observations.map(observationFields), [
        {
          endpointAddress: LOCAL_ADDRESS,
          address: TARGET_ADDRESS,
          authorAddress: TARGET_ADDRESS,
          direction: "input",
          content: TARGET_OPENING,
        },
        {
          endpointAddress: LOCAL_ADDRESS,
          address: TARGET_ADDRESS,
          authorAddress: LOCAL_ADDRESS,
          direction: "output",
          content: PEER_REPLY,
        },
        {
          endpointAddress: LOCAL_ADDRESS,
          address: TARGET_ADDRESS,
          authorAddress: TARGET_ADDRESS,
          direction: "input",
          content: TARGET_FOLLOW_UP,
        },
      ]);
    }),
);

it.effect(
  "establishes the message stream before its first addressed send",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<InboundDelivery>();
      const messagesEstablished = yield* Deferred.make<undefined>();
      const operations: string[] = [];
      let sendInput: SendInput | undefined;
      const endpoint: HarnessEndpoint = {
        messages: Stream.unwrap(
          Effect.gen(function* () {
            operations.push("messages");
            yield* Deferred.succeed(messagesEstablished, undefined);
            return Stream.fromQueue(queue);
          }),
        ),
        send: (input) =>
          Effect.gen(function* () {
            yield* Deferred.await(messagesEstablished);
            operations.push("send");
            sendInput = input;
            yield* Queue.offer(queue, delivery(TARGET_FOLLOW_UP));
          }),
      };
      const plan = openingPeer(CASE_ID, TARGET_NAME, "Can you help?");

      const exchange = yield* runEvaluationPeerApplication(
        { endpointAddress: LOCAL_ADDRESS, endpoint },
        plan.plan,
      ).pipe(Effect.scoped);

      assert.deepStrictEqual(operations, ["messages", "send"]);
      assert.isDefined(sendInput);
      if (sendInput === undefined) {
        return;
      }
      assert.strictEqual(sendInput.to, TARGET_ADDRESS);
      assert.deepStrictEqual(sendInput.content, TARGET_OPENING);
      assert.deepStrictEqual(exchange.observations.map(observationFields), [
        ...OPENING_OBSERVATIONS,
      ]);
    }),
);

it("keeps an idle roster member untriggerable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let sendUsed = false;
      let messagesUsed = false;
      const endpoint: HarnessEndpoint = {
        get messages() {
          messagesUsed = true;
          return Stream.empty;
        },
        send: () =>
          Effect.sync(() => {
            sendUsed = true;
          }),
      };
      const plan = idlePeer(CASE_ID);

      const result = yield* runEvaluationPeerApplication(
        { endpointAddress: LOCAL_ADDRESS, endpoint },
        plan.plan,
      ).pipe(Effect.scoped, Effect.either);

      Either.match(result, {
        onLeft: (failure) => {
          assert.instanceOf(failure, EvaluationPeerFailed);
        },
        onRight: () => {
          assert.fail();
        },
      });
      assert.isFalse(sendUsed);
      assert.isFalse(messagesUsed);
    }),
  ));
