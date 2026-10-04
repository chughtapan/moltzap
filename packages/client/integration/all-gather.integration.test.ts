/** @file A requester and three members run all_gather operations through four real daemons. */

import type { AgentName } from "@moltzap/identity";
import { Duration, Effect, Queue, Schema, type Scope, Stream } from "effect";
import { expect, it } from "vitest";
import {
  acquireHarnessEndpoint,
  AgentAddress,
  CollectiveError,
  type HarnessEndpoint,
  type InboundDelivery,
  type InboundItem,
  SendInput,
} from "../src/index.js";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  ProcessTestError,
} from "./daemon-process-harness.js";

const DELIVERY_TIMEOUT = Duration.seconds(60);
const SILENT_MEMBER_DEADLINE_SECONDS = 15;
const question = "Which day works for the review?";
const group =
  "group:all-gather-member-a,all-gather-member-b,all-gather-member-c,all-gather-requester";
const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
} as const;

/** One endpoint and the items its subscription has delivered, in order. */
interface Participant {
  readonly address: AgentAddress;
  readonly endpoint: HarnessEndpoint;
  readonly inbox: Queue.Queue<InboundDelivery>;
}

function directAddress(agentName: AgentName): AgentAddress {
  return Schema.decodeUnknownSync(AgentAddress)(`agent:${agentName}`);
}

const registerFixture = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    acquireDaemonManagementClient(fixture.endpoint).pipe(
      Effect.flatMap((management) =>
        management.register(makeRegistrationRequest(fixture)),
      ),
    ),
  );

const joinParticipant = (
  fixture: DaemonProcessFixture,
): Effect.Effect<Participant, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const endpoint = yield* acquireHarnessEndpoint(fixture.endpoint).pipe(
      Effect.mapError(
        (cause) =>
          new ProcessTestError({
            message: "endpoint acquisition failed",
            cause,
          }),
      ),
    );
    const inbox = yield* Queue.unbounded<InboundDelivery>();
    yield* endpoint.messages.pipe(
      Stream.runForEach((delivery) => Queue.offer(inbox, delivery)),
      Effect.forkScoped,
    );
    return { address: directAddress(fixture.agentName), endpoint, inbox };
  });

/** Take the participant's next item and acknowledge its delivery. */
const nextItem = (participant: Participant) =>
  Queue.take(participant.inbox).pipe(
    Effect.timeoutFail({
      duration: DELIVERY_TIMEOUT,
      onTimeout: () =>
        new ProcessTestError({
          message: `${participant.address} timed out awaiting an item`,
        }),
    }),
    Effect.tap((delivery) => delivery.acknowledge),
    Effect.map((delivery): InboundItem => delivery.item),
  );

const send = (participant: Participant, input: unknown) =>
  participant.endpoint.send(Schema.decodeUnknownSync(SendInput)(input));

const allGather = (requester: Participant, to: string, deadline: number) =>
  send(requester, {
    to,
    text: question,
    collective: { op: "all_gather", deadline, requestedSchema: slotSchema },
  });

const answer = (member: Participant, slot: string) =>
  send(member, {
    to: group,
    collectiveResponse: { action: "accept", content: { slot } },
  });

const acquireParticipants = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const fixtures = yield* Effect.all(
    [
      "all-gather-requester",
      "all-gather-member-a",
      "all-gather-member-b",
      "all-gather-member-c",
    ].map((name) => makeDaemonProcessFixture(infrastructure, name)),
    { concurrency: 4 },
  );
  yield* Effect.forEach(fixtures, acquireDaemonProcess, { discard: true });
  yield* Effect.forEach(fixtures, registerFixture, { discard: true });
  const [requester, first, second, third] = yield* Effect.forEach(
    fixtures,
    joinParticipant,
  );
  return requester === undefined ||
    first === undefined ||
    second === undefined ||
    third === undefined
    ? yield* Effect.dieMessage("expected four participants")
    : { requester, first, second, third };
});

const allAnsweredBehavior = Effect.gen(function* () {
  const { requester, first, second, third } = yield* acquireParticipants;

  const unreachable = yield* allGather(
    requester,
    "group:all-gather-member-a,all-gather-nobody,all-gather-requester",
    60,
  ).pipe(Effect.flip);
  expect(unreachable).toBeInstanceOf(CollectiveError);
  expect(unreachable).toMatchObject({
    failure: {
      kind: "members-unreachable",
      members: [{ member: "agent:all-gather-nobody", reason: "unknown-agent" }],
    },
  });

  const started = yield* allGather(requester, group, 60);
  const request = {
    kind: "collectiveRequest",
    op: "all_gather",
    id: started.operationId,
    postId: expect.any(String),
    from: requester.address,
    to: group,
    question,
    requestedSchema: slotSchema,
    deadlineAt: expect.any(Number),
  };
  expect(yield* nextItem(first)).toEqual(request);
  expect(yield* nextItem(second)).toEqual(request);
  expect(yield* nextItem(third)).toEqual(request);

  yield* answer(first, "tue");
  yield* answer(second, "mon");
  yield* send(third, {
    to: group,
    collectiveResponse: { action: "decline" },
  });

  const requesterResult = yield* nextItem(requester);
  expect(requesterResult).toEqual({
    kind: "collectiveResult",
    op: "all_gather",
    id: started.operationId,
    to: group,
    question,
    outcomes: [
      {
        member: first.address,
        outcome: { kind: "answered", content: { slot: "tue" } },
      },
      {
        member: second.address,
        outcome: { kind: "answered", content: { slot: "mon" } },
      },
      { member: third.address, outcome: { kind: "declined" } },
    ],
  });
  expect(yield* nextItem(first)).toEqual(requesterResult);
  expect(yield* nextItem(second)).toEqual(requesterResult);
  expect(yield* nextItem(third)).toEqual(requesterResult);
}).pipe(Effect.scoped);

const silentMemberBehavior = Effect.gen(function* () {
  const { requester, first, second, third } = yield* acquireParticipants;

  const started = yield* allGather(
    requester,
    group,
    SILENT_MEMBER_DEADLINE_SECONDS,
  );
  yield* nextItem(first);
  yield* nextItem(second);
  yield* nextItem(third);
  yield* answer(first, "mon");
  yield* answer(second, "mon");

  const requesterResult = yield* nextItem(requester);
  expect(requesterResult).toMatchObject({
    kind: "collectiveResult",
    op: "all_gather",
    id: started.operationId,
    outcomes: [
      { member: first.address, outcome: { kind: "answered" } },
      { member: second.address, outcome: { kind: "answered" } },
      { member: third.address, outcome: { kind: "no-answer" } },
    ],
  });
  expect(yield* nextItem(first)).toEqual(requesterResult);
  expect(yield* nextItem(second)).toEqual(requesterResult);
  expect(yield* nextItem(third)).toEqual(requesterResult);
}).pipe(Effect.scoped);

it("gives the requester and every member the same all_gather result", () => {
  expect.hasAssertions();
  return Effect.runPromise(allAnsweredBehavior);
}, 300_000);

it("closes an all_gather at the deadline without the silent member", () => {
  expect.hasAssertions();
  return Effect.runPromise(silentMemberBehavior);
}, 300_000);
