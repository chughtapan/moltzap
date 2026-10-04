/** @file Pins how the collective layer runs an all_gather at its requester and members. */

import {
  Deferred,
  Duration,
  Effect,
  Encoding,
  Fiber,
  Option,
  Schema,
  type Scope,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import type { EngineSendInput, EngineSentPost } from "../messaging/index.js";
import type { InboundItem } from "./inbound.js";
import { AgentAddress } from "../messaging/address.js";
import { SendError } from "../messaging/errors.js";
import { InboundMessage } from "../messaging/message.js";
import { PostId, RecordHash } from "../wire/index.js";
import { CollectiveEmitError, CollectiveError, SendInput } from "./forms.js";
import {
  type CollectiveOperations,
  type CollectivePorts,
  makeCollectiveOperations,
} from "./operation.js";
import { collectiveIdOf, readCollectiveValue } from "./wire.js";

const collectiveKey = "xyz.moltzap/collective";
const group = "group:alice,bob,carol";
const groupMembers = ["agent:alice", "agent:bob", "agent:carol"];
const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
};
const alice = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const requestNonce = "N".repeat(43);
const requestId = collectiveIdOf(alice, requestNonce);
const otherId = `col_${"B".repeat(43)}`;
const questionText = "Which day works?";

const bytes = (byte: number) =>
  Encoding.encodeBase64Url(new Uint8Array(32).fill(byte));
const postId = (byte: number) =>
  Schema.decodeUnknownSync(PostId)(`pst_${bytes(byte)}`);
const recordHash = (byte: number) =>
  Schema.decodeUnknownSync(RecordHash)(`rch_${bytes(byte)}`);

interface Observed {
  readonly sent: EngineSendInput[];
  readonly emitted: InboundItem[];
}

const newObserved = (): Observed => ({ sent: [], emitted: [] });

/**
 * Certify a post the way the engine does: the nth post sent gets PostId and
 * record hash byte `100 + n`.
 */
const certify = (observed: Observed, input: EngineSendInput) =>
  Effect.sync((): EngineSentPost => {
    observed.sent.push(input);
    return {
      postId: postId(100 + observed.sent.length),
      recordHash: recordHash(100 + observed.sent.length),
    };
  });

/** A collective layer for `self` over recording ports. */
const makeLayer = (
  observed: Observed,
  self: string,
  overrides: Partial<
    Pick<CollectivePorts, "sendPost" | "lookupMember" | "emit">
  > = {},
): Effect.Effect<CollectiveOperations, never, Scope.Scope> =>
  Effect.map(Effect.scope, (scope) =>
    makeCollectiveOperations({
      self: Schema.decodeUnknownSync(AgentAddress)(self),
      lookupMember: () => Effect.void,
      sendPost: (input) => certify(observed, input),
      emit: (item) =>
        Effect.sync(() => {
          observed.emitted.push(item);
        }),
      scope,
      requestSendWait: Duration.seconds(1),
      ...overrides,
    }),
  );

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  );

/** Let forked fibers, such as a requester's close, run to their next wait. */
const settle = Effect.yieldNow().pipe(Effect.repeatN(5));

const requestValue = {
  kind: "operation",
  op: "all_gather",
  id: requestId,
  nonce: requestNonce,
  deadlineAt: 60_000,
  requestedSchema: slotSchema,
};

const groupPost = (sender: string, byte: number, value: object) =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "group",
    postId: postId(byte),
    address: group,
    sender,
    members: groupMembers,
    content: [
      ...(value === requestValue ? [{ type: "text", text: questionText }] : []),
      { type: "data", value: { [collectiveKey]: value } },
    ],
  });

const classify = (
  layer: CollectiveOperations,
  sender: string,
  byte: number,
  value: object,
) =>
  layer.classify({
    message: groupPost(sender, byte, value),
    recordHash: recordHash(byte),
  });

const answer = (id: string, slot: string) => ({
  kind: "response",
  id,
  action: "accept",
  content: { slot },
});

const close = (id: string, included: readonly number[]) => ({
  kind: "close",
  id,
  included: included.map(recordHash),
});

const send = (layer: CollectiveOperations, input: unknown) =>
  layer.send(Schema.decodeUnknownSync(SendInput)(input), "result");

const allGatherInput = (to = group) => ({
  to,
  text: questionText,
  collective: { op: "all_gather", deadline: 60, requestedSchema: slotSchema },
});

