/** @file Pins events-v2 discovery and failure isolation through loopback HTTP. */

import type { Implementation } from "@modelcontextprotocol/server";
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Deferred, Duration, Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { acquireHarnessEndpoint } from "./client-runtime.js";
import { ListenError } from "./contract.js";
import { HARNESS_EVENTS_EXTENSION } from "./harness-mcp-contract.js";
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
) {
  return Effect.gen(function* () {
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: IMPLEMENTATION,
      operations: selectedOperations,
      ...(onSubscriptionActiveChange === undefined
        ? {}
        : { onSubscriptionActiveChange }),
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
          capabilities: {
            experimental: { [HARNESS_EVENTS_EXTENSION]: {} },
          },
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

async function advertisesExactEventsExtension() {
  const capabilities = await Effect.runPromise(
    Effect.gen(function* () {
      const { port } = yield* acquireBoundaryServer(operations);
      const client = yield* acquireProtocolClient(
        port,
        "harness-capability-client",
      );
      return client.getServerCapabilities();
    }).pipe(Effect.scoped),
  );

  expect(capabilities?.experimental).toEqual({
    [HARNESS_EVENTS_EXTENSION]: {},
  });
}

async function distinguishesProtocolAndDomainFailures() {
  let statusReads = 0;
  const failingOperations: HarnessMcpOperations = {
    ...operations,
    readStatus: () => {
      statusReads += 1;
      return statusReads === 1
        ? Effect.succeed({ kind: "unregistered" as const })
        : Effect.fail({ reason: "persistence-failed" as const });
    },
  };
  const [malformedCause, domainCause] = await Effect.runPromise(
    Effect.gen(function* () {
      const { port } = yield* acquireBoundaryServer(failingOperations);
      const client = yield* acquireProtocolClient(
        port,
        "harness-boundary-client",
      );
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
  expect(statusReads).toBe(2);
}

async function sanitizesUnexpectedOperationDefects() {
  let statusReads = 0;
  const defectiveOperations: HarnessMcpOperations = {
    ...operations,
    readStatus: () => {
      statusReads += 1;
      return statusReads === 1
        ? Effect.succeed({ kind: "unregistered" as const })
        : Effect.dieMessage(PRIVATE_STATUS_DEFECT);
    },
  };
  const cause = await Effect.runPromise(
    Effect.gen(function* () {
      const { port } = yield* acquireBoundaryServer(defectiveOperations);
      const client = yield* acquireProtocolClient(
        port,
        "harness-defect-client",
      );
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
      const subscriptionActive = yield* Deferred.make<undefined>();
      const { port, server } = yield* acquireBoundaryServer(
        operations,
        (active) => {
          if (active) {
            Effect.runSync(Deferred.succeed(subscriptionActive, undefined));
          }
        },
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

// @agent-code-guard/regression-only: this boundary pins the exact capability and closed transport failures.
describe("Harness MCP HTTP boundary", () => {
  it("advertises the exact empty events-v2 capability", () =>
    advertisesExactEventsExtension());
  it("keeps malformed input separate from closed domain failures", () =>
    distinguishesProtocolAndDomainFailures());
  it("sanitizes unexpected operation defects", () =>
    sanitizesUnexpectedOperationDefects());
  it("reports an unexpected subscription disconnect", () =>
    reportsUnexpectedSubscriptionLoss());
});

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the MCP boundary. */
