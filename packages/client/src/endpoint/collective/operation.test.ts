/** @file Pins how the collective layer sends operations and classifies posts. */

import {
  Duration,
  Effect,
  Encoding,
  Option,
  Schema,
  type Scope,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import type { EngineSendInput } from "../engine-types.js";
import {
  AgentAddress,
  CollectiveError,
  type FailureDelivery,
  type InboundItem,
  InboundMessage,
  PostId,
  SendError,
  SendInput,
} from "../../contract.js";
import { RecordHash } from "../representation.js";
import {
  type CollectiveOperations,
  makeCollectiveOperations,
} from "./operation.js";
import { decodeCollectiveValue } from "./wire.js";

const alice = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const collectiveKey = "xyz.moltzap/collective";
const multicastPart = {
  type: "data",
  value: { [collectiveKey]: { kind: "operation", op: "multicast" } },
};
const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
};
const requestId = `col_${"A".repeat(43)}`;
const questionText = "Which day works?";
const gatherTo = "group:alice,bob,carol";
const recordHash = Schema.decodeUnknownSync(RecordHash)(
  `rch_${"A".repeat(43)}`,
);

interface Observed {
  readonly sent: EngineSendInput[];
  readonly emitted: InboundItem[];
}

const postId = (byte: number): string =>
  `pst_${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;

const newObserved = (): Observed => ({ sent: [], emitted: [] });

/**
 * A collective layer over recording ports. Each certified post gets a fresh
 * PostId; a member named in `refused` refuses its post with that reason.
 */
const makeLayer = (
  observed: Observed,
  refused: Readonly<Record<string, SendError["reason"]>> = {},
): Effect.Effect<CollectiveOperations, never, Scope.Scope> =>
  Effect.map(Effect.scope, (scope) =>
    makeCollectiveOperations({
      self: alice,
      lookupMember: () => Effect.void,
      sendPost: (input) => {
        const reason = refused[input.to];
        if (reason !== undefined) {
          return Effect.fail(new SendError({ reason }));
        }
        return Effect.sync(() => {
          observed.sent.push(input);
          return {
            postId: Schema.decodeUnknownSync(PostId)(
              postId(observed.sent.length),
            ),
            recordHash,
          };
        });
      },
      emit: (item) =>
        Effect.sync(() => {
          observed.emitted.push(item);
        }),
      scope,
      requestSendWait: Duration.seconds(1),
    }),
  );

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  );

const directPost = (sender: string, content: unknown, byte = 9) =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    postId: postId(byte),
    address: sender,
    sender,
    content,
  });

const requestPost = (sender: string, deadlineAt: number) =>
  directPost(sender, [
    { type: "text", text: questionText },
    {
      type: "data",
      value: {
        [collectiveKey]: {
          kind: "operation",
          op: "gather",
          id: requestId,
          deadlineAt,
          requestedSchema: slotSchema,
        },
      },
    },
  ]);

const answerPost = (sender: string, id: string, response: object) =>
  directPost(sender, [
    {
      type: "data",
      value: { [collectiveKey]: { kind: "response", id, ...response } },
    },
  ]);

/** Classify one post as certified under the shared test record hash. */
const classifyPost = (layer: CollectiveOperations, message: InboundMessage) =>
  layer.classify({ message, recordHash });

const send = (
  layer: CollectiveOperations,
  input: unknown,
  failureDelivery: FailureDelivery = "result",
) => layer.send(Schema.decodeUnknownSync(SendInput)(input), failureDelivery);

const gatherInput = (deadline = 60, requestedSchema: object = slotSchema) => ({
  to: gatherTo,
  text: questionText,
  collective: { op: "gather", deadline, requestedSchema },
});

const collectiveFailureOf = <A>(
  effect: Effect.Effect<A, SendError | CollectiveError>,
) =>
  Effect.flip(effect).pipe(
    Effect.map((error) =>
      error instanceof CollectiveError ? error.failure : error,
    ),
  );

const startGather = (layer: CollectiveOperations) =>
  send(layer, gatherInput()).pipe(
    Effect.flatMap((outcome) =>
      Option.fromNullable(outcome.operationId).pipe(
        Effect.orElse(() => Effect.dieMessage("gather returned no id")),
      ),
    ),
  );

function certifiesAMulticastAsItsTextAndAnExplicitMulticastPart() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      yield* send(layer, { to: "agent:bob", text: "Hello" });

      expect(observed.sent).toEqual([
        {
          to: "agent:bob",
          content: [{ type: "text", text: "Hello" }, multicastPart],
        },
      ]);
    }),
  );
}

function failsAMulticastWhoseTextAndPartExceedTheContentLimit() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const failure = yield* collectiveFailureOf(
        send(layer, { to: "agent:bob", text: "a".repeat(32_741) }),
      );

      expect(failure).toEqual(new SendError({ reason: "content-invalid" }));
    }),
  );
}

function fansAGatherOutAsOneRequestPostPerMemberButTheRequester() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const id = yield* startGather(layer);

      expect(observed.sent.map((post) => post.to)).toEqual([
        "agent:bob",
        "agent:carol",
      ]);
      expect(observed.sent[0]?.content).toEqual([
        { type: "text", text: questionText },
        {
          type: "data",
          value: {
            [collectiveKey]: {
              kind: "operation",
              op: "gather",
              id,
              deadlineAt: 60_000,
              requestedSchema: slotSchema,
            },
          },
        },
      ]);
    }),
  );
}

function failsAGatherNamingEachMemberWhoseRequestPostWasRefused() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, {
        "agent:carol": "unknown-agent",
      });
      const failure = yield* collectiveFailureOf(send(layer, gatherInput()));

      expect(failure).toEqual({
        kind: "members-unreachable",
        members: [{ member: "agent:carol", reason: "unknown-agent" }],
      });
    }),
  );
}

function failsAGatherWhoseSchemaIsOutsideTheFormModeGrammar() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const failure = yield* collectiveFailureOf(
        send(
          layer,
          gatherInput(60, {
            type: "object",
            properties: { slot: { type: "object" } },
          }),
        ),
      );

      expect(failure).toMatchObject({ kind: "schema-invalid" });
      expect(observed.sent).toEqual([]);
    }),
  );
}

function emitsARefusedGatherAsAnOperationFailedItemWhenFailuresGoInbound() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, {
        "agent:carol": "unknown-agent",
      });
      const outcome = yield* send(layer, gatherInput(), "inbound");

      expect(observed.emitted).toEqual([
        {
          kind: "operationFailed",
          id: outcome.operationId,
          to: gatherTo,
          error: `collective ${String(outcome.operationId)} failed: unreachable members: agent:carol (unknown-agent)`,
        },
      ]);
    }),
  );
}

function deliversAMulticastWithoutItsCollectivePart() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      const item = yield* classifyPost(
        layer,
        directPost("agent:bob", [
          { type: "text", text: "Hello" },
          multicastPart,
        ]),
      );

      expect(item).toEqual(
        Option.some({
          kind: "multicast",
          message: directPost("agent:bob", [{ type: "text", text: "Hello" }]),
        }),
      );
    }),
  );
}

function deliversAPostWithoutACollectivePartAsAMulticast() {
  const post = directPost("agent:bob", [{ type: "text", text: "Hello" }]);

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());

      expect(yield* classifyPost(layer, post)).toEqual(
        Option.some({ kind: "multicast", message: post }),
      );
    }),
  );
}

function consumesAPostWhoseCollectivePartIsMalformed() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      const item = yield* classifyPost(
        layer,
        directPost("agent:bob", [
          { type: "text", text: "Hello" },
          { type: "data", value: { [collectiveKey]: { kind: "operation" } } },
        ]),
      );

      expect(item).toEqual(Option.none());
    }),
  );
}

function consumesAMulticastWhoseOnlyPartIsTheCollectivePart() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());

      expect(
        yield* classifyPost(layer, directPost("agent:bob", [multicastPart])),
      ).toEqual(Option.none());
    }),
  );
}

function consumesAPostThatCarriesTwoCollectiveParts() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      const item = yield* classifyPost(
        layer,
        directPost("agent:bob", [
          { type: "text", text: "Hello" },
          multicastPart,
          multicastPart,
        ]),
      );

      expect(item).toEqual(Option.none());
    }),
  );
}

function consumesACloseForAnAllGatherThisEndpointWasNotAsked() {
  const close = { kind: "close", id: requestId, included: [] };

  return run(
    Effect.gen(function* () {
      yield* decodeCollectiveValue(close);
      const layer = yield* makeLayer(newObserved());
      const item = yield* classifyPost(
        layer,
        directPost("agent:bob", [
          { type: "data", value: { [collectiveKey]: close } },
        ]),
      );

      expect(item).toEqual(Option.none());
    }),
  );
}

function consumesAnAllGatherRequestInADirectConversation() {
  const request = {
    kind: "operation",
    op: "all_gather",
    id: requestId,
    deadlineAt: 60_000,
    requestedSchema: slotSchema,
  };

  return run(
    Effect.gen(function* () {
      yield* decodeCollectiveValue(request);
      const layer = yield* makeLayer(newObserved());
      const item = yield* classifyPost(
        layer,
        directPost("agent:bob", [
          { type: "text", text: questionText },
          { type: "data", value: { [collectiveKey]: request } },
        ]),
      );

      expect(item).toEqual(Option.none());
    }),
  );
}

function deliversARequestPostAsACollectiveRequestItem() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      const item = yield* classifyPost(layer, requestPost("agent:bob", 60_000));

      expect(item).toEqual(
        Option.some({
          kind: "collectiveRequest",
          id: requestId,
          postId: postId(9),
          from: "agent:bob",
          to: "agent:bob",
          question: questionText,
          requestedSchema: slotSchema,
          deadlineAt: 60_000,
        }),
      );
    }),
  );
}

function consumesARequestPostWhoseDeadlineHasPassed() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      yield* TestClock.adjust(Duration.seconds(61));

      expect(
        yield* classifyPost(layer, requestPost("agent:bob", 60_000)),
      ).toEqual(Option.none());
    }),
  );
}

function postsAValidAnswerToTheRequesterSDirectConversation() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      yield* classifyPost(layer, requestPost("agent:bob", 60_000));
      yield* send(layer, {
        collectiveResponse: {
          id: requestId,
          action: "accept",
          content: { slot: "mon" },
        },
      });

      expect(observed.sent).toEqual([
        {
          to: "agent:bob",
          content: [
            {
              type: "data",
              value: {
                [collectiveKey]: {
                  kind: "response",
                  id: requestId,
                  action: "accept",
                  content: { slot: "mon" },
                },
              },
            },
          ],
        },
      ]);
    }),
  );
}

function refusesAnAnswerThatFailsTheRequestSSchemaNamingTheField() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      yield* classifyPost(layer, requestPost("agent:bob", 60_000));
      const failure = yield* collectiveFailureOf(
        send(layer, {
          collectiveResponse: {
            id: requestId,
            action: "accept",
            content: { slot: "sun" },
          },
        }),
      );

      expect(failure).toMatchObject({
        kind: "answer-invalid",
        fields: [{ field: "slot", reason: "invalid" }],
      });
      expect(observed.sent).toEqual([]);
    }),
  );
}

function refusesASecondAnswerToTheSameRequest() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      yield* classifyPost(layer, requestPost("agent:bob", 60_000));
      const decline = {
        collectiveResponse: { id: requestId, action: "decline" },
      };
      yield* send(layer, decline);

      expect(yield* collectiveFailureOf(send(layer, decline))).toEqual({
        kind: "request-answered",
      });
    }),
  );
}

function refusesAnAnswerToARequestThisEndpointNeverReceived() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      const failure = yield* collectiveFailureOf(
        send(layer, {
          collectiveResponse: { id: requestId, action: "decline" },
        }),
      );

      expect(failure).toEqual({ kind: "request-unknown" });
    }),
  );
}

function refusesAnAnswerAfterTheRequestSDeadline() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      yield* classifyPost(layer, requestPost("agent:bob", 60_000));
      yield* TestClock.adjust(Duration.seconds(60));
      const failure = yield* collectiveFailureOf(
        send(layer, {
          collectiveResponse: { id: requestId, action: "decline" },
        }),
      );

      expect(failure).toEqual({ kind: "request-expired" });
    }),
  );
}

function consumesAMemberSAnswerRatherThanDeliveringIt() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      const id = yield* startGather(layer);
      const item = yield* classifyPost(
        layer,
        answerPost("agent:bob", id, {
          action: "accept",
          content: { slot: "mon" },
        }),
      );

      expect(item).toEqual(Option.none());
    }),
  );
}

function emitsTheResultOnceEveryMemberHasAnswered() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const id = yield* startGather(layer);
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, {
          action: "accept",
          content: { slot: "mon" },
        }),
      );
      yield* classifyPost(
        layer,
        answerPost("agent:carol", id, { action: "decline" }),
      );

      expect(observed.emitted).toEqual([
        {
          kind: "collectiveResult",
          id,
          to: gatherTo,
          question: questionText,
          outcomes: [
            {
              member: "agent:bob",
              outcome: { kind: "answered", content: { slot: "mon" } },
            },
            { member: "agent:carol", outcome: { kind: "declined" } },
          ],
        },
      ]);
    }),
  );
}

function reportsASilentMemberAsNoAnswerAtTheDeadline() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const id = yield* startGather(layer);
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, { action: "cancel" }),
      );
      yield* TestClock.adjust(Duration.seconds(60));

      expect(observed.emitted).toEqual([
        {
          kind: "collectiveResult",
          id,
          to: gatherTo,
          question: questionText,
          outcomes: [
            { member: "agent:bob", outcome: { kind: "cancelled" } },
            { member: "agent:carol", outcome: { kind: "no-answer" } },
          ],
        },
      ]);
    }),
  );
}

function recordsAnAnswerThatFailsTheSchemaAsInvalid() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const id = yield* startGather(layer);
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, {
          action: "accept",
          content: { slot: "sun" },
        }),
      );
      yield* TestClock.adjust(Duration.seconds(60));

      expect(observed.emitted[0]).toMatchObject({
        outcomes: [{ member: "agent:bob", outcome: { kind: "invalid" } }, {}],
      });
    }),
  );
}

function keepsAMemberSFirstAnswerAndIgnoresItsSecond() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const id = yield* startGather(layer);
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, { action: "decline" }),
      );
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, {
          action: "accept",
          content: { slot: "mon" },
        }),
      );
      yield* TestClock.adjust(Duration.seconds(60));

      expect(observed.emitted[0]).toMatchObject({
        outcomes: [{ member: "agent:bob", outcome: { kind: "declined" } }, {}],
      });
    }),
  );
}

function changesNothingForAnAnswerThatArrivesAfterTheDeadline() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const id = yield* startGather(layer);
      yield* TestClock.adjust(Duration.seconds(60));
      const late = yield* classifyPost(
        layer,
        answerPost("agent:bob", id, {
          action: "accept",
          content: { slot: "mon" },
        }),
      );

      expect(late).toEqual(Option.none());
      expect(observed.emitted).toHaveLength(1);
    }),
  );
}

function namesTheResultByTheGroupSCanonicalAddress() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      yield* send(layer, { ...gatherInput(), to: "group:carol,bob" });
      yield* TestClock.adjust(Duration.seconds(60));

      expect(observed.emitted[0]).toMatchObject({ to: gatherTo });
    }),
  );
}

function returnsTheGatherSIdWithTheRequestPostsItCertified() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const outcome = yield* send(layer, gatherInput());

      expect(outcome.postIds).toEqual([postId(1), postId(2)]);
    }),
  );
}

// @agent-code-guard/regression-only: examples pin the posts each operation certifies.
describe("collective sends", () => {
  it(
    "certifies a multicast as its text and an explicit multicast part",
    certifiesAMulticastAsItsTextAndAnExplicitMulticastPart,
  );

  it(
    "fails a multicast whose text and part exceed the content limit",
    failsAMulticastWhoseTextAndPartExceedTheContentLimit,
  );

  it(
    "fans a gather out as one request post per member but the requester",
    fansAGatherOutAsOneRequestPostPerMemberButTheRequester,
  );

  it(
    "fails a gather naming each member whose request post was refused",
    failsAGatherNamingEachMemberWhoseRequestPostWasRefused,
  );

  it(
    "fails a gather whose schema is outside the form-mode grammar",
    failsAGatherWhoseSchemaIsOutsideTheFormModeGrammar,
  );

  it(
    "emits a refused gather as an operationFailed item when failures go inbound",
    emitsARefusedGatherAsAnOperationFailedItemWhenFailuresGoInbound,
  );
});

// @agent-code-guard/regression-only: examples pin which certified posts reach the subscriber and in what form.
describe("inbound classification", () => {
  it(
    "delivers a multicast without its collective part",
    deliversAMulticastWithoutItsCollectivePart,
  );

  it(
    "delivers a post without a collective part as a multicast",
    deliversAPostWithoutACollectivePartAsAMulticast,
  );

  it(
    "consumes a post whose collective part is malformed",
    consumesAPostWhoseCollectivePartIsMalformed,
  );

  it(
    "consumes a multicast whose only part is the collective part",
    consumesAMulticastWhoseOnlyPartIsTheCollectivePart,
  );

  it(
    "consumes a post that carries two collective parts",
    consumesAPostThatCarriesTwoCollectiveParts,
  );

  it(
    "consumes a close for an all_gather this endpoint was not asked",
    consumesACloseForAnAllGatherThisEndpointWasNotAsked,
  );

  it(
    "consumes an all_gather request in a direct conversation",
    consumesAnAllGatherRequestInADirectConversation,
  );

  it(
    "delivers a request post as a collectiveRequest item",
    deliversARequestPostAsACollectiveRequestItem,
  );

  it(
    "consumes a request post whose deadline has passed",
    consumesARequestPostWhoseDeadlineHasPassed,
  );
});

// @agent-code-guard/regression-only: examples pin how a member answers a request.
describe("collective responses", () => {
  it(
    "posts a valid answer to the requester's direct conversation",
    postsAValidAnswerToTheRequesterSDirectConversation,
  );

  it(
    "refuses an answer that fails the request's schema, naming the field",
    refusesAnAnswerThatFailsTheRequestSSchemaNamingTheField,
  );

  it(
    "refuses a second answer to the same request",
    refusesASecondAnswerToTheSameRequest,
  );

  it(
    "refuses an answer to a request this endpoint never received",
    refusesAnAnswerToARequestThisEndpointNeverReceived,
  );

  it(
    "refuses an answer after the request's deadline",
    refusesAnAnswerAfterTheRequestSDeadline,
  );
});

// @agent-code-guard/regression-only: examples pin how the requester completes a gather.
describe("gather results", () => {
  it(
    "consumes a member's answer rather than delivering it",
    consumesAMemberSAnswerRatherThanDeliveringIt,
  );

  it(
    "emits the result once every member has answered",
    emitsTheResultOnceEveryMemberHasAnswered,
  );

  it(
    "reports a silent member as no-answer at the deadline",
    reportsASilentMemberAsNoAnswerAtTheDeadline,
  );

  it(
    "records an answer that fails the schema as invalid",
    recordsAnAnswerThatFailsTheSchemaAsInvalid,
  );

  it(
    "keeps a member's first answer and ignores its second",
    keepsAMemberSFirstAnswerAndIgnoresItsSecond,
  );

  it(
    "changes nothing for an answer that arrives after the deadline",
    changesNothingForAnAnswerThatArrivesAfterTheDeadline,
  );

  it(
    "names the result by the group's canonical address",
    namesTheResultByTheGroupSCanonicalAddress,
  );

  it(
    "returns the gather's id with the request posts it certified",
    returnsTheGatherSIdWithTheRequestPostsItCertified,
  );
});
