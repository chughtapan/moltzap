/** @file Native hosts use the semantic Client over real authenticated MCP without a second adapter transport. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { AgentCard } from "@moltzap/identity";
import {
  Chunk,
  Deferred,
  Effect,
  Fiber,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "vitest";
import type { HarnessSendRequest } from "../../delivery/operations.js";
import type { InboundDelivery } from "./capability.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { loopbackMcpEndpoint } from "../../__tests__/mcp-http-fixtures.js";
import { makeFixture } from "../../__tests__/router-worker-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import { readRuntimeEvent, readRuntimeInbox } from "../../delivery/inbox.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  openEndpointStore,
} from "../../store/index.js";
import { SendInput } from "../../transport/collectives/forms.js";
import { InboundItem } from "../../transport/collectives/inbound.js";
import {
  type ConsumerMetadata,
  decodePollResult,
} from "../event-contract/index.js";
import { HARNESS_CONSUMER_META_KEY, INBOX_ITEM_EVENT } from "../mcp/names.js";
import { makeHarnessMcpHttpHandler } from "../mcp/tools.js";
import { acquireHarnessEndpoint } from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Canonical payloads, closed errors and retained unread counts are Client boundary expectations. */

const credential = Redacted.make("native-poll-test-credential-000001");
const item = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: digest("col_", 1),
  to: "agent:bob",
  error: "retained native item",
});
const token = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 1));
const unused = () => Effect.dieMessage("unrelated native operation reached");
interface ReceiptControl {
  readonly entered: Deferred.Deferred<undefined>;
  readonly commit: Deferred.Deferred<undefined>;
}

const controlledReceipt = <A, E>(
  commit: Effect.Effect<A, E>,
  receipt?: ReceiptControl,
) =>
  receipt === undefined
    ? commit
    : Effect.uninterruptible(
        Deferred.succeed(receipt.entered, undefined).pipe(
          Effect.andThen(Deferred.await(receipt.commit)),
          Effect.andThen(commit),
        ),
      );

const acquireServerWithReceipt = (receipt?: ReceiptControl) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
    const store = yield* openEndpointStore(stateDirectory());
    const attached = yield* Deferred.make<undefined>();
    const unreadRead = yield* Deferred.make<undefined>();
    const sends: HarnessSendRequest[] = [];
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: { name: "native-poll-integration", version: "1" },
      credentials: { runtime: credential },
      eventStore: store,
      onSubscriptionActiveChange: (active) => {
        if (active) {
          Effect.runFork(Deferred.succeed(attached, undefined));
        }
      },
      operations: {
        protocolActive: () => true,
        readStatus: () => Effect.succeed({ kind: "active", agentCard }),
        register: unused,
        searchAgents: unused,
        searchConversations: unused,
        readConversation: unused,
        readEvent: ({ eventId }) => readRuntimeEvent(store, eventId),
        readInbox: (request) =>
          readRuntimeInbox(store, request).pipe(
            Effect.tap(() => Deferred.succeed(unreadRead, undefined)),
          ),
        readInboxSummary: store.readInboxSummary,
        readSend: () => Effect.succeed({ state: "absent" }),
        acknowledgeDelivery: (deliveryToken) =>
          controlledReceipt(store.acknowledgeInboxItem(deliveryToken), receipt),
        send: (request) =>
          Effect.sync(() => {
            sends.push(request);
            return {};
          }),
      },
    });
    const endpoint = yield* loopbackMcpEndpoint(handler);
    const add = encodeRuntimeValue(item).pipe(
      Effect.flatMap((canonicalItem) =>
        store.putInboxItem({ deliveryToken: token, canonicalItem }),
      ),
    );
    return { endpoint, store, handler, attached, unreadRead, sends, add };
  });

const acquireServer = acquireServerWithReceipt();

interface FixtureRequestOptions {
  readonly management?: boolean;
  readonly consumer?: ConsumerMetadata;
  readonly signal?: AbortSignal;
}

