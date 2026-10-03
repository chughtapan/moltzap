/** @file Focused daemon activation, supervision, and durable delivery tests. */

import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server";
import { AgentCard } from "@moltzap/identity";
import { Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../delivery/operations.js";
import type { HarnessMcpEventHandler } from "../endpoint/mcp/tools.js";
import type { EnginePendingMessage } from "../transport/messaging/index.js";
import {
  digest,
  type Fixture,
  makeFixture,
} from "../__tests__/daemon-runtime-fixtures.js";
import {
  awaitFrame,
  awaitStage,
  EXPECTED_LISTENER_FAILURE,
  EXPORT_PATH,
  makeHarness,
  makeListenRequest,
  makeStore,
  type ReadBarrier,
  requireHandler,
  requireOperations,
  responseReader,
  run,
  type RuntimeHarness,
  SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
} from "../__tests__/daemon-runtime-harness.js";
import { INBOX_PENDING_EVENT } from "../endpoint/mcp/schemas.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
} from "../store/index.js";
import { SendInput } from "../transport/collectives/forms.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import { DaemonRuntimeError } from "./lifecycle.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- The focused tests drive the official Promise-native MCP stream boundary. */

const withHistoryExport = (fixture: Fixture): Fixture => ({
  ...fixture,
  bootstrap: {
    ...fixture.bootstrap,
    configuration: {
      ...fixture.bootstrap.configuration,
      historyExport: EXPORT_PATH,
    },
  },
});

const opensConfiguredHistoryExport = async () => {
  const fixture = withHistoryExport(await Effect.runPromise(makeFixture));
  const harness = await Effect.runPromise(makeHarness(fixture, "none", true));
  const store = makeStore(fixture, true);
  const fiber = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(harness.getHistoryExportPath()).toBe(EXPORT_PATH);
    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const deliveryToken = Schema.decodeUnknownSync(DeliveryToken)(
      digest("dlv_", 8),
    );
    const item = Schema.decodeUnknownSync(InboundItem)({
      kind: "operationFailed",
      id: digest("col_", 8),
      to: "agent:bob",
      error: "retained failure",
    });
    const canonicalItem = await Effect.runPromise(encodeRuntimeValue(item));
    await Effect.runPromise(
      store.putInboxItem({ deliveryToken, canonicalItem }),
    );
    const eventStore = harness.getEventStore();
    if (eventStore === undefined) {
      throw new Error("missing composed event store");
    }
    await Effect.runPromise(eventStore.readInbox({ limit: 1 }));
    expect(harness.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "inbound", item }),
      ]),
    );
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

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
    expect(harness.events).toEqual(["worker", "engine"]);
    expect(harness.getWorkerOutbox()).toBe(store);
    expect(
      Option.isNone(
        await Effect.runPromise(Deferred.poll(harness.listenerReady)),
      ),
    ).toBe(true);

    await Effect.runPromise(Deferred.succeed(harness.engineRelease, undefined));
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    expect(harness.events).toEqual(["worker", "engine", "handler", "listener"]);

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
 * A startup pass that cannot persist a classified item, or cannot read
 * pending deliveries, fails in storage before the listener starts.
 */
const failsStartupWhenThePassFails = (failure: "persist" | "read") => () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const harness = yield* makeHarness(fixture, "none");
      const store = makeStore(fixture, true);
      harness.delivery.failReads = failure === "read";
      const startupStore: EndpointStore =
        failure === "read"
          ? store
          : {
              ...store,
              putInboxItem: () =>
                Effect.fail(new EndpointStoreError({ reason: "persistence" })),
            };
      const error = yield* run(fixture, startupStore, harness).pipe(
        Effect.flip,
      );
      expect(error).toEqual(new DaemonRuntimeError({ phase: "storage" }));
      expect(harness.events).toEqual(["worker", "engine"]);
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
 * An emitted item the store cannot persist fails the daemon in storage. The
 * store rejects only items other than the fixture's startup delivery.
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
  const send = Effect.runFork(
    requireOperations(harness).send({
      input: unmatchedResponse,
      failureDelivery: "inbound",
    }),
  );
  const error = await awaitStage(
    Fiber.join(daemon).pipe(Effect.flip),
    "daemon failure after the rejected emission",
  );
  await Effect.runPromise(Fiber.interrupt(send));
  expect(error).toEqual(new DaemonRuntimeError({ phase: "storage" }));
};

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