const startAllGather = (layer: CollectiveOperations) =>
  send(layer, allGatherInput()).pipe(
    Effect.flatMap((outcome) =>
      Option.fromNullable(outcome.operationId).pipe(
        Effect.orElse(() => Effect.dieMessage("all_gather returned no id")),
      ),
    ),
  );

const respond = (layer: CollectiveOperations, slot: string) =>
  send(layer, {
    to: group,
    collectiveResponse: { action: "accept", content: { slot } },
  });

const failureOf = <A>(effect: Effect.Effect<A, SendError | CollectiveError>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) =>
      error instanceof CollectiveError ? error.failure : error,
    ),
  );

function sendsOneRequestPostToTheGroup() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice");
      const id = yield* startAllGather(layer);
      const [first] = observed.sent;
      const request =
        first === undefined
          ? Option.none()
          : yield* readCollectiveValue(first.content);
      const nonce = Option.match(request, {
        onNone: () => "",
        onSome: (value) => ("nonce" in value ? value.nonce : ""),
      });

      expect(collectiveIdOf(alice, nonce)).toBe(id);
      expect(observed.sent).toEqual([
        {
          to: group,
          content: [
            { type: "text", text: questionText },
            {
              type: "data",
              value: {
                [collectiveKey]: {
                  kind: "operation",
                  op: "all_gather",
                  id,
                  nonce,
                  deadlineAt: 60_000,
                  requestedSchema: slotSchema,
                },
              },
            },
          ],
        },
      ]);
    }),
  );
}

function refusesAnAllGatherToAnAgentAddress() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice");
      const failure = yield* failureOf(
        send(layer, allGatherInput("agent:bob")),
      );

      expect(failure).toMatchObject({ reason: "membership-invalid" });
    }),
  );
}

function namesTheMemberWhoseLookupFailsWhenTheGroupPostIsRefused() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice", {
        sendPost: () =>
          Effect.fail(new SendError({ reason: "network-unavailable" })),
        lookupMember: (member) =>
          member === "agent:carol"
            ? Effect.fail(new SendError({ reason: "network-unavailable" }))
            : Effect.void,
      });
      const failure = yield* failureOf(send(layer, allGatherInput()));

      expect(failure).toEqual({
        kind: "members-unreachable",
        members: [{ member: "agent:carol", reason: "network-unavailable" }],
      });
    }),
  );
}

function refusesAnAllGatherWithAnUnknownMemberBeforePosting() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const posts = { attempted: 0 };
      const layer = yield* makeLayer(observed, "agent:alice", {
        sendPost: (input) => {
          posts.attempted += 1;
          return certify(observed, input);
        },
        lookupMember: (member) =>
          member === "agent:carol"
            ? Effect.fail(new SendError({ reason: "unknown-agent" }))
            : Effect.void,
      });
      const failure = yield* failureOf(send(layer, allGatherInput()));

      expect(failure).toEqual({
        kind: "members-unreachable",
        members: [{ member: "agent:carol", reason: "unknown-agent" }],
      });
      expect(posts.attempted).toBe(0);
    }),
  );
}

function namesEveryMemberWhenTheGroupPostIsNotCertifiedInTime() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice", {
        sendPost: () => Effect.never,
      });
      const sending = yield* Effect.fork(
        failureOf(send(layer, allGatherInput())),
      );
      yield* TestClock.adjust(Duration.seconds(1));

      expect(yield* Fiber.join(sending)).toEqual({
        kind: "members-unreachable",
        members: [
          { member: "agent:bob", reason: "certification-unavailable" },
          { member: "agent:carol", reason: "certification-unavailable" },
        ],
      });
    }),
  );
}

/**
 * Runs on the live clock: the deadline timer is scheduled just before the
 * group post's wait, so it fires first, which a test clock that wakes both at
 * one instant cannot show.
 */
function endsInItsResultAloneWhenTheDeadlinePassesBeforeTheGroupPostCertifies() {
  const observed = newObserved();

  return Effect.runPromise(
    Effect.gen(function* () {
      const posts = { attempted: 0 };
      const layer = yield* makeLayer(observed, "agent:alice", {
        sendPost: (input) =>
          posts.attempted++ === 0 ? Effect.never : certify(observed, input),
      });
      yield* send(layer, {
        ...allGatherInput(),
        collective: {
          op: "all_gather",
          deadline: 1,
          requestedSchema: slotSchema,
        },
      });
      yield* Effect.sleep(Duration.millis(50));

      expect(observed.emitted).toMatchObject([
        { kind: "collectiveResult", to: group },
      ]);
    }).pipe(Effect.scoped),
  );
}