const fixtureMetadata = (consumer?: ConsumerMetadata) => ({
  [CLIENT_INFO_META_KEY]: { name: "native-control-fixture", version: "1" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  ...(consumer === undefined ? {} : { [HARNESS_CONSUMER_META_KEY]: consumer }),
});

/** Exercises SDK request framing directly when the abort signal must reach the server callback. */
const invoke = (
  server: Effect.Effect.Success<typeof acquireServer>,
  method: string,
  params: Readonly<Record<string, unknown>>,
  options: FixtureRequestOptions = {},
) =>
  Effect.tryPromise(() =>
    (options.management === true
      ? server.handler.management
      : server.handler
    ).fetch(
      new Request(server.endpoint, {
        method: "POST",
        signal: options.signal,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": method,
          ...(typeof params.name === "string"
            ? { "mcp-name": params.name }
            : {}),
          ...(options.management === true
            ? {}
            : { authorization: `Bearer ${Redacted.value(credential)}` }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: fixtureMetadata(options.consumer),
          },
        }),
      }),
    ),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise<unknown>(() => response.json()),
    ),
  );

const revoke = (server: Effect.Effect.Success<typeof acquireServer>) =>
  invoke(
    server,
    "tools/call",
    { name: "revoke_event_subscription", arguments: {} },
    { management: true },
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(Schema.Struct({ result: Schema.Unknown })),
    ),
    Effect.asVoid,
  );

const poll = (server: Effect.Effect.Success<typeof acquireServer>) =>
  invoke(server, "events/poll", {
    name: INBOX_ITEM_EVENT,
    arguments: {},
    cursor: null,
  }).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(Schema.Struct({ result: Schema.Unknown })),
    ),
    Effect.flatMap(({ result }) => decodePollResult(result)),
  );

const receivesAndAcknowledges = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireServer;
        yield* server.add;
        const endpoint = yield* acquireHarnessEndpoint(server.endpoint, {
          credential,
        });
        const accepted: InboundItem[] = [];
        const delivered = yield* endpoint.messages.pipe(
          Stream.mapEffect((delivery) =>
            Effect.gen(function* () {
              expect(
                (yield* server.store.readInboxSummary()).pendingCount,
              ).toBe(1);
              accepted.push(delivery.item);
              yield* delivery.acknowledge;
              return delivery.item;
            }),
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(Chunk.toReadonlyArray(delivered)).toEqual([item]);
        expect(accepted).toEqual([item]);
        expect((yield* server.store.readInboxSummary()).pendingCount).toBe(0);
        expect(server.handler.hasActiveSubscription()).toBe(false);
      }),
    ),
  );

const preservesSendSemantics = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireServer;
        const endpoint = yield* acquireHarnessEndpoint(server.endpoint, {
          credential,
        });
        const input = yield* Schema.decodeUnknown(SendInput)({
          to: "agent:bob",
          text: "native authenticated send",
        });
        yield* endpoint.send(input, {
          idempotencyKey: "native-send",
          failureDelivery: "inbound",
        });
        expect(server.sends).toEqual([
          { input, idempotencyKey: "native-send", failureDelivery: "inbound" },
        ]);
      }),
    ),
  );

const replaysAfterUnacceptedHandoff = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireServer;
        yield* server.add;
        const endpoint = yield* acquireHarnessEndpoint(server.endpoint, {
          credential,
        });
        const deliveries: InboundDelivery[] = [];
        yield* endpoint.messages.pipe(
          Stream.tap((delivery) =>
            Effect.sync(() => {
              deliveries.push(delivery);
            }),
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        expect((yield* server.store.readInboxSummary()).pendingCount).toBe(1);
        const original = deliveries[0];
        if (original === undefined) {
          return yield* Effect.dieMessage("missing native delivery");
        }
        const stale = yield* original.acknowledge.pipe(Effect.flip);
        expect(stale.reason).toBe("consumer-revoked");
        const recovered = yield* endpoint.messages.pipe(
          Stream.mapEffect((delivery) =>
            delivery.acknowledge.pipe(Effect.as(delivery.item)),
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(Chunk.toReadonlyArray(recovered)).toEqual([original.item]);
        expect((yield* server.store.readInboxSummary()).pendingCount).toBe(0);
      }),
    ),
  );

