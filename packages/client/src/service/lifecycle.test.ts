/** @file Focused daemon activation, supervision, and durable delivery tests. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server";
import { AgentCard } from "@moltzap/identity";
import { Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../delivery/operations.js";
import type { HarnessMcpEventHandler } from "../endpoint/mcp/tools.js";
import type { EnginePendingMessage } from "../transport/messaging/index.js";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  type Fixture,
  makeFixture,
} from "../__tests__/daemon-runtime-fixtures.js";
import {
  awaitFrame,
  awaitStage,
  EXPECTED_LISTENER_FAILURE,
  makeHarness,
  makeListenRequest,
  makeStore,
  type ReadBarrier,
  requireEventStore,
  requireHandler,
  requireOperations,
  responseReader,
  run,
  type RuntimeHarness,
  SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
} from "../__tests__/daemon-runtime-harness.js";
import { stateDirectory } from "../__tests__/store-schema-fixtures.js";
import { HistoryExportRecord } from "../delivery/history-export.js";
import { INBOX_PENDING_EVENT } from "../endpoint/mcp/names.js";
import { SendError, SendInput } from "../index.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
} from "../store/index.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import { DaemonRuntimeError } from "./lifecycle.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- The focused tests drive the official Promise-native MCP stream boundary. */

const withHistoryExport = (fixture: Fixture, path: string): Fixture => ({
  ...fixture,
  bootstrap: {
    ...fixture.bootstrap,
    configuration: {
      ...fixture.bootstrap.configuration,
      historyExport: path,
    },
  },
});

const decodeHistoryLine = Schema.decodeUnknownSync(
  Schema.parseJson(HistoryExportRecord),
);

/**
 * The records a history export file holds, one per NDJSON line.
 * @param path The export file.
 * @returns The decoded records, in file order.
 */
const readHistoryExport = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.map((text) =>
      text
        .trimEnd()
        .split("\n")
        .map((line) => decodeHistoryLine(line)),
    ),
    Effect.provide(NodeFileSystem.layer),
  );

/**
 * The daemon opens the configured history export and hands that export to
 * delivery, so an inbox read writes the item to the configured file. The
 * engine has no pending delivery, so the read's item is the only record.
 */
const opensConfiguredHistoryExport = async () => {
  const path = join(stateDirectory(), "history.ndjson");
  const fixture = withHistoryExport(await Effect.runPromise(makeFixture), path);
  const harness = await Effect.runPromise(makeHarness(fixture, "none", true));
  harness.delivery.acknowledged = true;
  const store = makeStore(fixture, true);
  const fiber = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const item = Schema.decodeUnknownSync(InboundItem)({
      kind: "operationFailed",
      id: digest("col_", 8),
      to: "agent:bob",
      error: "retained failure",
    });
    await Effect.runPromise(
      store.putInboxItem({
        deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
          digest("dlv_", 8),
        ),
        canonicalItem: await Effect.runPromise(encodeRuntimeValue(item)),
      }),
    );
    await Effect.runPromise(requireEventStore(harness).readInbox({ limit: 1 }));

    expect(await Effect.runPromise(readHistoryExport(path))).toEqual([
      expect.objectContaining({ kind: "inbound", item }),
    ]);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

/**
 * Without a configured path the daemon opens no history export. The check
 * runs once the listener is up, after every startup step that could open one.
 */
const opensNoHistoryExportByDefault = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none", true));
  const store = makeStore(fixture, true);
  const fiber = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    expect(harness.getHistoryExportPath()).toBeUndefined();
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

const blocksStartupAndSupervisesWorker = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "worker", true));
  const store = makeStore(fixture, true);
  const fiber = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(
      Option.isNone(
        await Effect.runPromise(Deferred.poll(harness.listenerReady)),
      ),
      "listener stays closed while the engine is blocked",
    ).toBe(true);

    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    await awaitStage(Deferred.await(harness.listenerReady), "listener");

    await Effect.runPromise(Deferred.succeed(harness.failure, undefined));
    const failure = await awaitStage(
      Effect.flip(Fiber.join(fiber)),
      "Router worker supervision",
    );
    expect(failure).toEqual(EXPECTED_LISTENER_FAILURE);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

/**
 * A startup pass that cannot persist the classified pending delivery fails in
 * storage, and the listener never opens.
 */
