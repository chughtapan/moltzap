/** @file Two real daemons certify, deliver, and recover addressed posts. */

import { ProtocolErrorCode } from "@modelcontextprotocol/client";
import { AgentCard, type AgentName } from "@moltzap/identity";
import { Duration, Effect, Fiber, Option, Schema, Stream } from "effect";
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
  stopProcess,
} from "./daemon-process-harness.js";

const DELIVERY_TIMEOUT = Duration.seconds(60);
const UNREGISTERED_TOOL_CATALOG = ["register", "status"] as const;
const ACTIVE_TOOL_CATALOG = [
  "acknowledge_delivery",
  "read_conversation",
  "search_agents",
  "search_conversations",
  "send_message",
  "status",
] as const;

const initialContent = [
  { type: "text", text: "hello from the first real daemon" },
] as const satisfies Content;
const responseContent = [
  { type: "text", text: "addressed response from the second real daemon" },
] as const satisfies Content;

function directAddress(agentName: AgentName): AgentAddress {
  return Schema.decodeUnknownSync(AgentAddress)(`agent:${agentName}`);
}

function requireDelivery(
  delivery: Option.Option<InboundDelivery>,
): Effect.Effect<InboundDelivery, ProcessTestError> {
  return Option.match(delivery, {
    onNone: () =>
      Effect.fail(
        new ProcessTestError({ message: "message subscription ended" }),
      ),
    onSome: Effect.succeed,
  });
}

function nextDelivery<E>(stream: Stream.Stream<InboundDelivery, E>) {
  return Stream.runHead(stream).pipe(
    Effect.timeoutFail({
      duration: DELIVERY_TIMEOUT,
      onTimeout: () =>
        new ProcessTestError({
          message: "timed out awaiting certified delivery",
        }),
    }),
    Effect.flatMap(requireDelivery),
  );
}

const decodeManagementCard = (encoded: unknown) =>
  Schema.decodeUnknown(AgentCard)(encoded).pipe(
    Effect.mapError(
      (cause) =>
        new ProcessTestError({
          message: "management returned an invalid AgentCard",
          cause,
        }),
    ),
  );

const registerFixture = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.listToolNames()).toEqual(
        UNREGISTERED_TOOL_CATALOG,
      );
      expect(yield* management.status()).toEqual({ kind: "unregistered" });

      const registered = yield* management.register(
        makeRegistrationRequest(fixture),
      );
      expect(registered.kind).toBe("registered");
      if (registered.kind === "registered") {
        const agentCard = yield* decodeManagementCard(registered.agentCard);
        expect(agentCard.agentName).toBe(fixture.agentName);
      }
      expect(yield* management.listToolNames()).toEqual(ACTIVE_TOOL_CATALOG);
    }),
  );

const readDurableHistory = (
  fixture: DaemonProcessFixture,
  address: AgentAddress,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.searchConversations()).toEqual({
        kind: "page",
        addresses: [address],
        hasMore: false,
      });
      return yield* management.readConversation(address);
    }),
  );

const processBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [callerFixture, targetFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "process-caller"),
      makeDaemonProcessFixture(infrastructure, "process-target"),
    ] as const,
    { concurrency: 2 },
  );
  yield* acquireDaemonProcess(callerFixture);
  const targetDaemon = yield* acquireDaemonProcess(targetFixture);

  yield* registerFixture(callerFixture);
  yield* registerFixture(targetFixture);

  yield* Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(
        callerFixture.endpoint,
      );
      const malformed = yield* management.callExpectingProtocolError(
        "read_conversation",
        { conversationId: "retired-public-identifier" },
      );
      expect(malformed.code).toBe(ProtocolErrorCode.InvalidParams);
      expect(malformed.data).toBeUndefined();
    }),
  );

  const callerAddress = directAddress(callerFixture.agentName);
  const targetAddress = directAddress(targetFixture.agentName);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const caller = yield* acquireHarnessEndpoint(callerFixture.endpoint);
      const target = yield* acquireHarnessEndpoint(targetFixture.endpoint);
      const callerDelivery = yield* Effect.forkScoped(
        nextDelivery(caller.messages),
      );
      const targetDelivery = yield* Effect.forkScoped(
        nextDelivery(target.messages),
      );

      yield* caller.send({
        to: targetAddress,
        content: initialContent,
      });
      const targetInbound = yield* Fiber.join(targetDelivery);
      expect(targetInbound.message).toMatchObject({
        kind: "direct",
        address: callerAddress,
        sender: callerAddress,
        content: initialContent,
      });
      yield* targetInbound.acknowledge;

      yield* target.send({
        to: callerAddress,
        content: responseContent,
      });
      const callerInbound = yield* Fiber.join(callerDelivery);
      expect(callerInbound.message).toMatchObject({
        kind: "direct",
        address: targetAddress,
        sender: targetAddress,
        content: responseContent,
      });
      yield* callerInbound.acknowledge;
    }),
  );

  const callerHistory = yield* readDurableHistory(callerFixture, targetAddress);
  const targetHistory = yield* readDurableHistory(targetFixture, callerAddress);
  expect(callerHistory.continuation).toBeNull();
  expect(callerHistory.records).toHaveLength(2);
  expect(
    callerHistory.records.map(({ recordCore }) => recordCore.action.kind),
  ).toEqual(["GENESIS", "POST"]);
  expect(
    callerHistory.records.map(
      ({ recordCore }) => recordCore.action.postIntent.content,
    ),
  ).toEqual([initialContent, responseContent]);
  expect(targetHistory.continuation).toBeNull();
  expect(targetHistory.records).toHaveLength(2);
  expect(
    targetHistory.records.map(({ recordCore }) => recordCore.action.kind),
  ).toEqual(["GENESIS", "POST"]);
  expect(
    targetHistory.records.map(
      ({ recordCore }) => recordCore.action.postIntent.content,
    ),
  ).toEqual([initialContent, responseContent]);

  yield* stopProcess(targetDaemon);
  yield* acquireDaemonProcess(targetFixture);
  const recovered = yield* readDurableHistory(targetFixture, callerAddress);
  expect(recovered.records).toHaveLength(2);
}).pipe(Effect.scoped);

it("certifies addressed posts across two restarted real daemons", () => {
  expect.hasAssertions();
  return Effect.runPromise(processBehavior);
}, 180_000);
