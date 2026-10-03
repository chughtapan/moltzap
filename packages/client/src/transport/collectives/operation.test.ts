/** @file Pins how the collective layer sends operations and classifies posts. */

import {
  Duration,
  Effect,
  Encoding,
  Fiber,
  Option,
  Schema,
  type Scope,
  Supervisor,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import type { EngineSendInput } from "../messaging/index.js";
import type { InboundItem } from "./inbound.js";
import { AgentAddress } from "../messaging/address.js";
import { SendError } from "../messaging/errors.js";
import { InboundMessage } from "../messaging/message.js";
import { PostId, RecordHash } from "../wire/index.js";
import {
  CollectiveEmitError,
  CollectiveError,
  type FailureDelivery,
  SendInput,
} from "./forms.js";
import {
  type CollectiveOperations,
  makeCollectiveOperations,
} from "./operation.js";
import {
  collectiveIdOf,
  decodeCollectiveValue,
  readCollectiveValue,
} from "./wire.js";

/* eslint-disable max-lines -- One recording layer serves every send, classification and result case, so the cases stay beside the fixture they share. */
const alice = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
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
const requestNonce = "N".repeat(43);
const requestId = collectiveIdOf(bob, requestNonce);
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
 * PostId after `sendDelay`. A member named in `refused` refuses its post with
 * that reason, never certifies it when the reason is `slow`, or certifies it
 * five seconds late when it is `late`; a member named in `unknown` also fails
 * the lookup that resolves it. With `emitFails`, the service keeps no item
 * the layer emits.
 */
/** An emit port that keeps nothing. */
const unkeptEmit = () => Effect.fail(new CollectiveEmitError());

/** An emit port that records each item. */
const recordEmitted = (observed: Observed) => (item: InboundItem) =>
  Effect.sync(() => {
    observed.emitted.push(item);
  });

const makeLayer = (
  observed: Observed,
  refused: Readonly<Record<string, SendError["reason"] | "slow" | "late">> = {},
  sendDelay?: Duration.Duration,
  {
    unknown = [],
    emitFails = false,
  }: {
    readonly unknown?: readonly string[];
    readonly emitFails?: boolean;
  } = {},
): Effect.Effect<CollectiveOperations, never, Scope.Scope> =>
  Effect.map(Effect.scope, (scope) =>
    makeCollectiveOperations({
      self: alice,
      lookupMember: (member) =>
        unknown.includes(member)
          ? Effect.fail(new SendError({ reason: "unknown-agent" }))
          : Effect.void,
      sendPost: (input) => {
        const reason = refused[input.to];
        if (reason === "slow") {
          return Effect.never;
        }
        if (reason !== undefined && reason !== "late") {
          return Effect.fail(new SendError({ reason }));
        }
        const delay = reason === "late" ? Duration.seconds(5) : sendDelay;
        return Effect.sleep(delay ?? Duration.zero).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              observed.sent.push(input);
              return {
                postId: Schema.decodeUnknownSync(PostId)(
                  postId(observed.sent.length),
                ),
                recordHash,
              };
            }),
          ),
        );
      },
      emit: emitFails ? unkeptEmit : recordEmitted(observed),
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

const requestPost = (sender: string, deadlineAt: number, id = requestId) =>
  directPost(sender, [
    { type: "text", text: questionText },
    {
      type: "data",
      value: {
        [collectiveKey]: {
          kind: "operation",
          op: "gather",
          id,
          nonce: requestNonce,
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

      expect(failure).toMatchObject({ reason: "content-invalid" });
    }),
  );
}

function fansAGatherOutAsOneRequestPostPerMemberButTheRequester() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const id = yield* startGather(layer);
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
              nonce,
              deadlineAt: 60_000,
              requestedSchema: slotSchema,
            },
          },
        },
      ]);
    }),
  );
}

function refusesAGatherWithAnUnknownMemberBeforeAnyPost() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, {}, undefined, {
        unknown: ["agent:carol"],
      });
      const failure = yield* collectiveFailureOf(send(layer, gatherInput()));

      expect(failure).toEqual({
        kind: "members-unreachable",
        members: [{ member: "agent:carol", reason: "unknown-agent" }],
      });
      expect(observed.sent).toEqual([]);
    }),
  );
}

/**
 * A refused post makes its member `no-answer`; a post still certifying when
 * the send returns leaves its member `no-answer` only if it is still pending
 * at the deadline. The send reports neither: the result does.
 */
