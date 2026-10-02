/** @file Three real daemons run gather operations end to end. */

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

const gather = (
  requester: Participant,
  members: readonly Participant[],
  deadline: number,
) =>
  send(requester, {
    to: `group:${[requester, ...members]
      .map(({ address }) => address.slice("agent:".length))
      .join(",")}`,
    text: question,
    collective: { op: "gather", deadline, requestedSchema: slotSchema },
  });

const acquireParticipants = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const fixtures = yield* Effect.all(
    ["gather-requester", "gather-member-a", "gather-member-b"].map((name) =>
      makeDaemonProcessFixture(infrastructure, name),
    ),
    { concurrency: 3 },
  );
  yield* Effect.forEach(fixtures, acquireDaemonProcess, { discard: true });
  yield* Effect.forEach(fixtures, registerFixture, { discard: true });
  return yield* Effect.forEach(fixtures, joinParticipant);
});

const requireThree = (participants: readonly Participant[]) => {
  const [requester, first, second] = participants;
  return requester === undefined || first === undefined || second === undefined
    ? Effect.dieMessage("expected three participants")
    : Effect.succeed({ requester, first, second });
};

const allAnsweredBehavior = Effect.gen(function* () {
  const { requester, first, second } = yield* acquireParticipants.pipe(
    Effect.flatMap(requireThree),
  );

  const unreachable = yield* send(requester, {
    to: `group:gather-member-a,gather-nobody,gather-requester`,
    text: question,
    collective: { op: "gather", deadline: 60, requestedSchema: slotSchema },
  }).pipe(Effect.flip);
  expect(unreachable).toBeInstanceOf(CollectiveError);
  expect(unreachable).toMatchObject({
    failure: {
      kind: "members-unreachable",
      members: [{ member: "agent:gather-nobody", reason: "unknown-agent" }],
    },
  });

  const started = yield* gather(requester, [first, second], 60);
  /** The refused gather posted nothing, so the first item is this request. */
  const firstRequest = yield* nextItem(first);
  const secondRequest = yield* nextItem(second);
  expect(firstRequest).toEqual({
    kind: "collectiveRequest",
    id: started.operationId,
    postId: expect.any(String),
    from: requester.address,
    to: requester.address,
    question,
    requestedSchema: slotSchema,
    deadlineAt: expect.any(Number),
  });
  expect(secondRequest).toMatchObject({ id: started.operationId });

  const invalid = yield* send(first, {
    to: requester.address,
    collectiveResponse: { action: "accept", content: { slot: "sun" } },
  }).pipe(Effect.flip);
  expect(invalid).toMatchObject({
    failure: { kind: "answer-invalid", fields: [{ field: "slot" }] },
  });
  yield* send(first, {
    to: requester.address,
    collectiveResponse: { action: "accept", content: { slot: "tue" } },
  });
  yield* send(second, {
    to: requester.address,
    collectiveResponse: { action: "decline" },
  });

  expect(yield* nextItem(requester)).toEqual({
    kind: "collectiveResult",
    id: started.operationId,
    to: "group:gather-member-a,gather-member-b,gather-requester",
    question,
    outcomes: [
      {
        member: first.address,
        outcome: { kind: "answered", content: { slot: "tue" } },
      },
      { member: second.address, outcome: { kind: "declined" } },
    ],
  });
}).pipe(Effect.scoped);

const silentMemberBehavior = Effect.gen(function* () {
  const { requester, first, second } = yield* acquireParticipants.pipe(
    Effect.flatMap(requireThree),
  );

  const started = yield* gather(
    requester,
    [first, second],
    SILENT_MEMBER_DEADLINE_SECONDS,
  );
  yield* nextItem(first);
  yield* nextItem(second);
  yield* send(first, {
    to: requester.address,
    collectiveResponse: { action: "accept", content: { slot: "mon" } },
  });

  expect(yield* nextItem(requester)).toMatchObject({
    kind: "collectiveResult",
    id: started.operationId,
    outcomes: [
      {
        member: first.address,
        outcome: { kind: "answered", content: { slot: "mon" } },
      },
      { member: second.address, outcome: { kind: "no-answer" } },
    ],
  });
  const late = yield* send(second, {
    to: requester.address,
    collectiveResponse: { action: "decline" },
  }).pipe(Effect.flip);
  expect(late).toMatchObject({ failure: { kind: "request-expired" } });
}).pipe(Effect.scoped);

it("gathers every member's answer through three real daemons", () => {
  expect.hasAssertions();
  return Effect.runPromise(allAnsweredBehavior);
}, 240_000);

it("reports a silent member as no-answer at the deadline", () => {
  expect.hasAssertions();
  return Effect.runPromise(silentMemberBehavior);
}, 240_000);