function doesNotCloseWhenTheDeadlinePassesDuringTheLookups() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const posts = { refused: 0 };
      const layer = yield* makeLayer(observed, "agent:alice", {
        sendPost: (input) =>
          posts.refused++ === 0
            ? Effect.fail(new SendError({ reason: "unknown-agent" }))
            : certify(observed, input),
        lookupMember: () => Effect.sleep(Duration.seconds(120)),
      });
      const sending = yield* Effect.fork(
        failureOf(send(layer, allGatherInput())),
      );
      yield* TestClock.adjust(Duration.seconds(240));
      yield* Fiber.join(sending);
      yield* settle;

      expect(observed.sent).toEqual([]);
      expect(observed.emitted).toEqual([]);
    }),
  );
}

function closesWithTheRecordHashOfEachCountedAnswer() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice");
      const id = yield* startAllGather(layer);
      yield* classify(layer, "agent:bob", 11, answer(id, "mon"));
      yield* classify(layer, "agent:bob", 12, answer(id, "tue"));
      yield* classify(layer, "agent:carol", 13, answer(id, "tue"));
      yield* settle;

      expect(observed.sent[1]).toEqual({
        to: group,
        content: [
          {
            type: "data",
            value: {
              [collectiveKey]: {
                kind: "close",
                id,
                included: [recordHash(11), recordHash(13)],
              },
            },
          },
        ],
      });
    }),
  );
}

function publishesTheRequesterResultOnceItsCloseIsCertified() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice");
      const id = yield* startAllGather(layer);
      yield* classify(layer, "agent:bob", 11, answer(id, "mon"));
      yield* classify(layer, "agent:carol", 13, answer(id, "tue"));
      yield* settle;

      expect(observed.emitted).toEqual([
        {
          kind: "collectiveResult",
          op: "all_gather",
          id,
          to: group,
          question: questionText,
          outcomes: [
            {
              member: "agent:bob",
              outcome: { kind: "answered", content: { slot: "mon" } },
            },
            {
              member: "agent:carol",
              outcome: { kind: "answered", content: { slot: "tue" } },
            },
          ],
        },
      ]);
    }),
  );
}

function closesAtTheDeadlineWithoutTheSilentMember() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice");
      const id = yield* startAllGather(layer);
      yield* classify(layer, "agent:bob", 11, answer(id, "mon"));
      yield* TestClock.adjust(Duration.seconds(60));
      yield* settle;

      expect(observed.emitted).toMatchObject([
        {
          outcomes: [
            { member: "agent:bob", outcome: { kind: "answered" } },
            { member: "agent:carol", outcome: { kind: "no-answer" } },
          ],
        },
      ]);
      expect(observed.sent[1]?.content).toMatchObject([
        { value: { [collectiveKey]: { included: [recordHash(11)] } } },
      ]);
    }),
  );
}

function ignoresAnAnswerThatArrivesAfterTheClose() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice");
      const id = yield* startAllGather(layer);
      yield* TestClock.adjust(Duration.seconds(60));
      yield* settle;
      yield* classify(layer, "agent:carol", 13, answer(id, "tue"));
      yield* settle;

      expect(observed.sent).toHaveLength(2);
      expect(observed.emitted).toHaveLength(1);
    }),
  );
}

function reportsACloseThatCannotBeCertifiedAsAFailedOperation() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:alice", {
        sendPost: (input) =>
          observed.sent.length === 0
            ? certify(observed, input)
            : Effect.fail(new SendError({ reason: "network-unavailable" })),
      });
      const id = yield* startAllGather(layer);
      yield* TestClock.adjust(Duration.seconds(60));
      yield* settle;

      expect(observed.emitted).toEqual([
        {
          kind: "operationFailed",
          id,
          to: group,
          error:
            "all_gather failed: the result could not be shared with the group: MoltZap is unavailable (network unavailable)",
        },
      ]);
    }),
  );
}

function deliversAGroupRequestAsAnItemAddressedToTheGroup() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved(), "agent:bob");
      const item = yield* classify(layer, "agent:alice", 10, requestValue);

      expect(item).toEqual(
        Option.some({
          kind: "collectiveRequest",
          op: "all_gather",
          id: requestId,
          postId: postId(10),
          from: "agent:alice",
          to: group,
          question: questionText,
          requestedSchema: slotSchema,
          deadlineAt: 60_000,
        }),
      );
    }),
  );
}

