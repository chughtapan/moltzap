/** @file Two real daemons certify, deliver, and recover multicast operations. */

import { ProtocolErrorCode } from "@modelcontextprotocol/client";
import { AgentCard, type AgentName } from "@moltzap/identity";
import { Duration, Effect, Fiber, Option, Schema, Stream } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  databasePath,
  rewindToPreCutoverSchema,
} from "../src/__tests__/store-schema-fixtures.js";
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

/** Sends one addressed post and waits for the peer to receive it. */
const deliverDirect = (input: {
  readonly from: DaemonProcessFixture;
  readonly to: DaemonProcessFixture;
  readonly text: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sender = yield* acquireHarnessEndpoint(input.from.endpoint);
      const receiver = yield* acquireHarnessEndpoint(input.to.endpoint);
      const delivery = yield* Effect.forkScoped(
        nextDelivery(receiver.messages),
      );
      yield* sender.send({
        to: directAddress(input.to.agentName),
        text: input.text,
      });
      const inbound = yield* Fiber.join(delivery);
      expect(inbound.item).toMatchObject({
        kind: "multicast",
        message: {
          kind: "direct",
          sender: directAddress(input.from.agentName),
          content: [{ type: "text", text: input.text }],
        },
      });
      yield* inbound.acknowledge;
    }),
  );

const beforeRestartText = "sent before the daemon restarts";
const fromRestartedText = "sent by the restarted daemon";
const toRestartedText = "sent to the restarted daemon";

const singleRestartBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [restartedFixture, peerFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "restart-subject"),
      makeDaemonProcessFixture(infrastructure, "restart-peer"),
    ] as const,
    { concurrency: 2 },
  );
  const restartedDaemon = yield* acquireDaemonProcess(restartedFixture);
  yield* acquireDaemonProcess(peerFixture);
  yield* registerFixture(restartedFixture);
  yield* registerFixture(peerFixture);

  yield* deliverDirect({
    from: restartedFixture,
    to: peerFixture,
    text: beforeRestartText,
  });

  yield* stopProcess(restartedDaemon);
  yield* acquireDaemonProcess(restartedFixture);

  yield* deliverDirect({
    from: restartedFixture,
    to: peerFixture,
    text: fromRestartedText,
  });
  yield* deliverDirect({
    from: peerFixture,
    to: restartedFixture,
    text: toRestartedText,
  });

  const history = yield* readDurableHistory(
    restartedFixture,
    directAddress(peerFixture.agentName),
  );
  expect(
    history.records.map(({ recordCore }) => recordCore.action.kind),
  ).toEqual(["GENESIS", "POST", "POST"]);
  expect(
    history.records.map(
      ({ recordCore }) => recordCore.action.postIntent.content[0],
    ),
  ).toEqual([
    { type: "text", text: beforeRestartText },
    { type: "text", text: fromRestartedText },
    { type: "text", text: toRestartedText },
  ]);
}).pipe(Effect.scoped);

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

/** The store's schema version and whether it still binds an identity. */
const readStoredIdentity = (fixture: DaemonProcessFixture) =>
  Effect.sync(() => {
    const database = new DatabaseSync(databasePath(fixture.stateDirectory), {
      readOnly: true,
    });
    const version = database.prepare("PRAGMA user_version").get();
    const identity = database
      .prepare("SELECT agent_id FROM identity_binding WHERE singleton = 1")
      .get();
    database.close();
    return { version, bound: identity !== undefined };
  });

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

  yield* rewindToPreCutoverSchema(registeredFixture.stateDirectory, 3);
  yield* expectConfigurationFailure(
    withMissingAdmissionCredential(registeredFixture),
  );
  expect(yield* readStoredIdentity(registeredFixture)).toEqual({
    version: { user_version: 3 },
    bound: true,
  });

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

it("delivers both ways after one real daemon restarts while its peer stays up", () => {
  expect.hasAssertions();
  return Effect.runPromise(singleRestartBehavior);
}, 180_000);

/** `fixture` configured with `other`'s agent key in place of its own. */
const withAgentKeyOf = (
  fixture: DaemonProcessFixture,
  other: DaemonProcessFixture,
): DaemonProcessFixture => ({
  ...fixture,
  environment: {
    ...fixture.environment,
    MOLTZAPD_AGENT_PRIVATE_KEY_FILE: other.agentPrivateKeyFile,
  },
});

/**
 * A registered state directory restarted with another agent's key holds an
 * identity row that fails verification against the configured key, so the
 * daemon refuses to start, in phase storage, before it listens. Fails when
 * startup reports the refusal in another phase or accepts the row.
 */
const identityKeyMismatchBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [registeredFixture, otherFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "identity-registered"),
      makeDaemonProcessFixture(infrastructure, "identity-other-key"),
    ] as const,
    { concurrency: 2 },
  );
  const firstRun = yield* acquireDaemonProcess(registeredFixture);
  yield* registerFixture(registeredFixture);
  yield* stopProcess(firstRun);

  const failure = yield* awaitDaemonStartupFailure(
    withAgentKeyOf(registeredFixture, otherFixture),
  );

  expect(failure.exitCode).not.toBe(0);
  expect(failure.logs).toContain("moltzapd startup failed in phase storage");
}).pipe(Effect.scoped);

it("refuses to start in phase storage when its identity row fails verification", () => {
  expect.hasAssertions();
  return Effect.runPromise(identityKeyMismatchBehavior);
}, 180_000);
