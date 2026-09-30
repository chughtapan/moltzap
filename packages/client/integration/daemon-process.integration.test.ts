/** @file Two real daemons certify, deliver, and recover multicast operations. */

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
  awaitDaemonStartupFailure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  ProcessTestError,
  stopProcess,
} from "./daemon-process-harness.js";

const DELIVERY_TIMEOUT = Duration.seconds(60);
const initialText = "hello from the first real daemon";
const responseText = "addressed response from the second real daemon";
const multicastPart = {
  type: "data",
  value: { "xyz.moltzap/collective": { kind: "operation", op: "multicast" } },
} as const;
const initialContent = [
  { type: "text", text: initialText },
  multicastPart,
] as const satisfies Content;
const responseContent = [
  { type: "text", text: responseText },
  multicastPart,
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
      expect(yield* management.status()).toEqual({ kind: "unregistered" });

      const registered = yield* management.register(
        makeRegistrationRequest(fixture),
      );
      expect(registered.kind).toBe("registered");
      if (registered.kind === "registered") {
        const agentCard = yield* decodeManagementCard(registered.agentCard);
        expect(agentCard.agentName).toBe(fixture.agentName);
      }
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

      yield* caller.send({ to: targetAddress, text: initialText });
      const targetInbound = yield* Fiber.join(targetDelivery);
      expect(targetInbound.item).toMatchObject({
        kind: "multicast",
        message: {
          kind: "direct",
          address: callerAddress,
          sender: callerAddress,
          content: [{ type: "text", text: initialText }],
        },
      });
      yield* targetInbound.acknowledge;

      yield* target.send({ to: callerAddress, text: responseText });
      const callerInbound = yield* Fiber.join(callerDelivery);
      expect(callerInbound.item).toMatchObject({
        kind: "multicast",
        message: {
          kind: "direct",
          address: targetAddress,
          sender: targetAddress,
          content: [{ type: "text", text: responseText }],
        },
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

  yield* Effect.scoped(
    Effect.gen(function* () {
      const caller = yield* acquireHarnessEndpoint(callerFixture.endpoint);
      const target = yield* acquireHarnessEndpoint(targetFixture.endpoint);
      const targetDelivery = yield* Effect.forkScoped(
        nextDelivery(target.messages),
      );
      yield* caller.send({
        to: targetAddress,
        text: "new message after the recipient restarts",
      });
      const incoming = yield* Fiber.join(targetDelivery);
      expect(incoming.item).toMatchObject({
        kind: "multicast",
        message: {
          sender: callerAddress,
          content: [
            { type: "text", text: "new message after the recipient restarts" },
          ],
        },
      });
      yield* incoming.acknowledge;

      const callerDelivery = yield* Effect.forkScoped(
        nextDelivery(caller.messages),
      );
      yield* target.send({
        to: callerAddress,
        text: "reply from the restarted recipient",
      });
      const reply = yield* Fiber.join(callerDelivery);
      expect(reply.item).toMatchObject({
        kind: "multicast",
        message: {
          sender: targetAddress,
          content: [
            { type: "text", text: "reply from the restarted recipient" },
          ],
        },
      });
      yield* reply.acknowledge;
    }),
  );
}).pipe(Effect.scoped);

it("certifies fresh posts in both directions after one daemon restarts", () => {
  expect.hasAssertions();
  return Effect.runPromise(processBehavior);
}, 180_000);

const withoutAdmissionCredential = (
  fixture: DaemonProcessFixture,
): DaemonProcessFixture => ({
  ...fixture,
  environment: Object.fromEntries(
    Object.entries(fixture.environment).filter(
      ([name]) => name !== "MOLTZAPD_ADMISSION_CREDENTIAL_FILE",
    ),
  ),
});

const withMissingAdmissionCredential = (
  fixture: DaemonProcessFixture,
): DaemonProcessFixture => ({
  ...fixture,
  environment: {
    ...fixture.environment,
    MOLTZAPD_ADMISSION_CREDENTIAL_FILE: `${fixture.stateDirectory}.absent-admission`,
  },
});

const withAdmissionCredentialFile = (
  fixture: DaemonProcessFixture,
  path: string,
): DaemonProcessFixture => ({
  ...fixture,
  environment: {
    ...fixture.environment,
    MOLTZAPD_ADMISSION_CREDENTIAL_FILE: path,
  },
});

const expectConfigurationFailure = (fixture: DaemonProcessFixture) =>
  awaitDaemonStartupFailure(fixture).pipe(
    Effect.map((failure) => {
      expect(failure.exitCode).not.toBe(0);
      expect(failure.logs).toContain(
        "moltzapd startup failed in phase configuration",
      );
    }),
  );

const readActiveStatus = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      return yield* management.status();
    }),
  );

const admissionLifetimeBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [registeredFixture, unregisteredFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "admission-registered"),
      makeDaemonProcessFixture(infrastructure, "admission-unregistered"),
    ] as const,
    { concurrency: 2 },
  );

  const firstRun = yield* acquireDaemonProcess(registeredFixture);
  yield* registerFixture(registeredFixture);
  yield* stopProcess(firstRun);

  const unsetRun = yield* acquireDaemonProcess(
    withoutAdmissionCredential(registeredFixture),
  );
  expect((yield* readActiveStatus(registeredFixture)).kind).toBe("active");
  yield* stopProcess(unsetRun);

  const missingRun = yield* acquireDaemonProcess(
    withMissingAdmissionCredential(registeredFixture),
  );
  expect((yield* readActiveStatus(registeredFixture)).kind).toBe("active");
  yield* stopProcess(missingRun);

  const emptyRun = yield* acquireDaemonProcess(
    withAdmissionCredentialFile(registeredFixture, ""),
  );
  expect((yield* readActiveStatus(registeredFixture)).kind).toBe("active");
  yield* stopProcess(emptyRun);

  const invalidRun = yield* acquireDaemonProcess(
    withAdmissionCredentialFile(
      registeredFixture,
      registeredFixture.agentPrivateKeyFile,
    ),
  );
  expect((yield* readActiveStatus(registeredFixture)).kind).toBe("active");
  yield* stopProcess(invalidRun);

  yield* expectConfigurationFailure(
    withoutAdmissionCredential(unregisteredFixture),
  );
  yield* expectConfigurationFailure(
    withMissingAdmissionCredential(unregisteredFixture),
  );
}).pipe(Effect.scoped);

it("restarts a registered daemon without the admission credential", () => {
  expect.hasAssertions();
  return Effect.runPromise(admissionLifetimeBehavior);
}, 180_000);
