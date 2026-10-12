/** @file Local consumer closure revokes receipts even when a real MCP release fails. */

import { scopedLive as it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { describe, expect } from "vitest";
import type { InboundDelivery } from "./capability.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { loopbackMcpEndpoint } from "../../__tests__/mcp-http-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import { readRuntimeEvent, readRuntimeInbox } from "../../delivery/inbox.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  openEndpointStore,
} from "../../store/index.js";
import { InboundItem } from "../../transport/collectives/inbound.js";
import { HARNESS_CONSUMER_META_KEY } from "../mcp/names.js";
import { makeHarnessMcpHttpHandler } from "../mcp/tools.js";
import { acquireHarnessEndpoint } from "./index.js";

const credential = Redacted.make("receipt-lifetime-runtime-grant-000001");
const item = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: digest("col_", 1),
  to: "agent:bob",
  error: "retained work after failed release",
});
const token = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 1));
const isRelease = Schema.is(
  Schema.Struct({
    method: Schema.Literal("events/poll"),
    params: Schema.Struct({
      _meta: Schema.Struct({
        [HARNESS_CONSUMER_META_KEY]: Schema.Struct({
          release: Schema.Literal(true),
        }),
      }),
    }),
  }),
);
const unused = () => Effect.dieMessage("unrelated receipt fixture operation");

interface ReleaseFailure {
  readonly entered: Deferred.Deferred<undefined>;
  readonly finish: Deferred.Deferred<undefined>;
  failed: boolean;
}

interface ReceiptCommit {
  readonly entered: Deferred.Deferred<undefined>;
  readonly finish: Deferred.Deferred<undefined>;
  readonly completed: Deferred.Deferred<undefined>;
}

type Handler = Effect.Effect.Success<
  ReturnType<typeof makeHarnessMcpHttpHandler>
>;

describe("poll receipt consumer lifetime", () => {
  it(
    "rejects a retained receipt after one failed release and restored transport",
    rejectsReceiptAfterFailedRelease,
  );
  it(
    "revokes locally while canceled consumer cleanup is still awaiting a failed release",
    revokesBeforeRemoteCleanupCompletes,
  );
  it(
    "cancels an in-flight local receipt without undoing an already admitted daemon commit",
    cancelsReceiptDuringConsumerClosure,
  );
});

function releaseFailure() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      return {
        entered: yield* Deferred.make<undefined>(),
        finish: yield* Deferred.make<undefined>(),
        failed: false,
      } satisfies ReleaseFailure;
    }),
    (failure) => Deferred.succeed(failure.finish, undefined),
  );
}

function receiptCommit() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      return {
        entered: yield* Deferred.make<undefined>(),
        finish: yield* Deferred.make<undefined>(),
        completed: yield* Deferred.make<undefined>(),
      } satisfies ReceiptCommit;
    }),
    (receipt) => Deferred.succeed(receipt.finish, undefined),
  );
}

/** Only one release response is lost; all acquisition, reads and receipt requests use the real SDK handler. */
function failOneRelease(handler: Handler, failure: ReleaseFailure): Handler {
  return {
    ...handler,
    fetch: (request, options) =>
      Effect.tryPromise(() => request.clone().json()).pipe(
        Effect.flatMap((body) => {
          if (!failure.failed && isRelease(body)) {
            failure.failed = true;
            return Deferred.succeed(failure.entered, undefined).pipe(
              Effect.andThen(Deferred.await(failure.finish)),
              Effect.as(new Response(null, { status: 503 })),
            );
          }
          return Effect.tryPromise(() => handler.fetch(request, options));
        }),
        Effect.runPromise,
      ),
  };
}