const addSecondInboxItem = (
  server: Effect.Effect.Success<typeof acquireServer>,
) =>
  Effect.gen(function* () {
    const deliveryToken = Schema.decodeUnknownSync(DeliveryToken)(
      digest("dlv_", 2),
    );
    const secondItem = Schema.decodeUnknownSync(InboundItem)({
      kind: "operationFailed",
      id: digest("col_", 2),
      to: "agent:bob",
      error: "unaccepted remainder",
    });
    yield* encodeRuntimeValue(secondItem).pipe(
      Effect.flatMap((canonicalItem) =>
        server.store.putInboxItem({ deliveryToken, canonicalItem }),
      ),
    );
    return secondItem;
  });

const recoversPartiallyAcceptedBatch = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireServer;
        yield* server.add;
        const secondItem = yield* addSecondInboxItem(server);
        const endpoint = yield* acquireHarnessEndpoint(server.endpoint, {
          credential,
        });
        let offered = 0;
        const first = yield* endpoint.messages.pipe(
          Stream.tap((delivery) =>
            Effect.suspend(() =>
              ++offered === 1 ? delivery.acknowledge : Effect.void,
            ),
          ),
          Stream.map((delivery) => delivery.item),
          Stream.take(2),
          Stream.runCollect,
        );
        expect(Chunk.toReadonlyArray(first)).toEqual([item, secondItem]);
        expect((yield* server.store.readInboxSummary()).pendingCount).toBe(1);
        const recovered = yield* endpoint.messages.pipe(
          Stream.mapEffect((delivery) =>
            delivery.acknowledge.pipe(Effect.as(delivery.item)),
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(Chunk.toReadonlyArray(recovered)).toEqual([secondItem]);
        expect((yield* server.store.readInboxSummary()).pendingCount).toBe(0);
      }),
    ),
  );

const rejectsConcurrentConsumer = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireServer;
        const first = yield* acquireHarnessEndpoint(server.endpoint, {
          credential,
        });
        const second = yield* acquireHarnessEndpoint(server.endpoint, {
          credential,
        });
        const listening = yield* first.messages.pipe(
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.await(server.attached);
        const refused = yield* second.messages.pipe(
          Stream.runDrain,
          Effect.flip,
        );
        expect(refused.reason).toBe("already-listening");
        yield* Fiber.interrupt(listening);
        expect(server.handler.hasActiveSubscription()).toBe(false);
        yield* server.add;
        yield* second.messages.pipe(
          Stream.mapEffect((delivery) => delivery.acknowledge),
          Stream.take(1),
          Stream.runDrain,
        );
        expect((yield* server.store.readInboxSummary()).pendingCount).toBe(0);
      }),
    ),
  );

const rejectsWrongCredential = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireServer;
        const refused = yield* acquireHarnessEndpoint(server.endpoint, {
          credential: Redacted.make("wrong-runtime-credential-00000000"),
        }).pipe(Effect.flip);
        expect(refused.reason).toBe("transport-failed");
        expect(server.handler.hasActiveSubscription()).toBe(false);
      }),
    ),
  );

const receivesAfterBootstrap = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireServer;
        const endpoint = yield* acquireHarnessEndpoint(server.endpoint, {
          credential,
        });
        const received = yield* endpoint.messages.pipe(
          Stream.mapEffect((delivery) =>
            delivery.acknowledge.pipe(Effect.as(delivery.item)),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(server.unreadRead);
        yield* server.add;
        expect(Chunk.toReadonlyArray(yield* Fiber.join(received))).toEqual([
          item,
        ]);
        expect((yield* server.store.readInboxSummary()).pendingCount).toBe(0);
        expect(server.handler.hasActiveSubscription()).toBe(false);
      }),
    ),
  );