const failsStartupWhenInboxPersistenceFails = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const harness = yield* makeHarness(fixture, "none");
      const store: EndpointStore = {
        ...makeStore(fixture, true),
        putInboxItem: () =>
          Effect.fail(new EndpointStoreError({ reason: "persistence" })),
      };

      const error = yield* run(fixture, store, harness).pipe(Effect.flip);

      expect(error).toEqual(new DaemonRuntimeError({ phase: "storage" }));
      expect(
        Option.isNone(yield* Deferred.poll(harness.listenerReady)),
        "listener stays closed after the failed startup pass",
      ).toBe(true);
    }),
  );

/**
 * A startup pass that cannot read pending deliveries fails in storage, and
 * the listener never opens.
 */
const failsStartupWhenThePendingReadFails = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const harness = yield* makeHarness(fixture, "none");
      harness.delivery.failReads = true;

      const error = yield* run(fixture, makeStore(fixture, true), harness).pipe(
        Effect.flip,
      );

      expect(error).toEqual(new DaemonRuntimeError({ phase: "storage" }));
      expect(
        Option.isNone(yield* Deferred.poll(harness.listenerReady)),
        "listener stays closed after the failed startup pass",
      ).toBe(true);
    }),
  );

/** A response to no open request, which the collective layer refuses. */
const unmatchedResponse = Schema.decodeUnknownSync(SendInput)({
  to: "agent:bob",
  collectiveResponse: { action: "decline" },
});

/**
 * A pass holds the delivery gate while the collective layer emits, so an
 * emission that waited on the gate would deadlock the daemon. Here a pass is
 * held inside its pending read while a refused send routes its failure
 * inbound; the send returns and its item is readable once the pass ends.
 */
const emitsWhileAPassHoldsTheDeliveryGate = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  const fiber = Effect.runFork(
    run(fixture, makeStore(fixture, true, harness.delivery), harness),
  );
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const readBarrier: ReadBarrier = {
      entered: await Effect.runPromise(Deferred.make<undefined>()),
      release: await Effect.runPromise(Deferred.make<undefined>()),
    };
    harness.delivery.readBarrier = readBarrier;
    const reader = responseReader(
      await requireHandler(harness).fetch(makeListenRequest("listener-1")),
    );
    await awaitFrame(reader, "subscription acknowledgment");
    await awaitStage(Deferred.await(readBarrier.entered), "held pass");

    const operations = requireOperations(harness);
    const sent = await awaitStage(
      operations.send({ input: unmatchedResponse, failureDelivery: "inbound" }),
      "send while the pass holds the delivery gate",
    );
    await Effect.runPromise(Deferred.succeed(readBarrier.release, undefined));
    const inbox = await awaitStage(operations.readInbox({}), "inbox read");

    expect(inbox.items.map(({ item }) => item)).toContainEqual(
      expect.objectContaining({
        kind: "operationFailed",
        id: sent.operationId,
      }),
    );
    await reader.cancel();
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

/**
 * An emitted item the store cannot persist fails its send as
 * persistence-failed, rather than leaving the send waiting, and fails the
 * daemon in storage. The store rejects only items other than the fixture's
 * startup delivery.
 */
const failsWhenAnEmittedItemCannotPersist = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  const store = makeStore(fixture, true, harness.delivery);
  const rejectingEmissions: EndpointStore = {
    ...store,
    putInboxItem: (item) =>
      item.deliveryToken === fixture.pending.deliveryToken
        ? store.putInboxItem(item)
        : Effect.fail(new EndpointStoreError({ reason: "persistence" })),
  };
  const daemon = Effect.runFork(run(fixture, rejectingEmissions, harness));
  await awaitStage(Deferred.await(harness.listenerReady), "listener");
  const sent = await awaitStage(
    Effect.exit(
      requireOperations(harness).send({
        input: unmatchedResponse,
        failureDelivery: "inbound",
      }),
    ),
    "send whose refusal cannot be kept",
  );
  const error = await awaitStage(
    Fiber.join(daemon).pipe(Effect.flip),
    "daemon failure after the rejected emission",
  );
  expect(sent).toEqual(
    Exit.fail(new SendError({ reason: "persistence-failed" })),
  );
  expect(error).toEqual(new DaemonRuntimeError({ phase: "storage" }));
};

/**
 * The harness whose listener, on release, interrupts the receipt fiber the
 * test hands it. This stands in for the MCP server ending an in-flight
 * webhook receipt request when the daemon shuts down.
 */