function acquireServer(failure: ReleaseFailure, receipt?: ReceiptCommit) {
  return Effect.gen(function* () {
    const store = yield* openEndpointStore(stateDirectory());
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: { name: "receipt-lifetime-fixture", version: "1" },
      credentials: { runtime: credential },
      eventStore: store,
      operations: {
        protocolActive: () => true,
        readStatus: () => Effect.succeed({ kind: "unregistered" }),
        register: unused,
        searchAgents: unused,
        searchConversations: unused,
        readConversation: unused,
        readEvent: ({ eventId }) => readRuntimeEvent(store, eventId),
        readInbox: (request) => readRuntimeInbox(store, request),
        readInboxSummary: store.readInboxSummary,
        readSend: () => Effect.succeed({ state: "absent" }),
        acknowledgeDelivery: (deliveryToken) =>
          receipt === undefined
            ? store.acknowledgeInboxItem(deliveryToken)
            : Effect.uninterruptible(
                Deferred.succeed(receipt.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(receipt.finish)),
                  Effect.andThen(store.acknowledgeInboxItem(deliveryToken)),
                  Effect.tap(() =>
                    Deferred.succeed(receipt.completed, undefined),
                  ),
                ),
              ),
        send: unused,
      },
    });
    const address = yield* loopbackMcpEndpoint(
      failOneRelease(handler, failure),
    );
    yield* encodeRuntimeValue(item).pipe(
      Effect.flatMap((canonicalItem) =>
        store.putInboxItem({ deliveryToken: token, canonicalItem }),
      ),
    );
    const endpoint = yield* acquireHarnessEndpoint(address, { credential });
    return { store, handler, endpoint, address };
  });
}

function rejectsReceiptAfterFailedRelease() {
  return Effect.gen(function* () {
    const failure = yield* releaseFailure();
    yield* Deferred.succeed(failure.finish, undefined);
    const server = yield* acquireServer(failure);
    const offered = yield* Deferred.make<InboundDelivery>();
    yield* server.endpoint.messages.pipe(
      Stream.tap((delivery) => Deferred.succeed(offered, delivery)),
      Stream.take(1),
      Stream.runDrain,
    );
    yield* Deferred.await(failure.entered);
    expect(server.handler.hasActiveSubscription()).toBe(true);
    // A second real SDK connection proves transport is restored while the first consumer's lease remains active.
    yield* acquireHarnessEndpoint(server.address, { credential });
    const delivery = yield* Deferred.await(offered);
    const late = yield* Effect.either(delivery.acknowledge);
    expect(late).toMatchObject({
      _tag: "Left",
      left: { reason: "consumer-revoked" },
    });
    expect((yield* server.store.readInboxSummary()).pendingCount).toBe(1);
  }).pipe(Effect.scoped);
}

function revokesBeforeRemoteCleanupCompletes() {
  return Effect.gen(function* () {
    const failure = yield* releaseFailure();
    const server = yield* acquireServer(failure);
    const offered = yield* Deferred.make<InboundDelivery>();
    const listening = yield* server.endpoint.messages.pipe(
      Stream.tap((delivery) => Deferred.succeed(offered, delivery)),
      Stream.runDrain,
      Effect.forkScoped,
    );
    const delivery = yield* Deferred.await(offered);
    const closing = yield* Fiber.interrupt(listening).pipe(Effect.forkScoped);
    yield* Deferred.await(failure.entered);
    expect(yield* Deferred.isDone(failure.finish)).toBe(false);
    expect(yield* Effect.either(delivery.acknowledge)).toMatchObject({
      _tag: "Left",
      left: { reason: "consumer-revoked" },
    });
    expect((yield* server.store.readInboxSummary()).pendingCount).toBe(1);
    yield* Deferred.succeed(failure.finish, undefined);
    yield* Fiber.join(closing);
    expect(server.handler.hasActiveSubscription()).toBe(true);
  }).pipe(Effect.scoped);
}

function cancelsReceiptDuringConsumerClosure() {
  return Effect.gen(function* () {
    const failure = yield* releaseFailure();
    yield* Deferred.succeed(failure.finish, undefined);
    const receipt = yield* receiptCommit();
    const server = yield* acquireServer(failure, receipt);
    const offered = yield* Deferred.make<InboundDelivery>();
    const listening = yield* server.endpoint.messages.pipe(
      Stream.tap((delivery) => Deferred.succeed(offered, delivery)),
      Stream.runDrain,
      Effect.forkScoped,
    );
    const delivery = yield* Deferred.await(offered);
    const acknowledging = yield* Effect.either(delivery.acknowledge).pipe(
      Effect.forkScoped,
    );
    yield* Deferred.await(receipt.entered);
    yield* Fiber.interrupt(listening);
    expect(yield* Fiber.join(acknowledging)).toMatchObject({
      _tag: "Left",
      left: { reason: "consumer-revoked" },
    });
    expect((yield* server.store.readInboxSummary()).pendingCount).toBe(1);
    yield* Deferred.succeed(receipt.finish, undefined);
    yield* Deferred.await(receipt.completed);
    expect((yield* server.store.readInboxSummary()).pendingCount).toBe(0);
  }).pipe(Effect.scoped);
}
