/** @file Pins Events discovery and failure isolation through loopback HTTP. */

import type { Implementation } from "@modelcontextprotocol/server";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Client,
  fromJsonSchema,
  type JsonSchemaType,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { AgentCard } from "@moltzap/identity";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { makeFixture } from "./__tests__/router-worker-fixtures.js";
import { acquireHarnessEndpoint } from "./client-runtime/index.js";
import {
  CollectiveId,
  type HarnessEndpoint,
  InboundItem,
  ListenError,
  SendError,
  SendInput,
} from "./contract.js";
import { readRuntimeEvent } from "./daemon/inbox/index.js";
import { makeSendInvocations } from "./daemon/runtime/send-invocations.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  openEndpointStore,
} from "./endpoint/store.js";
import {
  eventIdOf,
  HARNESS_SEND_META_KEY,
  type HarnessSendRequest,
  INBOX_PENDING_EVENT,
} from "./harness-mcp-contract.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-http.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./harness-mcp-wire.js";

/* eslint-disable agent-code-guard/async-keyword -- These interoperability tests exercise the Promise-native MCP boundary. */

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const IMPLEMENTATION = {
  name: "harness-boundary-test",
  version: "1.0.0",
} satisfies Implementation;
const PRIVATE_STATUS_DEFECT = "private status defect";

const unusedOperation = Effect.dieMessage("operation is outside this test");
const operations: HarnessMcpOperations = {
  readEvent: () => Effect.fail({ reason: "unknown-event" }),
  readInboxSummary: () =>
    Effect.succeed({ pendingCount: 0, newestSequence: 0 }),
  readInbox: () => Effect.succeed({ items: [] }),
  readSend: () => Effect.succeed({ state: "absent" }),
  readStatus: () => Effect.succeed({ kind: "unregistered" }),
  register: () => unusedOperation,
  searchAgents: () => unusedOperation,
  searchConversations: () => unusedOperation,
  readConversation: () => unusedOperation,
  send: () => unusedOperation,
  acknowledgeDelivery: () => unusedOperation,
};

function acquireBoundaryServer(
  selectedOperations: HarnessMcpOperations,
  onSubscriptionActiveChange?: (active: boolean) => void,
  keepAliveMillis?: number,
) {
  return Effect.gen(function* () {
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: IMPLEMENTATION,
      operations: selectedOperations,
      ...(onSubscriptionActiveChange === undefined
        ? {}
        : { onSubscriptionActiveChange }),
      keepAliveMillis,
    });
    const server = yield* acquireHarnessMcpHttpServer({ port: 0, handler });
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    return { port, server };
  });
}

function acquireProtocolClient(port: number, name: string) {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client(
        { name, version: "1.0.0" },
        {
          capabilities: {},
          versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
        },
      );
      yield* Effect.tryPromise({
        try: (signal) =>
          client.connect(
            new StreamableHTTPClientTransport(
              new URL(`http://127.0.0.1:${port}/mcp`),
            ),
            { signal },
          ),
        catch: (cause) => cause,
      });
      return client;
    }),
    (client) => Effect.tryPromise(() => client.close()).pipe(Effect.ignore),
  );
}

function capturesProtocolError(
  client: Client,
  toolArguments: Readonly<Record<string, unknown>>,
) {
  return Effect.tryPromise({
    try: (signal) =>
      client.callTool({ name: "status", arguments: toolArguments }, { signal }),
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onFailure: (cause) => cause,
      onSuccess: () => new Error("status unexpectedly succeeded"),
    }),
  );
}