const withReceiptFinalizer = (
  harness: RuntimeHarness,
  receipt: Deferred.Deferred<Fiber.RuntimeFiber<void, EndpointStoreError>>,
): RuntimeHarness => ({
  ...harness,
  dependencies: {
    ...harness.dependencies,
    acquireListener: (input) =>
      harness.dependencies
        .acquireListener(input)
        .pipe(
          Effect.tap(() =>
            Effect.addFinalizer(() =>
              Deferred.await(receipt).pipe(
                Effect.flatMap(Fiber.interrupt),
                Effect.asVoid,
              ),
            ),
          ),
        ),
  },
});

/**
 * Fork one webhook receipt for `token` as the webhook runs it: uninterruptible
 * to its caller, so only the delivery-gate wait inside the receipt can stop it.
 */
const forkWaitingReceipt = (store: EventStore, token: DeliveryToken) =>
  Effect.runFork(
    store
      .completeWebhookDelivery(token, new Uint8Array([1]))
      .pipe(Effect.uninterruptible),
  );

/**
 * A receipt waiting for the delivery gate while a pass's inbox persistence
 * fails is stopped by the fatal shutdown and commits nothing. The startup pass
 * sees the delivery as acknowledged, so only the subscription's pass reaches
 * the failing store. `yieldNow` lets the forked receipt reach its gate wait
 * before the persistence failure is released.
 */
const closesWhileReceiptWaitsOnFailedPersistence = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const original = await Effect.runPromise(makeHarness(fixture, "none"));
  original.delivery.acknowledged = true;
  const entered = await Effect.runPromise(Deferred.make<undefined>());
  const fail = await Effect.runPromise(Deferred.make<undefined>());
  const receipt = await Effect.runPromise(
    Deferred.make<Fiber.RuntimeFiber<void, EndpointStoreError>>(),
  );
  const harness = withReceiptFinalizer(original, receipt);
  let commits = 0;
  const store: EndpointStore = {
    ...makeStore(fixture, true),
    putInboxItem: () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.zipRight(Deferred.await(fail)),
        Effect.zipRight(
          Effect.fail(new EndpointStoreError({ reason: "persistence" })),
        ),
      ),
    completeWebhookDelivery: () =>
      Effect.sync(() => {
        commits += 1;
      }),
  };
  const daemon = Effect.runFork(run(fixture, store, harness));
  await awaitStage(Deferred.await(harness.listenerReady), "listener");
  const eventStore = requireEventStore(harness);
  original.delivery.acknowledged = false;
  const reader = responseReader(
    await requireHandler(harness).fetch(makeListenRequest("fatal-receipt")),
  );
  await awaitStage(Deferred.await(entered), "failing inbox persistence");
  const waiting = forkWaitingReceipt(eventStore, fixture.pending.deliveryToken);
  await Effect.runPromise(Deferred.succeed(receipt, waiting));
  await Effect.runPromise(Effect.yieldNow());
  await Effect.runPromise(Deferred.succeed(fail, undefined));
  expect(
    await awaitStage(Fiber.join(daemon).pipe(Effect.flip), "fatal shutdown"),
  ).toEqual(new DaemonRuntimeError({ phase: "storage" }));
  expect(commits).toBe(0);
  await reader.cancel();
};

const blocksRegistrationAndSupervisesOutbound = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(
    makeHarness(fixture, "outbound", true),
  );
  const fiber = Effect.runFork(
    run(fixture, makeStore(fixture, false), harness),
  );
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const operations = requireOperations(harness);
    const registration = Effect.runFork(
      operations.register(fixture.registerRequest),
    );
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(
      Option.isNone(await Effect.runPromise(Fiber.poll(registration))),
      "registration still running while the engine is blocked",
    ).toBe(true);
    expect(
      await Effect.runPromise(operations.readStatus()),
      "status while the engine is blocked",
    ).toMatchObject({ kind: "active" });

    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    const registrationResult = await awaitStage(
      Fiber.join(registration),
      "registration",
    );
    const encodedLocalCard = await Effect.runPromise(
      Schema.encode(AgentCard)(fixture.localCard),
    );
    expect(registrationResult).toEqual({
      kind: "registered",
      agentCard: encodedLocalCard,
    });

    await Effect.runPromise(Deferred.succeed(harness.failure, undefined));
    const failure = await awaitStage(
      Effect.flip(Fiber.join(fiber)),
      "engine outbound supervision",
    );
    expect(failure).toEqual(EXPECTED_LISTENER_FAILURE);
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

