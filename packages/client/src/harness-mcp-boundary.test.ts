/** @file Pins Events discovery and failure isolation through loopback HTTP. */

import type { Implementation } from "@modelcontextprotocol/server";
import {
  Client,
  fromJsonSchema,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { AgentCard } from "@moltzap/identity";
import { Deferred, Duration, Effect, Fiber, Schema, Stream } from "effect";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { makeFixture } from "./__tests__/router-worker-fixtures.js";
import { acquireHarnessEndpoint } from "./client-runtime/index.js";
import { ListenError } from "./contract.js";
import { INBOX_PENDING_EVENT } from "./harness-mcp-contract.js";
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

// @agent-code-guard/regression-only: this boundary pins the exact capability and closed transport failures.
describe("Harness MCP HTTP boundary", () => {
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