async function advertisesEventsBeforeRegistration() {
  const capabilities = await Effect.runPromise(
    Effect.gen(function* () {
      const { port } = yield* acquireBoundaryServer(operations);
      const client = yield* acquireProtocolClient(
        port,
        "harness-capability-client",
      );
      return yield* Effect.tryPromise(() =>
        client.request(
          { method: "events/list", params: {} },
          fromJsonSchema<{ events: unknown[] }>({
            type: "object",
            properties: { events: { type: "array" } },
            required: ["events"],
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  const pushDelivery: unknown = expect.arrayContaining(["push"]);
  expect(capabilities.events).toContainEqual(
    expect.objectContaining({
      name: INBOX_PENDING_EVENT,
      delivery: pushDelivery,
    }),
  );
}

async function distinguishesProtocolAndDomainFailures() {
  let storageUnavailable = false;
  const failingOperations: HarnessMcpOperations = {
    ...operations,
    readStatus: () =>
      storageUnavailable
        ? Effect.fail({ reason: "persistence-failed" as const })
        : Effect.succeed({ kind: "unregistered" as const }),
  };
  const [malformedCause, domainCause] = await Effect.runPromise(
    Effect.gen(function* () {
      const { port } = yield* acquireBoundaryServer(failingOperations);
      const client = yield* acquireProtocolClient(
        port,
        "harness-boundary-client",
      );
      storageUnavailable = true;
      return yield* Effect.all(
        [
          capturesProtocolError(client, { unexpected: true }),
          capturesProtocolError(client, {}),
        ],
        { concurrency: 1 },
      );
    }).pipe(Effect.scoped),
  );

  expect(ProtocolError.isInstance(malformedCause)).toBe(true);
  expect(ProtocolError.isInstance(domainCause)).toBe(true);
  if (
    !ProtocolError.isInstance(malformedCause) ||
    !ProtocolError.isInstance(domainCause)
  ) {
    throw new Error("expected protocol errors from both calls");
  }
  expect(malformedCause).toMatchObject({
    code: ProtocolErrorCode.InvalidParams,
  });
  expect(malformedCause.data).toBeUndefined();
  expect(domainCause).toMatchObject({
    code: ProtocolErrorCode.InternalError,
    data: { reason: "persistence-failed" },
  });
}

async function sanitizesUnexpectedOperationDefects() {
  let storageDefective = false;
  const defectiveOperations: HarnessMcpOperations = {
    ...operations,
    readStatus: () =>
      storageDefective
        ? Effect.dieMessage(PRIVATE_STATUS_DEFECT)
        : Effect.succeed({ kind: "unregistered" as const }),
  };
  const cause = await Effect.runPromise(
    Effect.gen(function* () {
      const { port } = yield* acquireBoundaryServer(defectiveOperations);
      const client = yield* acquireProtocolClient(
        port,
        "harness-defect-client",
      );
      storageDefective = true;
      return yield* capturesProtocolError(client, {});
    }).pipe(Effect.scoped),
  );

  expect(ProtocolError.isInstance(cause)).toBe(true);
  if (!ProtocolError.isInstance(cause)) {
    throw new Error("expected a sanitized defect response");
  }
  expect(cause).toMatchObject({
    code: ProtocolErrorCode.InternalError,
    data: { reason: "persistence-failed" },
  });
  expect(String(cause)).not.toContain(PRIVATE_STATUS_DEFECT);
}

async function reportsUnexpectedSubscriptionLoss() {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { server, receive } = yield* observeListeningSubscription();
      yield* Effect.sync(() => {
        server.closeAllConnections();
      });
      return yield* Fiber.join(receive).pipe(
        Effect.timeoutFail({
          duration: Duration.seconds(5),
          onTimeout: () =>
            new Error("message stream did not observe disconnect"),
        }),
      );
    }).pipe(Effect.scoped),
  );

  expect(result).toBeInstanceOf(ListenError);
  expect(result).toMatchObject({ reason: "transport-failed" });
}

async function keepsIdleSubscriptionAlive() {
  expect(await idleSubscriptionOutcome(100)).toEqual({ dropped: false });
}

async function losesIdleSubscriptionWithoutKeepAlive() {
  const outcome = await idleSubscriptionOutcome(60_000);
  expect(outcome).toMatchObject({
    dropped: true,
    cause: { reason: "transport-failed" },
  });
  expect(outcome.dropped ? outcome.cause : undefined).toBeInstanceOf(
    ListenError,
  );
}

/**
 * Node's fetch aborts a silent response body after its body timeout (300 s
 * by default). The test compresses that to 1 s: an idle subscription with
 * keep-alive frames outlives three seconds of silence, one without them
 * fails as transport-failed. The undici devDependency is pinned to the
 * version Node bundles (`process.versions.undici`), because only that version
 * shares the global-dispatcher symbol Node's own fetch reads; if the two
 * diverge, the control test below fails instead of passing vacuously.
 */
async function idleSubscriptionOutcome(keepAliveMillis: number) {
  const dispatcher = getGlobalDispatcher();
  const agent = new Agent({ bodyTimeout: 1000 });
  setGlobalDispatcher(agent);
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const { receive } =
          yield* observeListeningSubscription(keepAliveMillis);
        return yield* Fiber.join(receive).pipe(
          Effect.timeoutTo({
            duration: Duration.seconds(3),
            onTimeout: () => ({ dropped: false as const }),
            onSuccess: (cause) => ({ dropped: true as const, cause }),
          }),
        );
      }).pipe(Effect.scoped),
    );
  } finally {
    setGlobalDispatcher(dispatcher);
    await agent.close();
  }
}