const forkWaitingReceipt = (
  store: EventStore,
  token: typeof DeliveryToken.Type,
) =>
  Effect.runFork(
    store
      .completeWebhookDelivery(token, new Uint8Array([1]))
      .pipe(Effect.uninterruptible),
  );

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
  const eventStore = harness.getEventStore();
  if (eventStore === undefined) {
    throw new Error("expected the controller event store");
  }
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

const completesCallerStateAfterReceiptCommit = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  const committed = await Effect.runPromise(Deferred.make<undefined>());
  const release = await Effect.runPromise(Deferred.make<undefined>());
  const store: EndpointStore = {
    ...makeStore(fixture, true),
    completeWebhookDelivery: () =>
      Deferred.succeed(committed, undefined).pipe(
        Effect.zipRight(Deferred.await(release)),
      ),
  };
  const daemon = Effect.runFork(run(fixture, store, harness));
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    const eventStore = harness.getEventStore();
    if (eventStore === undefined) {
      throw new Error("expected the controller event store");
    }
    let updated = false;
    const receipt = Effect.runFork(
      eventStore
        .completeWebhookDelivery(
          fixture.pending.deliveryToken,
          new Uint8Array([1]),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              updated = true;
            }),
          ),
          Effect.uninterruptible,
        ),
    );
    await awaitStage(Deferred.await(committed), "receipt commit");
    await Effect.runPromise(Fiber.interruptFork(receipt));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await awaitStage(Fiber.await(receipt), "receipt state update");
    expect(updated).toBe(true);
  } finally {
    await Effect.runPromise(Fiber.interrupt(daemon));
  }
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
    const registration = Effect.runFork(
      requireOperations(harness).register(fixture.registerRequest),
    );
    await awaitStage(
      Deferred.await(harness.engineEntered),
      "engine acquisition",
    );
    expect(
      Option.isNone(await Effect.runPromise(Fiber.poll(registration))),
    ).toBe(true);

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
    expect(Exit.isFailure(registration)).toBe(true);
    expect(
      await awaitStage(Effect.flip(Fiber.join(fiber)), "daemon failure"),
    ).toEqual(new DaemonRuntimeError({ phase: "storage" }));
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
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

/**
 * One pending read per pass: at activation with no subscriber, when the first
 * subscriber attaches, when it detaches, and when its replacement attaches.
 */
const READS_THROUGH_REPLACEMENT = 4;

const replaysUntilAcknowledged = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const harness = await Effect.runPromise(makeHarness(fixture, "none"));
  const fiber = Effect.runFork(
    run(fixture, makeStore(fixture, true, harness.delivery), harness),
  );
  try {
    await awaitStage(Deferred.await(harness.listenerReady), "listener");
    expect(harness.delivery.reads).toBeGreaterThanOrEqual(1);
    expect(harness.delivery.acknowledgedTokens).toEqual([]);
    const handler = requireHandler(harness);

    await receivesFirstDelivery(handler);
    expect(
      (await Effect.runPromise(requireOperations(harness).readInbox({}))).items,
    ).toEqual([
      {
        deliveryToken: fixture.pending.deliveryToken,
        item: { kind: "multicast", message: fixture.pending.message },
      },
    ]);
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
    expect(harness.delivery.reads).toBeGreaterThanOrEqual(
      READS_THROUGH_REPLACEMENT,
    );
    await secondReader.cancel();
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

describe("daemon runtime composition", () => {
  it(
    "finishes the masked caller state update after a committed receipt",
    completesCallerStateAfterReceiptCommit,
  );
  it(
    "closes after fatal persistence with a receipt waiting for the delivery gate",
    closesWhileReceiptWaitsOnFailedPersistence,
  );
  it(
    "fails startup when classified inbox persistence fails",
    failsStartupWhenThePassFails("persist"),
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
    failsStartupWhenThePassFails("read"),
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
  it("publishes durable deliveries before completing acknowledgment", () =>
    replaysUntilAcknowledged());
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore repository defaults after the MCP lifecycle tests. */