function continuesAGatherPastMembersItCouldNotReach() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, {
        "agent:carol": "network-unavailable",
        "agent:dave": "slow",
      });
      const sending = yield* Effect.fork(
        send(layer, { ...gatherInput(), to: "group:alice,bob,carol,dave" }),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const outcome = yield* Fiber.join(sending);

      expect(Object.keys(outcome)).toEqual(["postIds", "operationId"]);
      expect(observed.sent.map((post) => post.to)).toEqual(["agent:bob"]);

      const id = outcome.operationId ?? requestId;
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, { action: "decline" }),
      );

      expect(observed.emitted).toEqual([]);

      yield* TestClock.adjust(Duration.seconds(60));

      expect(observed.emitted).toEqual([
        {
          kind: "collectiveResult",
          id,
          to: "group:alice,bob,carol,dave",
          question: questionText,
          outcomes: [
            { member: "agent:bob", outcome: { kind: "declined" } },
            { member: "agent:carol", outcome: { kind: "no-answer" } },
            { member: "agent:dave", outcome: { kind: "no-answer" } },
          ],
        },
      ]);
    }),
  );
}

/** A post certified after the send stopped waiting still asks its member. */
function countsAnAnswerToAPostCertifiedAfterTheWait() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, { "agent:carol": "late" });
      const sending = yield* Effect.fork(send(layer, gatherInput()));
      yield* TestClock.adjust(Duration.seconds(1));
      const outcome = yield* Fiber.join(sending);
      yield* TestClock.adjust(Duration.seconds(5));
      const id = outcome.operationId ?? requestId;
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, { action: "decline" }),
      );
      yield* classifyPost(
        layer,
        answerPost("agent:carol", id, {
          action: "accept",
          content: { slot: "tue" },
        }),
      );

      expect(observed.sent.map((post) => post.to)).toEqual([
        "agent:bob",
        "agent:carol",
      ]);
      expect(observed.emitted).toMatchObject([
        {
          kind: "collectiveResult",
          outcomes: [
            { member: "agent:bob", outcome: { kind: "declined" } },
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

function failsAGatherNoneOfWhosePostsWasDelivered() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, {
        "agent:bob": "network-unavailable",
        "agent:carol": "persistence-failed",
      });
      const failure = yield* collectiveFailureOf(send(layer, gatherInput()));
      yield* TestClock.adjust(Duration.seconds(60));

      expect(failure).toEqual({
        kind: "members-unreachable",
        members: [
          { member: "agent:bob", reason: "network-unavailable" },
          { member: "agent:carol", reason: "persistence-failed" },
        ],
      });
      expect(observed.emitted).toEqual([]);
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

/**
 * A multi-select whose `items` omit `"type":"string"` is the form requesters
 * most often get wrong, so the refusal names the property, the keyword and
 * the shape that would pass.
 */
function namesTheFailingKeywordAndTheExpectedShapeOfAnInvalidProperty() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const failure = yield* collectiveFailureOf(
        send(
          layer,
          gatherInput(60, {
            type: "object",
            properties: {
              note: { type: "string" },
              slots: { type: "array", items: { enum: ["mon", "tue"] } },
            },
          }),
        ),
      );

      expect(failure).toEqual({
        kind: "schema-invalid",
        detail:
          'properties.slots: items.type: Invalid input: expected "string"; a multi-select is {"type":"array","items":{"type":"string","enum":["a","b"]}}',
      });
    }),
  );
}

function namesTheUndeclaredRequiredField() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const failure = yield* collectiveFailureOf(
        send(
          layer,
          gatherInput(60, {
            type: "object",
            properties: { note: { type: "string" } },
            required: ["slot"],
          }),
        ),
      );

      expect(failure).toEqual({
        kind: "schema-invalid",
        detail: 'required: names "slot", which properties does not declare',
      });
    }),
  );
}

function emitsARefusedGatherAsAnOperationFailedItemWhenFailuresGoInbound() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const unknownMember = "agent:carol";
      const layer = yield* makeLayer(observed, {}, undefined, {
        unknown: [unknownMember],
      });
      const outcome = yield* send(layer, gatherInput(), "inbound");

      const [emitted, ...rest] = observed.emitted;
      expect(rest).toEqual([]);
      expect(emitted).toMatchObject({
        kind: "operationFailed",
        id: outcome.operationId,
        to: gatherTo,
      });
      expect(emitted?.kind === "operationFailed" && emitted.error).toContain(
        unknownMember,
      );
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
    nonce: requestNonce,
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
        to: "agent:bob",
        collectiveResponse: { action: "accept", content: { slot: "mon" } },
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
          to: "agent:bob",
          collectiveResponse: { action: "accept", content: { slot: "sun" } },
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
        to: "agent:bob",
        collectiveResponse: { action: "decline" },
      };
      yield* send(layer, decline);

      expect(yield* collectiveFailureOf(send(layer, decline))).toEqual({
        kind: "request-answered",
      });
    }),
  );
}