/** A boundary server with one endpoint listening on it, and the fiber observing that stream's end. */
function observeListeningSubscription(keepAliveMillis?: number) {
  return Effect.gen(function* () {
    const subscriptionActive = yield* Deferred.make<undefined>();
    const fixture = yield* makeFixture;
    const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
    const { port, server } = yield* acquireBoundaryServer(
      {
        ...operations,
        readStatus: () => Effect.succeed({ kind: "active", agentCard }),
      },
      (active) => {
        if (active) {
          Effect.runSync(Deferred.succeed(subscriptionActive, undefined));
        }
      },
      keepAliveMillis,
    );
    const endpoint = yield* acquireHarnessEndpoint(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    const receive = yield* endpoint.messages.pipe(
      Stream.runHead,
      Effect.match({
        onFailure: (cause) => cause,
        onSuccess: () =>
          new Error("message stream ended without a transport failure"),
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(subscriptionActive);
    return { server, receive };
  });
}

const sendInput = Schema.decodeUnknownSync(SendInput)({
  to: "agent:bob",
  text: "one semantic action",
});
const sendResult = {};

const distinguishesSendValidationFailures = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const inactive = yield* acquireSendEndpoint(operations);
        expect(yield* inactive.send(sendInput).pipe(Effect.flip)).toMatchObject(
          {
            reason: "network-unavailable",
          },
        );
        const fixture = yield* makeFixture;
        const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
        const readStatus: HarnessMcpOperations["readStatus"] = () =>
          Effect.succeed({ kind: "active", agentCard });
        const refused = yield* acquireSendEndpoint({
          ...operations,
          readStatus,
          send: () => Effect.fail(new SendError({ reason: "not-registered" })),
        });
        expect(yield* refused.send(sendInput).pipe(Effect.flip)).toMatchObject({
          reason: "not-registered",
        });
        const invalidOutput = yield* acquireSendEndpoint({
          ...operations,
          readStatus,
          send: () =>
            Effect.succeed({
              operationId: Schema.decodeUnknownSync(CollectiveId)(
                `col_${"A".repeat(43)}`,
              ),
              unexpected: true,
            }),
        });
        expect(
          yield* invalidOutput.send(sendInput).pipe(Effect.flip),
        ).toMatchObject({
          reason: "network-unavailable",
        });
      }),
    ),
  );

function acquireSendEndpoint(
  selected: Pick<HarnessMcpOperations, "readStatus" | "send" | "readSend">,
) {
  return Effect.gen(function* () {
    const { port } = yield* acquireBoundaryServer({
      ...operations,
      ...selected,
    });
    return yield* acquireHarnessEndpoint(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
  });
}

function observeInvocations(directory: string) {
  return Effect.gen(function* () {
    const store = yield* openEndpointStore(directory);
    const scope = yield* Scope.Scope;
    const started = yield* Deferred.make<undefined>();
    const retried = yield* Deferred.make<undefined>();
    const complete = yield* Deferred.make<undefined>();
    const executed: HarnessSendRequest[] = [];
    let attempts = 0;
    const invocations = yield* makeSendInvocations(
      store,
      (input) =>
        Effect.sync(() => {
          executed.push(input);
        }).pipe(
          Effect.zipRight(Deferred.succeed(started, undefined)),
          Effect.zipRight(Deferred.await(complete)),
          Effect.as(sendResult),
        ),
      scope,
    );
    const send: HarnessMcpOperations["send"] = (input) =>
      Effect.sync(() => {
        attempts += 1;
      }).pipe(
        Effect.zipRight(
          Effect.suspend(() =>
            attempts > 1 ? Deferred.succeed(retried, undefined) : Effect.void,
          ),
        ),
        Effect.zipRight(invocations.send(input)),
      );
    return {
      started,
      retried,
      complete,
      executed,
      send,
      readSend: invocations.readSend,
    };
  });
}

const runtimeOptions = {
  idempotencyKey: "runtime-call",
  failureDelivery: "inbound",
} as const;

function checksSendConflicts(endpoint: HarnessEndpoint) {
  return Effect.gen(function* () {
    for (const idempotencyKey of ["", "bad\u0000key", "é".repeat(65)]) {
      expect(
        yield* endpoint.send(sendInput, { idempotencyKey }).pipe(Effect.flip),
      ).toMatchObject({ reason: "content-invalid" });
    }
    expect(
      yield* endpoint
        .send(sendInput, { ...runtimeOptions, failureDelivery: "result" })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "idempotency-conflict" });
    expect(
      yield* endpoint
        .send({ ...sendInput, text: "changed" }, runtimeOptions)
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "idempotency-conflict" });
    yield* endpoint.send(sendInput, { idempotencyKey: "intentional-repeat" });
    yield* endpoint.send(sendInput);
  });
}