function consumesAGroupRequestWhoseIdDoesNotDeriveFromItsSender() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved(), "agent:bob");
      const item = yield* classify(layer, "agent:carol", 10, requestValue);

      expect(item).toEqual(Option.none());
    }),
  );
}

function consumesASecondRequestPostThatReusesAHeldId() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      const reused = yield* layer.classify({
        message: Schema.decodeUnknownSync(InboundMessage)({
          kind: "direct",
          postId: postId(20),
          address: "agent:alice",
          sender: "agent:alice",
          content: [
            { type: "text", text: "Private question?" },
            {
              type: "data",
              value: { [collectiveKey]: { ...requestValue, op: "gather" } },
            },
          ],
        }),
        recordHash: recordHash(20),
      });
      const redelivered = yield* classify(
        layer,
        "agent:alice",
        10,
        requestValue,
      );

      expect(reused).toEqual(Option.none());
      expect(redelivered).toMatchObject(Option.some({ to: group }));
    }),
  );
}

function keepsARequestFirstSeenAfterItsDeadlineForTheClose() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* TestClock.adjust(Duration.seconds(60));
      const item = yield* classify(layer, "agent:alice", 10, requestValue);
      yield* classify(layer, "agent:carol", 13, answer(requestId, "tue"));
      yield* classify(layer, "agent:alice", 14, close(requestId, [13]));
      const failure = yield* failureOf(respond(layer, "mon"));

      expect(item).toEqual(Option.none());
      expect(failure).toEqual({ kind: "request-expired" });
      expect(observed.emitted).toMatchObject([
        {
          outcomes: [
            { member: "agent:bob", outcome: { kind: "no-answer" } },
            { member: "agent:carol", outcome: { kind: "answered" } },
          ],
        },
      ]);
    }),
  );
}

function postsAMemberAnswerToTheGroup() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      yield* respond(layer, "mon");

      expect(observed.sent.map((post) => post.to)).toEqual([group]);
    }),
  );
}

function consumesAPeerAnswerWithoutPublishingIt() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      const item = yield* classify(
        layer,
        "agent:carol",
        13,
        answer(requestId, "tue"),
      );

      expect(item).toEqual(Option.none());
      expect(observed.emitted).toEqual([]);
    }),
  );
}

function buildsTheMemberResultFromExactlyTheListedAnswers() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      yield* respond(layer, "mon");
      yield* classify(layer, "agent:carol", 13, answer(requestId, "tue"));
      yield* classify(layer, "agent:alice", 14, close(requestId, [101]));

      expect(observed.emitted).toEqual([
        {
          kind: "collectiveResult",
          op: "all_gather",
          id: requestId,
          to: group,
          question: questionText,
          outcomes: [
            {
              member: "agent:bob",
              outcome: { kind: "answered", content: { slot: "mon" } },
            },
            { member: "agent:carol", outcome: { kind: "no-answer" } },
          ],
        },
      ]);
    }),
  );
}

function includesAListedPeerAnswerInTheMemberResult() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      yield* classify(layer, "agent:carol", 13, answer(requestId, "tue"));
      yield* classify(layer, "agent:alice", 14, close(requestId, [13]));

      expect(observed.emitted).toMatchObject([
        {
          outcomes: [
            { member: "agent:bob", outcome: { kind: "no-answer" } },
            {
              member: "agent:carol",
              outcome: { kind: "answered", content: { slot: "tue" } },
            },
          ],
        },
      ]);
    }),
  );
}

function holdsACloseUntilTheMemberOwnAnswerIsCertified() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const certified = yield* Deferred.make<undefined>();
      const layer = yield* makeLayer(observed, "agent:bob", {
        sendPost: (input) =>
          Deferred.await(certified).pipe(
            Effect.zipRight(certify(observed, input)),
          ),
      });
      yield* classify(layer, "agent:alice", 10, requestValue);
      const answering = yield* Effect.fork(respond(layer, "mon"));
      yield* settle;
      yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
      const emittedBeforeCertification = [...observed.emitted];
      yield* Deferred.succeed(certified, undefined);
      yield* Fiber.join(answering);

      expect(emittedBeforeCertification).toEqual([]);
      expect(observed.emitted).toMatchObject([
        {
          outcomes: [
            { member: "agent:bob", outcome: { kind: "answered" } },
            { member: "agent:carol", outcome: { kind: "no-answer" } },
          ],
        },
      ]);
    }),
  );
}

/** A port that keeps no item the layer emits. */
const unkeptEmit = { emit: () => Effect.fail(new CollectiveEmitError()) };