function reportsAnUnmatchedAnswerInTheConversationItWasSentTo() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const outcome = yield* send(
        layer,
        { to: "agent:bob", collectiveResponse: { action: "decline" } },
        "inbound",
      );

      expect(observed.sent).toEqual([]);
      expect(observed.emitted).toMatchObject([
        {
          kind: "operationFailed",
          id: outcome.operationId,
          to: "agent:bob",
        },
      ]);
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
          to: "agent:bob",
          collectiveResponse: { action: "decline" },
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

/**
 * The answer that completes a gather fails its classification when the result
 * cannot be kept, so the pass classifying it ends instead of waiting.
 */
function failsTheCompletingAnswerWhenTheResultCannotBeKept() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved(), {}, undefined, {
        emitFails: true,
      });
      const id = yield* startGather(layer);
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, { action: "decline" }),
      );
      const failure = yield* Effect.flip(
        classifyPost(
          layer,
          answerPost("agent:carol", id, { action: "decline" }),
        ),
      );

      expect(failure).toEqual(new CollectiveEmitError());
    }),
  );
}

/** A refusal routed inbound that cannot be kept fails the send as persistence-failed. */
function failsASendWhoseInboundRefusalCannotBeKept() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved(), {}, undefined, {
        emitFails: true,
      });
      const failure = yield* Effect.flip(
        send(
          layer,
          { to: "agent:bob", collectiveResponse: { action: "decline" } },
          "inbound",
        ),
      );

      expect(failure).toMatchObject({ reason: "persistence-failed" });
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
        answerPost("agent:bob", id, { action: "decline" }),
      );
      yield* TestClock.adjust(Duration.seconds(60));

      expect(observed.emitted).toEqual([
        {
          kind: "collectiveResult",
          id,
          to: gatherTo,
          question: questionText,
          outcomes: [
            { member: "agent:bob", outcome: { kind: "declined" } },
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

function asksTheOneAgentOfAGroupAddressNamingOneOtherAgent() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      yield* send(layer, { ...gatherInput(), to: "group:bob" });

      expect(observed.sent.map((post) => post.to)).toEqual(["agent:bob"]);
    }),
  );
}

function refusesAGatherToAGroupThatNamesAMemberTwice() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      const failure = yield* collectiveFailureOf(
        send(layer, { ...gatherInput(), to: "group:bob,carol,bob" }),
      );

      expect(failure).toMatchObject({ reason: "membership-invalid" });
      expect(observed.sent).toEqual([]);
    }),
  );
}

function asksTheOneAgentOfAnAgentAddress() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      yield* send(layer, { ...gatherInput(), to: "agent:bob" });

      expect(observed.sent.map((post) => post.to)).toEqual(["agent:bob"]);
    }),
  );
}

/**
 * A deadline no later than the send wait, with every post still pending,
 * ends the gather in one result and no refusal.
 */
function endsAPendingGatherAtItsDeadlineInOneResult() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed, {
        "agent:bob": "slow",
        "agent:carol": "slow",
      });
      const sending = yield* Effect.fork(send(layer, gatherInput(1)));
      yield* TestClock.adjust(Duration.seconds(1));
      const outcome = yield* Fiber.join(sending);
      yield* TestClock.adjust(Duration.seconds(60));

      expect(outcome.postIds).toEqual([]);
      expect(observed.emitted).toEqual([
        {
          kind: "collectiveResult",
          id: outcome.operationId,
          to: gatherTo,
          question: questionText,
          outcomes: [
            { member: "agent:bob", outcome: { kind: "no-answer" } },
            { member: "agent:carol", outcome: { kind: "no-answer" } },
          ],
        },
      ]);
    }),
  );
}

