/** @file A real daemon recovers a delivery held after Router ordering. */

import type { AgentName } from "@moltzap/identity";
import {
  Duration,
  Effect,
  Fiber,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { expect, it } from "vitest";
import {
  acquireHarnessEndpoint,
  AgentAddress,
  type Content,
  type InboundDelivery,
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
import { acquireRouterHoldProxy } from "./router-hold-proxy.js";

const DELIVERY_TIMEOUT = Duration.seconds(60);
const PARK_POLL_INTERVAL = Duration.millis(25);

/**
 * How long the held endpoint must stay silent while its ordered delivery is
 * parked, and how long it must stay silent afterwards to rule out a replay.
 */
const QUIET_WINDOW = Duration.seconds(2);

const heldContent = [
  { type: "text", text: "posted while the target link is held" },
] as const satisfies Content;
const replyContent = [
  { type: "text", text: "reply after the held delivery is released" },
] as const satisfies Content;
const followUpContent = [
  { type: "text", text: "follow-up in the recovered conversation" },
] as const satisfies Content;

function directAddress(agentName: AgentName): AgentAddress {
  return Schema.decodeUnknownSync(AgentAddress)(`agent:${agentName}`);
}

/** Points one daemon's Router traffic at the hold proxy instead of the Router. */
function throughProxy(
  fixture: DaemonProcessFixture,
  routerOrigin: URL,
): DaemonProcessFixture {
  return {
    ...fixture,
    environment: {
      ...fixture.environment,
      MOLTZAPD_ROUTER_ORIGIN: routerOrigin.origin,
    },
  };
}

const registerFixture = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      const registered = yield* management.register(
        makeRegistrationRequest(fixture),
      );
      expect(registered.kind).toBe("registered");
    }),
  );

const bounded =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutFail({
        duration: DELIVERY_TIMEOUT,
        onTimeout: () => new ProcessTestError({ message }),
      }),
    );

/** Collects the endpoint's single inbound subscription for the whole scope. */
const collectDeliveries = <E>(messages: Stream.Stream<InboundDelivery, E>) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<InboundDelivery>();
    yield* Effect.forkScoped(
      Stream.runForEach(messages, (delivery) => Queue.offer(inbox, delivery)),
    );
    return inbox;
  });

const takeDelivery = (inbox: Queue.Queue<InboundDelivery>) =>
  Queue.take(inbox).pipe(bounded("timed out awaiting certified delivery"));

const expectQuiet = (inbox: Queue.Queue<InboundDelivery>) =>
  Effect.sleep(QUIET_WINDOW).pipe(
    Effect.zipRight(Queue.size(inbox)),
    Effect.map((size) => expect(size).toBe(0)),
  );

const awaitParkedResponse = (parkedResponses: Effect.Effect<number>) =>
  parkedResponses.pipe(
    Effect.repeat({
      until: (count) => count > 0,
      schedule: Schedule.spaced(PARK_POLL_INTERVAL),
    }),
    bounded("Router never ordered a delivery for the held endpoint"),
  );

const readHistory = (fixture: DaemonProcessFixture, address: AgentAddress) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      return yield* management.readConversation(address);
    }),
  );

const heldDeliveryBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const proxy = yield* acquireRouterHoldProxy(infrastructure.routerOrigin);
  const [senderFixture, directFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "held-sender"),
      makeDaemonProcessFixture(infrastructure, "held-target"),
    ] as const,
    { concurrency: 2 },
  );
  const targetFixture = throughProxy(directFixture, proxy.origin);
  yield* acquireDaemonProcess(senderFixture);
  yield* acquireDaemonProcess(targetFixture);
  yield* registerFixture(senderFixture);
  yield* registerFixture(targetFixture);

  const senderAddress = directAddress(senderFixture.agentName);
  const targetAddress = directAddress(targetFixture.agentName);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const sender = yield* acquireHarnessEndpoint(senderFixture.endpoint);
      const target = yield* acquireHarnessEndpoint(targetFixture.endpoint);
      const senderInbox = yield* collectDeliveries(sender.messages);
      const targetInbox = yield* collectDeliveries(target.messages);

      yield* proxy.hold;
      const heldSend = yield* Effect.forkScoped(
        sender.send({ to: targetAddress, content: heldContent }),
      );
      yield* awaitParkedResponse(proxy.parkedResponses);
      yield* expectQuiet(targetInbox);

      yield* proxy.release;
      const released = yield* takeDelivery(targetInbox);
      expect(released.message).toMatchObject({
        kind: "direct",
        address: senderAddress,
        sender: senderAddress,
        content: heldContent,
      });
      yield* released.acknowledge;
      yield* Fiber.join(heldSend).pipe(bounded("held send never certified"));

      yield* target.send({ to: senderAddress, content: replyContent });
      const reply = yield* takeDelivery(senderInbox);
      expect(reply.message).toMatchObject({
        kind: "direct",
        address: targetAddress,
        sender: targetAddress,
        content: replyContent,
      });
      yield* reply.acknowledge;

      yield* sender.send({ to: targetAddress, content: followUpContent });
      const followUp = yield* takeDelivery(targetInbox);
      expect(followUp.message).toMatchObject({
        kind: "direct",
        address: senderAddress,
        sender: senderAddress,
        content: followUpContent,
      });
      yield* followUp.acknowledge;

      yield* expectQuiet(targetInbox);
      expect(yield* Queue.size(senderInbox)).toBe(0);
      expect(yield* proxy.parkedResponses).toBe(1);
    }),
  );

  const expectedContents = [heldContent, replyContent, followUpContent];
  for (const history of [
    yield* readHistory(senderFixture, targetAddress),
    yield* readHistory(targetFixture, senderAddress),
  ]) {
    expect(history.continuation).toBeNull();
    expect(
      history.records.map(({ recordCore }) => recordCore.action.kind),
    ).toEqual(["GENESIS", "POST", "POST"]);
    expect(
      history.records.map(
        ({ recordCore }) => recordCore.action.postIntent.content,
      ),
    ).toEqual(expectedContents);
  }
}).pipe(Effect.scoped);

it("recovers a delivery held after Router ordering between real daemons", () => {
  expect.hasAssertions();
  return Effect.runPromise(heldDeliveryBehavior);
}, 180_000);