/**
 * A close whose member result cannot be kept fails its classification, so
 * the pass classifying it ends instead of waiting.
 */
function failsACloseWhoseMemberResultCannotBeKept() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved(), "agent:bob", unkeptEmit);
      yield* classify(layer, "agent:alice", 10, requestValue);
      const failure = yield* Effect.flip(
        classify(layer, "agent:alice", 14, close(requestId, [])),
      );

      expect(failure).toEqual(new CollectiveEmitError());
    }),
  );
}

/**
 * A member answer that releases a held close whose result cannot be kept
 * fails as persistence-failed.
 */
function failsAnAnswerThatReleasesAnUnkeptClose() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const certified = yield* Deferred.make<undefined>();
      const layer = yield* makeLayer(observed, "agent:bob", {
        ...unkeptEmit,
        sendPost: (input) =>
          Deferred.await(certified).pipe(
            Effect.zipRight(certify(observed, input)),
          ),
      });
      yield* classify(layer, "agent:alice", 10, requestValue);
      const answering = yield* Effect.fork(respond(layer, "mon"));
      yield* settle;
      yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
      yield* Deferred.succeed(certified, undefined);

      expect(yield* Effect.flip(Fiber.join(answering))).toEqual(
        new SendError({ reason: "persistence-failed" }),
      );
    }),
  );
}

function excludesAPeerAnswerThatArrivesAfterTheClose() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      yield* classify(layer, "agent:alice", 14, close(requestId, []));
      yield* classify(layer, "agent:carol", 15, answer(requestId, "tue"));
      yield* classify(layer, "agent:alice", 14, close(requestId, []));

      expect(observed.emitted).toMatchObject([
        {
          outcomes: [
            { member: "agent:bob", outcome: { kind: "no-answer" } },
            { member: "agent:carol", outcome: { kind: "no-answer" } },
          ],
        },
      ]);
    }),
  );
}

function refusesAMemberAnswerAfterTheClose() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved(), "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      yield* classify(layer, "agent:alice", 14, close(requestId, []));
      const failure = yield* failureOf(respond(layer, "mon"));

      expect(failure).toEqual({ kind: "request-expired" });
    }),
  );
}

function ignoresACloseFromAMemberOtherThanTheRequester() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      const item = yield* classify(
        layer,
        "agent:carol",
        14,
        close(requestId, []),
      );

      expect(item).toEqual(Option.none());
      expect(observed.emitted).toEqual([]);
    }),
  );
}

function keepsItsResultWhenItsOwnAnswerSettlesAfterTheClose() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const certified = yield* Deferred.make<undefined>();
      const layer = yield* makeLayer(observed, "agent:bob", {
        sendPost: (input) =>
          Deferred.await(certified).pipe(
            Effect.zipRight(certify(observed, input)),
          ),
      });
      yield* classify(layer, "agent:alice", 10, requestValue);
      const answering = yield* Effect.fork(respond(layer, "mon"));
      yield* settle;
      yield* classify(layer, "agent:alice", 14, close(requestId, []));
      yield* Deferred.succeed(certified, undefined);
      yield* Fiber.join(answering);
      yield* classify(layer, "agent:alice", 14, close(requestId, []));
      const failure = yield* failureOf(respond(layer, "tue"));

      expect(observed.emitted).toHaveLength(1);
      expect(failure).toEqual({ kind: "request-expired" });
    }),
  );
}

function appliesOnlyTheFirstCloseWhileItsOwnAnswerIsInFlight() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const certified = yield* Deferred.make<undefined>();
      const layer = yield* makeLayer(observed, "agent:bob", {
        sendPost: (input) =>
          Deferred.await(certified).pipe(
            Effect.zipRight(certify(observed, input)),
          ),
      });
      yield* classify(layer, "agent:alice", 10, requestValue);
      const answering = yield* Effect.fork(respond(layer, "mon"));
      yield* settle;
      yield* classify(layer, "agent:alice", 14, close(requestId, [101]));
      yield* classify(layer, "agent:alice", 15, close(requestId, []));
      yield* Deferred.succeed(certified, undefined);
      yield* Fiber.join(answering);

      expect(observed.emitted).toMatchObject([
        {
          outcomes: [
            { member: "agent:bob", outcome: { kind: "answered" } },
            { member: "agent:carol", outcome: { kind: "no-answer" } },
          ],
        },
      ]);
    }),
  );
}

function ignoresACloseForAnUnknownId() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      const item = yield* classify(
        layer,
        "agent:alice",
        14,
        close(otherId, []),
      );

      expect(item).toEqual(Option.none());
      expect(observed.emitted).toEqual([]);
    }),
  );
}