function checksRuntimeRetries(
  directory: string,
  readStatus: HarnessMcpOperations["readStatus"],
) {
  return Effect.gen(function* () {
    const observed = yield* observeInvocations(directory);
    const endpoint = yield* acquireSendEndpoint({ ...observed, readStatus });
    const hostOptions = { ...runtimeOptions, hostContext: "stays in the host" };
    const lost = yield* endpoint
      .send(sendInput, hostOptions)
      .pipe(Effect.forkScoped);
    yield* Deferred.await(observed.started);
    const retry = yield* endpoint
      .send(sendInput, runtimeOptions)
      .pipe(Effect.forkScoped);
    yield* Deferred.await(observed.retried);
    yield* Fiber.interrupt(lost);
    yield* Deferred.succeed(observed.complete, undefined);
    expect(yield* Fiber.join(retry)).toEqual(sendResult);
    expect(observed.executed).toEqual([
      { input: sendInput, ...runtimeOptions },
    ]);
    yield* checksSendConflicts(endpoint);
    expect(observed.executed).toEqual([
      { input: sendInput, ...runtimeOptions },
      { input: sendInput, idempotencyKey: "intentional-repeat" },
      { input: sendInput },
    ]);
  });
}

function checksRetainedRuntimeSend(
  directory: string,
  readStatus: HarnessMcpOperations["readStatus"],
) {
  return Effect.gen(function* () {
    const store = yield* openEndpointStore(directory);
    const scope = yield* Scope.Scope;
    const invocations = yield* makeSendInvocations(
      store,
      () => unusedOperation,
      scope,
    );
    const endpoint = yield* acquireSendEndpoint({ ...invocations, readStatus });
    expect(yield* endpoint.send(sendInput, runtimeOptions)).toEqual(sendResult);
  });
}

/** The real SDK and overridden dispatcher must preserve options before durable reservation. */
function preservesRuntimeInvocationMetadata() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const fixture = yield* makeFixture;
        const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
        const readStatus: HarnessMcpOperations["readStatus"] = () =>
          Effect.succeed({ kind: "active", agentCard });
        yield* Effect.scoped(checksRuntimeRetries(directory, readStatus));
        yield* Effect.scoped(checksRetainedRuntimeSend(directory, readStatus));
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

const invalidSendCalls = [
  { arguments: { input: sendInput, idempotencyKey: "model-key" } },
  { arguments: { input: sendInput, failureDelivery: "inbound" } },
  {
    arguments: { input: sendInput, idempotencyKey: "model-key" },
    _meta: {
      [HARNESS_SEND_META_KEY]: { idempotencyKey: "runtime-key" },
    },
  },
  ...[
    null,
    [],
    "key",
    { idempotencyKey: "" },
    { idempotencyKey: "x\u0000y" },
    { idempotencyKey: "é".repeat(65) },
    { failureDelivery: "other" },
    { unexpected: true },
  ].map((metadata) => ({
    arguments: { input: sendInput },
    _meta: { [HARNESS_SEND_META_KEY]: metadata },
  })),
];

const checksSemanticSendSchema = (client: Client) =>
  Effect.tryPromise(async () => {
    const catalog = await client.listTools();
    const schema = catalog.tools.find(
      (tool) => tool.name === "send_message",
    )?.inputSchema;
    if (schema === undefined) {
      throw new Error("Expected the semantic send schema");
    }
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual(["input"]);
    const validator = fromJsonSchema(
      // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The real server emits JSONSchema.make output; the SDK catalog type widens its nested properties to JSON values.
      schema as JsonSchemaType,
    );
    for (const input of [
      {
        to: "group:alice,bob,carol",
        text: "Ready?",
        collective: {
          op: "gather",
          deadline: 600,
          requestedSchema: {
            type: "object",
            properties: { ready: { type: "boolean", default: false } },
            required: ["ready"],
          },
        },
      },
      {
        to: "agent:bob",
        collectiveResponse: { action: "accept", content: { ready: true } },
      },
    ]) {
      expect(await validator["~standard"].validate({ input })).toHaveProperty(
        "value",
      );
    }
  });