/**
 * Registration runs the first delivery pass uninterruptibly. When that pass
 * cannot read pending deliveries, registration must still settle and the
 * daemon fail in storage, rather than the request waiting forever.
 */
const settlesRegistrationWhenThePassFails = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  harness.delivery.failReads = true;
  const fiber = Effect.runFork(
    run(fixture, makeStore(fixture, false), harness),
  );
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const registration = await awaitStage(
      Effect.exit(requireOperations(harness).register(fixture.registerRequest)),
      "registration settling after the failed pass",
    );
    expect(registration).toEqual(Exit.fail({ reason: "persistence-failed" }));
    expect(
      await awaitStage(Effect.flip(Fiber.join(fiber)), "daemon failure"),
    ).toEqual(new DaemonRuntimeError({ phase: "storage" }));
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

/** Restart over `store` and expect the daemon to start active with `agentCard`. */
const expectActiveAfterRestart = async (
  fixture: Fixture,
  store: EndpointStore,
  agentCard: typeof AgentCard.Encoded,
) => {
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  const daemon = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "restart");
    expect(
      await Effect.runPromise(requireOperations(harness).readStatus()),
      "status after restart",
    ).toEqual({ kind: "active", agentCard });
  } finally {
    await Effect.runPromise(Fiber.interrupt(daemon));
  }
};

/**
 * Start a registration, interrupt it once engine activation has begun, then
 * release activation and wait for the interrupt to settle. `yieldNow` lets
 * the interrupt reach the registration before activation is released.
 */
const interruptRegistrationDuringActivation = async (
  fixture: Fixture,
  harness: RuntimeHarness,
) => {
  const registration = Effect.runFork(
    requireOperations(harness).register(fixture.registerRequest),
  );
  await awaitStage(Deferred.await(harness.engineEntered), "engine acquisition");
  const interruption = Effect.runFork(Fiber.interrupt(registration));
  await Effect.runPromise(Effect.yieldNow());
  await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
  await awaitStage(Fiber.join(interruption), "interrupted registration");
};

/**
 * Cancelling an MCP request aborts its signal, which interrupts the tool's
 * operation. By the time engine activation starts, registration has bound the
 * identity and the daemon reports active, so an interrupt that stopped
 * activation there would leave a daemon that reports active with no
 * protocol, refusing inbox reads and sends as not registered until it
 * restarts. Registration and activation therefore run uninterruptibly: an
 * interrupt that arrives while activation is blocked still lets it finish,
 * deliver, and restart registered.
 */
const finishesRegistrationWhenInterrupted = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none", true));
  const store = makeStore(fixture, false);
  const agentCard = await Effect.runPromise(
    Schema.encode(AgentCard)(fixture.localCard),
  );
  const daemon = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    await interruptRegistrationDuringActivation(fixture, harness);
    const operations = requireOperations(harness);

    expect(
      await Effect.runPromise(operations.readStatus()),
      "status after the interrupted registration",
    ).toEqual({ kind: "active", agentCard });
    expect(
      await Effect.runPromise(
        Effect.exit(
          operations.readInbox({}).pipe(Effect.map((page) => page.items)),
        ),
      ),
      "inbox once the interrupted activation finishes",
    ).toEqual(
      Exit.succeed([
        {
          deliveryToken: fixture.pending.deliveryToken,
          item: { kind: "multicast", message: fixture.pending.message },
        },
      ]),
    );
    expect(
      await awaitStage(
        operations.register(fixture.registerRequest),
        "registration retried after the interrupt",
      ),
    ).toEqual({ kind: "registered", agentCard });
  } finally {
    await Effect.runPromise(Fiber.interrupt(daemon));
  }
  await expectActiveAfterRestart(fixture, store, agentCard);
};

const receivesFirstDelivery = async (
  handler: HarnessMcpEventHandler,
): Promise<undefined> => {
  const reader = responseReader(
    await handler.fetch(makeListenRequest("listener-1")),
  );
  expect(await awaitFrame(reader, "first subscription acknowledgment")).toEqual(
    {
      jsonrpc: "2.0",
      method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
      params: {
        cursor: null,
        truncated: false,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
      },
    },
  );
  expect(await awaitFrame(reader, "first message delivery")).toMatchObject({
    jsonrpc: "2.0",
    method: "notifications/events/event",
    params: {
      name: INBOX_PENDING_EVENT,
      data: { pendingCount: 1 },
      cursor: null,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
    },
  });
  await reader.cancel();
  return undefined;
};