function ignoresACloseListingAnAnswerTheMemberDoesNotHold() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, "agent:bob");
      yield* classify(layer, "agent:alice", 10, requestValue);
      yield* classify(layer, "agent:alice", 14, close(requestId, [99]));

      expect(observed.emitted).toEqual([]);
    }),
  );
}

describe("all_gather at the requester", () => {
  it("sends one request post to the group", sendsOneRequestPostToTheGroup);
  it(
    "refuses an all_gather to an agent address",
    refusesAnAllGatherToAnAgentAddress,
  );
  it(
    "names the member whose lookup fails when the group post is refused",
    namesTheMemberWhoseLookupFailsWhenTheGroupPostIsRefused,
  );
  it(
    "names every member when the group post is not certified in time",
    namesEveryMemberWhenTheGroupPostIsNotCertifiedInTime,
  );
  it(
    "ends in its result alone when the deadline passes before the group post certifies",
    endsInItsResultAloneWhenTheDeadlinePassesBeforeTheGroupPostCertifies,
  );
  it(
    "refuses an all_gather with an unknown member before posting",
    refusesAnAllGatherWithAnUnknownMemberBeforePosting,
  );
  it(
    "does not close when the deadline passes during the member lookups",
    doesNotCloseWhenTheDeadlinePassesDuringTheLookups,
  );
  it(
    "closes with the record hash of each counted answer",
    closesWithTheRecordHashOfEachCountedAnswer,
  );
  it(
    "publishes its result once its close is certified",
    publishesTheRequesterResultOnceItsCloseIsCertified,
  );
  it(
    "closes at the deadline without the silent member",
    closesAtTheDeadlineWithoutTheSilentMember,
  );
  it(
    "ignores an answer that arrives after the close",
    ignoresAnAnswerThatArrivesAfterTheClose,
  );
  it(
    "reports a close that cannot be certified as a failed operation",
    reportsACloseThatCannotBeCertifiedAsAFailedOperation,
  );
});

describe("all_gather at a member", () => {
  it(
    "delivers a group request as an item addressed to the group",
    deliversAGroupRequestAsAnItemAddressedToTheGroup,
  );
  it(
    "consumes a group request whose id does not derive from its sender",
    consumesAGroupRequestWhoseIdDoesNotDeriveFromItsSender,
  );
  it(
    "consumes a second request post that reuses a held id",
    consumesASecondRequestPostThatReusesAHeldId,
  );
  it(
    "keeps a request first seen after its deadline for the close",
    keepsARequestFirstSeenAfterItsDeadlineForTheClose,
  );
  it("posts its answer to the group", postsAMemberAnswerToTheGroup);
  it(
    "consumes a peer answer without publishing it",
    consumesAPeerAnswerWithoutPublishingIt,
  );
  it(
    "builds its result from exactly the listed answers",
    buildsTheMemberResultFromExactlyTheListedAnswers,
  );
  it(
    "includes a listed peer answer in its result",
    includesAListedPeerAnswerInTheMemberResult,
  );
  it(
    "holds a close until its own answer is certified",
    holdsACloseUntilTheMemberOwnAnswerIsCertified,
  );
  it(
    "excludes a peer answer that arrives after the close",
    excludesAPeerAnswerThatArrivesAfterTheClose,
  );
  it(
    "refuses its own answer after the close",
    refusesAMemberAnswerAfterTheClose,
  );
  it(
    "ignores a close from a member other than the requester",
    ignoresACloseFromAMemberOtherThanTheRequester,
  );
});

describe("all_gather close at a member", () => {
  it(
    "keeps its result when its own answer settles after the close",
    keepsItsResultWhenItsOwnAnswerSettlesAfterTheClose,
  );
  it(
    "applies only the first close while its own answer is in flight",
    appliesOnlyTheFirstCloseWhileItsOwnAnswerIsInFlight,
  );
  it("ignores a close for an unknown id", ignoresACloseForAnUnknownId);
  it(
    "ignores a close listing an answer it does not hold",
    ignoresACloseListingAnAnswerTheMemberDoesNotHold,
  );
});

describe("all_gather member results the service cannot keep", () => {
  it(
    "fails a close whose member result cannot be kept",
    failsACloseWhoseMemberResultCannotBeKept,
  );
  it(
    "fails an answer that releases a close whose result cannot be kept",
    failsAnAnswerThatReleasesAnUnkeptClose,
  );
});
