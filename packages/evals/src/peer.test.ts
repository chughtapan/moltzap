/** @file Public HarnessClient contract tests for autonomous evaluation peers. */

import { assert, it } from "@effect/vitest";
import {
  AgentName,
  type Content,
  ConversationId,
  type HarnessClient,
  type HarnessTurn,
  type StartInput,
  type VerifiedAgentCard,
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
const LOCAL_NAME = Schema.decodeSync(AgentName)("evaluation-peer");
const TARGET_NAME = Schema.decodeSync(AgentName)("evaluation-target");
const CONVERSATION_ID = Schema.decodeSync(ConversationId)(
  "00000000-0000-4000-8000-000000000505",
);
const TARGET = fakeCard("agt_target", TARGET_NAME);
const TARGET_OPENING = [{ type: "text", text: "Can you help?" }] as const;
const PEER_REPLY = [{ type: "text", text: "Yes, I can help." }] as const;
const TARGET_FOLLOW_UP = [
  { type: "text", text: "Thank you for helping." },
] as const;
const REACTIVE_OBSERVATIONS = [
  {
    authorName: TARGET_NAME,
    direction: "input",
    content: TARGET_OPENING,
  },
  {
    authorName: LOCAL_NAME,
    direction: "output",
    content: PEER_REPLY,
  },
  {
    authorName: TARGET_NAME,
    direction: "input",
    content: TARGET_FOLLOW_UP,
  },
] as const;

function openingObservations(conversationId: ConversationId) {
  return [
    {
      conversationId,
      authorName: LOCAL_NAME,
      direction: "output",
      content: TARGET_OPENING,
    },
    {
      conversationId,
      authorName: TARGET_NAME,
      direction: "input",
      content: TARGET_FOLLOW_UP,
    },
  ] as const;
}

function openingObservation(observation: EvaluationPeerObservation) {
  return {
    conversationId: observation.conversationId,
    authorName: observation.authorName,
    direction: observation.direction,
    content: observation.content,
  };
}

function fakeCard(
  agentId: string,
  agentName: typeof AgentName.Type,
): VerifiedAgentCard {
  const candidate: unknown = {
    agentId,
    agentName,
    principalId: `principal-${agentName}`,
    publicKey: { crv: "Ed25519", kty: "OKP", x: "fixture" },
    issuedAt: "2026-08-13T00:00:00Z",
  };
  if (!isFakeVerifiedAgentCard(candidate)) {
    throw new Error("invalid VerifiedAgentCard test fixture");
  }
  return candidate;
}

function isFakeVerifiedAgentCard(value: unknown): value is VerifiedAgentCard {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("agentId" in value) || typeof value.agentId !== "string") {
    return false;
  }
  return "agentName" in value && typeof value.agentName === "string";
}

function turn(input: {
  readonly content: Content;
  readonly reply: HarnessTurn["reply"];
  readonly conversationId?: ConversationId;
}): HarnessTurn {
  return {
    conversationId: input.conversationId ?? CONVERSATION_ID,
    peers: [TARGET],
    author: TARGET,
    content: input.content,
    reply: input.reply,
  };
}

it.effect(
  "consumes queued target turns and replies through the turn-bound capability",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<HarnessTurn>();
      const replies: Content[] = [];
      let unrelatedReplyUsed = false;
      yield* Queue.offer(
        queue,
        turn({
          content: TARGET_OPENING,
          reply: (content) =>
            Effect.sync(() => {
              replies.push(content);
            }),
        }),
      );
      yield* Queue.offer(
        queue,
        turn({
          content: TARGET_FOLLOW_UP,
          reply: () =>
            Effect.sync(() => {
              unrelatedReplyUsed = true;
            }),
        }),
      );
      const client: HarnessClient = {
        start: () => Effect.dieMessage("reactive peers do not initiate START"),
        turns: Stream.fromQueue(queue),
      };
      const plan = reactivePeer(CASE_ID, TARGET_NAME, ["Yes, I can help."]);

      const exchange = yield* runEvaluationPeerApplication(
        { agentName: LOCAL_NAME, client },
        plan.plan,
      ).pipe(Effect.scoped);

      assert.deepStrictEqual(replies, [PEER_REPLY]);
      assert.isFalse(unrelatedReplyUsed);
      assert.deepStrictEqual(
        exchange.observations.map((observation) => ({
          authorName: observation.authorName,
          direction: observation.direction,
          content: observation.content,
        })),
        [...REACTIVE_OBSERVATIONS],
      );
    }),
);

it.effect(
  "establishes turns before START and records the target's returned action",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<HarnessTurn>();
      const turnsEstablished = yield* Deferred.make<undefined>();
      const operations: string[] = [];
      let startInput: StartInput | undefined;
      const client: HarnessClient = {
        turns: Stream.unwrap(
          Effect.gen(function* () {
            operations.push("turns");
            yield* Deferred.succeed(turnsEstablished, undefined);
            return Stream.fromQueue(queue);
          }),
        ),
        start: (input) =>
          Effect.gen(function* () {
            yield* Deferred.await(turnsEstablished);
            operations.push("start");
            startInput = input;
            yield* Queue.offer(
              queue,
              turn({
                conversationId: input.conversationId,
                content: TARGET_FOLLOW_UP,
                reply: () =>
                  Effect.dieMessage("opening exchange does not reply again"),
              }),
            );
          }),
      };
      const plan = openingPeer(CASE_ID, TARGET_NAME, "Can you help?");

      const exchange = yield* runEvaluationPeerApplication(
        { agentName: LOCAL_NAME, client },
        plan.plan,
      ).pipe(Effect.scoped);

      assert.deepStrictEqual(operations, ["turns", "start"]);
      assert.isDefined(startInput);
      if (startInput === undefined) {
        return;
      }
      assert.isTrue(Schema.is(ConversationId)(startInput.conversationId));
      assert.deepStrictEqual(startInput.peers, [TARGET_NAME]);
      assert.deepStrictEqual(startInput.content, TARGET_OPENING);
      assert.deepStrictEqual(exchange.observations.map(openingObservation), [
        ...openingObservations(startInput.conversationId),
      ]);
    }),
);

it("keeps an idle roster member untriggerable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let startUsed = false;
      let turnsUsed = false;
      const client: HarnessClient = {
        get turns() {
          turnsUsed = true;
          return Stream.empty;
        },
        start: () =>
          Effect.sync(() => {
            startUsed = true;
          }),
      };
      const plan = idlePeer(CASE_ID);

      const result = yield* runEvaluationPeerApplication(
        { agentName: LOCAL_NAME, client },
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
      assert.isFalse(startUsed);
      assert.isFalse(turnsUsed);
    }),
  ));