const reportsRevocation = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireServer;
        const endpoint = yield* acquireHarnessEndpoint(server.endpoint, {
          credential,
        });
        const listening = yield* endpoint.messages.pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.forkScoped,
        );
        yield* Deferred.await(server.unreadRead);
        yield* revoke(server);
        expect((yield* Fiber.join(listening)).reason).toBe("consumer-revoked");
        expect(server.handler.hasActiveSubscription()).toBe(false);
      }),
    ),
  );

const assertReplacementFencesReceipt = (
  server: Effect.Effect.Success<typeof acquireServer>,
  original: ConsumerMetadata,
) =>
  Effect.gen(function* () {
    const replacement = (yield* poll(server))._meta[HARNESS_CONSUMER_META_KEY];
    expect(replacement.generation).not.toBe(original.generation);
    const stale = yield* invoke(
      server,
      "tools/call",
      { name: "acknowledge_delivery", arguments: { deliveryToken: token } },
      { consumer: original },
    );
    expect(stale).toMatchObject({
      error: { code: -32012, data: { reason: "consumer-revoked" } },
    });
  });

const waitsForCanceledReceiptCommit = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const receipt: ReceiptControl = {
          entered: yield* Deferred.make<undefined>(),
          commit: yield* Deferred.make<undefined>(),
        };
        const server = yield* acquireServerWithReceipt(receipt);
        yield* server.add;
        const original = (yield* poll(server))._meta[HARNESS_CONSUMER_META_KEY];
        const controller = new AbortController();
        const acknowledging = yield* invoke(
          server,
          "tools/call",
          {
            name: "acknowledge_delivery",
            arguments: { deliveryToken: token },
          },
          { consumer: original, signal: controller.signal },
        ).pipe(Effect.exit, Effect.forkScoped);
        const revoking = yield* Effect.gen(function* () {
          yield* Deferred.await(receipt.entered);
          controller.abort();
          const retiring = yield* revoke(server).pipe(Effect.forkScoped);
          // Let the independent SDK request run; the held receipt gate must still prevent its completion.
          yield* Effect.sleep("20 millis");
          expect(Option.isNone(yield* Fiber.poll(retiring))).toBe(true);
          expect((yield* server.store.readInboxSummary()).pendingCount).toBe(1);
          return retiring;
        }).pipe(Effect.ensuring(Deferred.succeed(receipt.commit, undefined)));
        yield* Fiber.join(acknowledging);
        yield* Fiber.join(revoking);
        expect((yield* server.store.readInboxSummary()).pendingCount).toBe(0);
        yield* assertReplacementFencesReceipt(server, original);
      }),
    ),
  );

// @agent-code-guard/regression-only: real HTTP authentication and scoped handoff are fixed interoperability scenarios; pagination invariants are generated at the poll owner.
describe("authenticated semantic native endpoint", () => {
  it(
    "retires only accepted items and recovers a partially accepted batch",
    recoversPartiallyAcceptedBatch,
  );
  it(
    "keeps revocation behind an in-flight canceled receipt commit",
    waitsForCanceledReceiptCommit,
  );
  it(
    "receives new occurrences after an empty unread bootstrap",
    receivesAfterBootstrap,
  );
  it(
    "reports owner revocation without silently reacquiring",
    reportsRevocation,
  );
  it(
    "recovers unread bootstrap and acknowledges only inside accepted native handoff",
    receivesAndAcknowledges,
  );
  it(
    "preserves semantic send and invocation options over the same runtime credential",
    preservesSendSemantics,
  );
  it(
    "releases without implicit acknowledgment and fences old receipt closures",
    replaysAfterUnacceptedHandoff,
  );
  it(
    "admits one consumer and releases its lease when interrupted",
    rejectsConcurrentConsumer,
  );
  it(
    "refuses an invalid credential before acquiring a native consumer",
    rejectsWrongCredential,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