/** Model arguments and malformed metadata must fail before any send reaches execution. */
function rejectsSendBookkeepingArguments() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
        const executed: unknown[] = [];
        const { port } = yield* acquireBoundaryServer({
          ...operations,
          readStatus: () => Effect.succeed({ kind: "active", agentCard }),
          send: (input) =>
            Effect.sync(() => {
              executed.push(input);
              return sendResult;
            }),
        });
        const client = yield* acquireProtocolClient(
          port,
          "semantic-send-client",
        );
        yield* checksSemanticSendSchema(client);
        for (const call of invalidSendCalls) {
          const error = yield* Effect.tryPromise(() =>
            client.callTool({ name: "send_message", ...call }),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({
            cause: { code: ProtocolErrorCode.InvalidParams },
          });
        }
        expect(executed).toEqual([]);
        yield* Effect.tryPromise(() =>
          client.callTool({
            name: "send_message",
            arguments: { input: sendInput },
            _meta: {
              "another.example/trace": { id: "independent" },
              [HARNESS_SEND_META_KEY]: { idempotencyKey: "é".repeat(64) },
            },
          }),
        );
        expect(executed).toEqual([
          { input: sendInput, idempotencyKey: "é".repeat(64) },
        ]);
      }),
    ),
  );
}

function readsRetainedEventThroughSdk() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* openEndpointStore(
          yield* fs.makeTempDirectoryScoped(),
        );
        const fixture = yield* makeFixture;
        const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
        const deliveryToken = Schema.decodeUnknownSync(DeliveryToken)(
          `dlv_${Buffer.alloc(32, 7).toString("base64url")}`,
        );
        const item = Schema.decodeUnknownSync(InboundItem)({
          kind: "operationFailed",
          id: `col_${Buffer.alloc(32, 7).toString("base64url")}`,
          to: "agent:bob",
          error: "retained result",
        });
        const canonicalItem = yield* encodeRuntimeValue(item);
        yield* store.putInboxItem({ deliveryToken, canonicalItem });
        yield* store.acknowledgeInboxItem(deliveryToken);
        const { port } = yield* acquireBoundaryServer({
          ...operations,
          readStatus: () => Effect.succeed({ kind: "active", agentCard }),
          readEvent: ({ eventId }) => readRuntimeEvent(store, eventId),
        });
        const client = yield* acquireProtocolClient(
          port,
          "retained-event-client",
        );
        const result = yield* Effect.tryPromise(() =>
          client.callTool({
            name: "read_event",
            arguments: { eventId: eventIdOf(deliveryToken) },
          }),
        );
        expect(result.structuredContent).toEqual({ item });
        expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

// @agent-code-guard/regression-only: this boundary pins the exact capability and closed transport failures.
describe("Harness MCP HTTP boundary", () => {
  it(
    "keeps dispatch and invalid output distinct from rejected send input",
    distinguishesSendValidationFailures,
  );
  it(
    "reads an acknowledged event through the SDK without redelivery",
    readsRetainedEventThroughSdk,
  );
  it(
    "preserves runtime send identity through retries, conflicts and restart",
    preservesRuntimeInvocationMetadata,
  );
  it(
    "rejects bookkeeping in model arguments and validates runtime metadata",
    rejectsSendBookkeepingArguments,
  );
  it("advertises the event descriptor before registration", () =>
    advertisesEventsBeforeRegistration());
  it("keeps malformed input separate from closed domain failures", () =>
    distinguishesProtocolAndDomainFailures());
  it("sanitizes unexpected operation defects", () =>
    sanitizesUnexpectedOperationDefects());
  it("keeps an idle subscription alive past the fetch body timeout", () =>
    keepsIdleSubscriptionAlive());
  it("loses an idle subscription to the fetch body timeout without keep-alive", () =>
    losesIdleSubscriptionWithoutKeepAlive());
  it("reports an unexpected subscription disconnect", () =>
    reportsUnexpectedSubscriptionLoss());
});

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the MCP boundary. */