function stopsTheDeadlineTimerOfAGatherEveryMemberAnswered() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.track;
      const layer = yield* makeLayer(observed);
      const id = yield* startGather(layer).pipe(Effect.supervised(supervisor));
      yield* classifyPost(
        layer,
        answerPost("agent:bob", id, { action: "decline" }),
      );
      yield* classifyPost(
        layer,
        answerPost("agent:carol", id, { action: "decline" }),
      );

      expect(yield* supervisor.value).toEqual([]);
    }),
  );
}

function completesAGatherWhoseDeadlineIsThirtyDaysAway() {
  const observed = newObserved();

  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(observed);
      yield* send(layer, gatherInput(2_592_000));
      yield* TestClock.adjust(Duration.days(30));

      expect(observed.emitted).toMatchObject([{ kind: "collectiveResult" }]);
    }),
  );
}

function consumesARequestWhoseIdDoesNotDeriveFromItsSender() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      const takenOver = yield* classifyPost(
        layer,
        requestPost("agent:mallory", 60_000),
      );
      const honest = yield* classifyPost(
        layer,
        requestPost("agent:bob", 60_000),
      );

      expect(takenOver).toEqual(Option.none());
      expect(Option.isSome(honest)).toBe(true);
    }),
  );
}

function consumesARequestWhoseDeadlineLiesBeyondTheLongestAGatherStates() {
  return run(
    Effect.gen(function* () {
      const layer = yield* makeLayer(newObserved());
      const item = yield* classifyPost(
        layer,
        requestPost("agent:bob", Duration.toMillis(Duration.days(31)) + 1),
      );

      expect(item).toEqual(Option.none());
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
    "refuses a gather with an unknown member before posting to anyone",
    refusesAGatherWithAnUnknownMemberBeforeAnyPost,
  );
  it(
    "continues a gather past refused and pending members, which end as no-answer",
    continuesAGatherPastMembersItCouldNotReach,
  );
  it(
    "counts an answer to a request post certified after the wait",
    countsAnAnswerToAPostCertifiedAfterTheWait,
  );
  it(
    "fails a gather none of whose request posts was delivered",
    failsAGatherNoneOfWhosePostsWasDelivered,
  );

  it(
    "fails a gather whose schema is outside the form-mode grammar",
    failsAGatherWhoseSchemaIsOutsideTheFormModeGrammar,
  );

  it(
    "names the failing keyword and the expected shape of an invalid property",
    namesTheFailingKeywordAndTheExpectedShapeOfAnInvalidProperty,
  );

  it(
    "names a required field the schema does not declare",
    namesTheUndeclaredRequiredField,
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
    "posts a valid answer to the request open in the requester's direct conversation",
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
    "reports an unmatched answer inbound in the conversation it was sent to",
    reportsAnUnmatchedAnswerInTheConversationItWasSentTo,
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

  it(
    "ends a gather whose posts are all pending at a deadline within the wait in one result and no refusal",
    endsAPendingGatherAtItsDeadlineInOneResult,
  );

  it(
    "stops the deadline timer of a gather every member answered",
    stopsTheDeadlineTimerOfAGatherEveryMemberAnswered,
  );

  it(
    "completes a gather whose deadline is thirty days away",
    completesAGatherWhoseDeadlineIsThirtyDaysAway,
  );
});

// @agent-code-guard/regression-only: examples pin that a gather shares the send address rule.
describe("gather addressing", () => {
  it(
    "asks the one agent of a group address naming one other agent",
    asksTheOneAgentOfAGroupAddressNamingOneOtherAgent,
  );

  it(
    "refuses a gather to a group that names a member twice",
    refusesAGatherToAGroupThatNamesAMemberTwice,
  );

  it("asks the one agent of an agent address", asksTheOneAgentOfAnAgentAddress);
});

// @agent-code-guard/regression-only: examples pin which received requests a member keeps.
describe("received request checks", () => {
  it(
    "consumes a request whose id does not derive from its sender",
    consumesARequestWhoseIdDoesNotDeriveFromItsSender,
  );

  it(
    "consumes a request whose deadline lies beyond the longest a gather states",
    consumesARequestWhoseDeadlineLiesBeyondTheLongestAGatherStates,
  );
});
describe("emitted items the service cannot keep", () => {
  it(
    "fails the completing answer when the result cannot be kept",
    failsTheCompletingAnswerWhenTheResultCannotBeKept,
  );
  it(
    "fails a send whose inbound refusal cannot be kept",
    failsASendWhoseInboundRefusalCannotBeKept,
  );
});

/* eslint-enable max-lines -- Restore repository defaults. */