const acknowledgeDuringReplacementDelivery = async (
  harness: RuntimeHarness,
  handler: HarnessMcpEventHandler,
  pending: EnginePendingMessage,
): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
  const readBarrier: ReadBarrier = {
    entered: await Effect.runPromise(Deferred.make<undefined>()),
    release: await Effect.runPromise(Deferred.make<undefined>()),
  };
  harness.delivery.readBarrier = readBarrier;
  const reader = responseReader(
    await handler.fetch(makeListenRequest("listener-2")),
  );
  await awaitFrame(reader, "replacement subscription acknowledgment");
  await awaitStage(
    Deferred.await(readBarrier.entered),
    "pending delivery read",
  );

  const acknowledgment = Effect.runFork(
    requireOperations(harness).acknowledgeDelivery(pending.deliveryToken),
  );
  await Effect.runPromise(Effect.yieldNow());
  await Effect.runPromise(Deferred.succeed(readBarrier.release, undefined));
  expect(
    await awaitFrame(reader, "replacement message delivery"),
  ).toMatchObject({
    jsonrpc: "2.0",
    method: "notifications/events/event",
    params: {
      name: INBOX_PENDING_EVENT,
      data: { pendingCount: 1 },
      cursor: null,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-2" },
    },
  });
  await awaitStage(Fiber.join(acknowledgment), "delivery acknowledgment");
  return reader;
};

const replaysUntilAcknowledged = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  const fiber = Effect.runFork(
    run(fixture, makeStore(fixture, true, harness.delivery), harness),
  );
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const operations = requireOperations(harness);
    const pendingItem = {
      deliveryToken: fixture.pending.deliveryToken,
      item: { kind: "multicast", message: fixture.pending.message },
    };
    expect(
      (await Effect.runPromise(operations.readInbox({}))).items,
      "inbox before any subscriber attaches",
    ).toEqual([pendingItem]);
    expect(harness.delivery.acknowledgedTokens).toEqual([]);
    const handler = requireHandler(harness);

    await receivesFirstDelivery(handler);
    expect(
      (await Effect.runPromise(operations.readInbox({}))).items,
      "inbox after the first subscriber's delivery",
    ).toEqual([pendingItem]);
    harness.delivery.events.length = 0;
    const secondReader = await acknowledgeDuringReplacementDelivery(
      harness,
      handler,
      fixture.pending,
    );
    expect(harness.delivery.acknowledgedTokens).toEqual([
      fixture.pending.deliveryToken,
    ]);
    expect(harness.delivery.events).toEqual(["delivery-ready", "acknowledged"]);
    await secondReader.cancel();
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

describe("daemon runtime composition", () => {
  it(
    "closes after fatal persistence with a receipt waiting for the delivery gate",
    closesWhileReceiptWaitsOnFailedPersistence,
  );
  it(
    "fails startup when classified inbox persistence fails",
    failsStartupWhenInboxPersistenceFails,
  );
  it(
    "emits a local item while a pass holds the delivery gate",
    emitsWhileAPassHoldsTheDeliveryGate,
  );
  it(
    "fails the daemon when an emitted item cannot persist",
    failsWhenAnEmittedItemCannotPersist,
  );
  it(
    "fails startup when the pending read fails",
    failsStartupWhenThePendingReadFails,
  );
  it(
    "settles registration when its first delivery pass fails",
    settlesRegistrationWhenThePassFails,
  );
  it("opens the configured history export", opensConfiguredHistoryExport);
  it(
    "opens no history export when none is configured",
    opensNoHistoryExportByDefault,
  );
  it("waits for the active engine and supervises the Router worker", () =>
    blocksStartupAndSupervisesWorker());
  it("does not finish registration before engine activation", () =>
    blocksRegistrationAndSupervisesOutbound());
  it(
    "finishes registration and activation when the register request is interrupted",
    finishesRegistrationWhenInterrupted,
  );
  it("publishes durable deliveries before completing acknowledgment", () =>
    replaysUntilAcknowledged());
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore repository defaults after the MCP lifecycle tests. */
