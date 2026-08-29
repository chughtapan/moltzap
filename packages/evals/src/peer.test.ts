/** @file Public HarnessEndpoint contract tests for autonomous evaluation peers. */

import { assert, it } from "@effect/vitest";
import {
  AgentAddress,
  type Content,
  DeliveryAcknowledgeError,
  type HarnessEndpoint,
  type InboundDelivery,
  PostId,
  type SendInput,
} from "@moltzap/client";
import { Deferred, Effect, Either, Queue, Schema, Stream } from "effect";
import { decodeEvaluationCaseId } from "./model.js";
import {
  EVALUATION_PEER_ACKNOWLEDGE_OPERATION,
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
const OTHER_ADDRESS = Schema.decodeSync(AgentAddress)("agent:other-peer");
const POST_ID = Schema.decodeSync(PostId)(`pst_${"A".repeat(43)}`);
const TARGET_OPENING = [{ type: "text", text: "Can you help?" }] as const;
const PEER_REPLY = [{ type: "text", text: "Yes, I can help." }] as const;
const TARGET_FOLLOW_UP = [
  { type: "text", text: "Thank you for helping." },
] as const;
const REACTIVE_OBSERVATIONS = [
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

function consumesTargetDeliveries() {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<InboundDelivery>();
    const sends: SendInput[] = [];
    const operations: string[] = [];
    yield* Queue.offer(
      queue,
      trackedDelivery(TARGET_OPENING, operations, "acknowledge opening"),
    );
    yield* Queue.offer(
      queue,
      trackedDelivery(TARGET_FOLLOW_UP, operations, "acknowledge follow-up"),
    );
    const endpoint: HarnessEndpoint = {
      send: (input) =>
        Effect.sync(() => {
          sends.push(input);
          operations.push("send");
        }),
      messages: Stream.fromQueue(queue),
    };
    const plan = reactivePeer(CASE_ID, TARGET_NAME, ["Yes, I can help."]);

    const exchange = yield* runEvaluationPeerApplication(
      { endpointAddress: LOCAL_ADDRESS, endpoint },
      plan.plan,
    ).pipe(Effect.scoped);

    assert.lengthOf(sends, 1);
    assert.deepStrictEqual(operations, [
      "send",
      "acknowledge opening",
      "acknowledge follow-up",
    ]);
    assert.strictEqual(sends[0]?.to, TARGET_ADDRESS);
    assert.deepStrictEqual(sends[0]?.content, PEER_REPLY);
    assert.deepStrictEqual(exchange.observations.map(observationFields), [
      ...REACTIVE_OBSERVATIONS,
    ]);
  });
}

function trackedDelivery(
  content: Content,
  operations: string[],
  operation: string,
  address?: typeof AgentAddress.Type,
): InboundDelivery {
  return delivery(content, {
    ...(address === undefined ? {} : { address }),
    acknowledge: Effect.sync(() => {
      operations.push(operation);
    }),
  });
}

function delivery(
  content: Content,
  options: Readonly<{
    address?: typeof AgentAddress.Type;
    acknowledge?: InboundDelivery["acknowledge"];
  }> = {},
): InboundDelivery {
  const address = options.address ?? TARGET_ADDRESS;
  return {
    message: {
      kind: "direct",
      postId: POST_ID,
      address,
      sender: address,
      content,
    },
    acknowledge: options.acknowledge ?? Effect.void,
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

// @agent-code-guard/regression-only: these examples pin peer ordering, acknowledgment, and typed endpoint failures.
it.effect(
  "consumes target deliveries and sends to their explicit address",
  consumesTargetDeliveries,
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
            yield* Queue.offer(
              queue,
              trackedDelivery(TARGET_FOLLOW_UP, operations, "acknowledge"),
            );
          }),
      };
      const plan = openingPeer(CASE_ID, TARGET_NAME, "Can you help?");

      const exchange = yield* runEvaluationPeerApplication(
        { endpointAddress: LOCAL_ADDRESS, endpoint },
        plan.plan,
      ).pipe(Effect.scoped);

      assert.deepStrictEqual(operations, ["messages", "send", "acknowledge"]);
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

it.effect("acknowledges deliveries skipped while finding the target", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<InboundDelivery>();
    const acknowledged: string[] = [];
    yield* Queue.offer(
      queue,
      delivery(TARGET_OPENING, {
        address: OTHER_ADDRESS,
        acknowledge: Effect.sync(() => {
          acknowledged.push("other");
        }),
      }),
    );
    yield* Queue.offer(
      queue,
      delivery(TARGET_OPENING, {
        acknowledge: Effect.sync(() => {
          acknowledged.push("opening");
        }),
      }),
    );
    yield* Queue.offer(
      queue,
      delivery(TARGET_FOLLOW_UP, {
        acknowledge: Effect.sync(() => {
          acknowledged.push("follow-up");
        }),
      }),
    );
    const endpoint: HarnessEndpoint = {
      send: () => Effect.void,
      messages: Stream.fromQueue(queue),
    };
    const plan = reactivePeer(CASE_ID, TARGET_NAME, ["Yes, I can help."]);

    yield* runEvaluationPeerApplication(
      { endpointAddress: LOCAL_ADDRESS, endpoint },
      plan.plan,
    ).pipe(Effect.scoped);

    assert.deepStrictEqual(acknowledged, ["other", "opening", "follow-up"]);
  }),
);

it.effect("reports acknowledgment failure at the endpoint boundary", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<InboundDelivery>();
    yield* Queue.offer(
      queue,
      delivery(TARGET_FOLLOW_UP, {
        acknowledge: Effect.fail(
          new DeliveryAcknowledgeError({ reason: "transport-failed" }),
        ),
      }),
    );
    const endpoint: HarnessEndpoint = {
      send: () => Effect.void,
      messages: Stream.fromQueue(queue),
    };
    const plan = openingPeer(CASE_ID, TARGET_NAME, "Can you help?");

    const result = yield* runEvaluationPeerApplication(
      { endpointAddress: LOCAL_ADDRESS, endpoint },
      plan.plan,
    ).pipe(Effect.scoped, Effect.either);

    Either.match(result, {
      onLeft: (peerFailure) => {
        assert.instanceOf(peerFailure, EvaluationPeerFailed);
        assert.strictEqual(
          peerFailure.operation,
          EVALUATION_PEER_ACKNOWLEDGE_OPERATION,
        );
      },
      onRight: () => {
        assert.fail();
      },
    });
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
