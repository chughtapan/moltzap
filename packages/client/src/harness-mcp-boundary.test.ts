/** @file Pins the official MCP capability document through loopback HTTP. */

import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  type Implementation,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Ed25519PublicKey } from "@moltzap/identity";
import { Duration, Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { acquireHarnessClient } from "./client-runtime.js";
import { ListenError } from "./contract.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-http.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./harness-mcp-wire.js";
import { HARNESS_EVENTS_EXTENSION } from "./harness-runtime.js";

/* eslint-disable agent-code-guard/async-keyword -- These interoperability tests exercise the Promise-native MCP boundary. */

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const OK_STATUS = 200;
const IMPLEMENTATION = {
  name: "harness-boundary-test",
  version: "1.0.0",
} satisfies Implementation;
const PUBLIC_KEY_REPRESENTATION = {
  crv: "Ed25519",
  kty: "OKP",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
} as const;
const PRIVATE_STATUS_DEFECT = "private status defect";
const REGISTRY_SIGNER_PUBLIC_KEY = Schema.decodeUnknownSync(Ed25519PublicKey)(
  PUBLIC_KEY_REPRESENTATION,
);

const discoverResponseSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Literal("discover"),
  result: Schema.Struct({
    capabilities: Schema.Struct({
      extensions: Schema.Struct({
        [HARNESS_EVENTS_EXTENSION]: Schema.Struct({
          registrySignerPublicKey: Schema.encodedSchema(Ed25519PublicKey),
        }),
      }),
    }),
  }),
});

const unusedOperation = Effect.dieMessage("operation is outside this test");
const operations: HarnessMcpOperations = {
  readStatus: () => Effect.succeed({ kind: "unregistered" }),
  register: () => unusedOperation,
  searchAgents: () => unusedOperation,
  searchConversations: () => unusedOperation,
  readConversation: () => unusedOperation,
  start: () => unusedOperation,
  reply: () => unusedOperation,
};

const acquireBoundaryServer = (selectedOperations: HarnessMcpOperations) =>
  Effect.gen(function* () {
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: IMPLEMENTATION,
      operations: selectedOperations,
      registrySignerPublicKey: REGISTRY_SIGNER_PUBLIC_KEY,
    });
    const server = yield* acquireHarnessMcpHttpServer({ port: 0, handler });
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    return { port, server } as const;
  });

const acquireProtocolClient = (port: number, name: string) =>
  Effect.acquireRelease(
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

const discoverRequest = (port: number): Request =>
  new Request(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "discover",
      method: "server/discover",
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: IMPLEMENTATION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });

const servesEncodedSigner = async () => {
  const decoded = await Effect.runPromise(
    Effect.gen(function* () {
      const { port } = yield* acquireBoundaryServer(operations);
      const response = yield* Effect.tryPromise(() =>
        // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The loopback test drives the same Web Request boundary accepted by the official MCP handler.
        fetch(discoverRequest(port)),
      );
      expect(response.status).toBe(OK_STATUS);
      const body = yield* Effect.tryPromise(() => response.json());
      return yield* Schema.decodeUnknown(discoverResponseSchema)(body);
    }).pipe(Effect.scoped),
  );

  expect(
    decoded.result.capabilities.extensions[HARNESS_EVENTS_EXTENSION]
      .registrySignerPublicKey,
  ).toEqual(PUBLIC_KEY_REPRESENTATION);
};

const capturesProtocolError = (
  client: Client,
  toolArguments: Readonly<Record<string, unknown>>,
) =>
  Effect.tryPromise({
    try: (signal) =>
      client.callTool({ name: "status", arguments: toolArguments }, { signal }),
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onFailure: (cause) => cause,
      onSuccess: () => new Error("status unexpectedly succeeded"),
    }),
  );

const distinguishesProtocolAndDomainFailures = async () => {
  let statusReads = 0;
  const failingOperations: HarnessMcpOperations = {
    ...operations,
    readStatus: () => {
      statusReads += 1;
      return statusReads === 1
        ? Effect.succeed({ kind: "unregistered" as const })
        : Effect.fail({ reason: "persistence" as const });
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
        ] as const,
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
    data: { reason: "persistence" },
  });
  expect(statusReads).toBe(2);
};

const sanitizesUnexpectedOperationDefects = async () => {
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
    data: { reason: "persistence" },
  });
  expect(String(cause)).not.toContain(PRIVATE_STATUS_DEFECT);
};

const reportsUnexpectedSubscriptionLoss = async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { port, server } = yield* acquireBoundaryServer(operations);
      const client = yield* acquireHarnessClient(
        new URL(`http://127.0.0.1:${port}/mcp`),
      );
      yield* Effect.sync(() => {
        server.closeAllConnections();
      });
      return yield* client.turns.pipe(
        Stream.runHead,
        Effect.match({
          onFailure: (cause) => cause,
          onSuccess: () => new Error("turn stream ended without a failure"),
        }),
        Effect.timeoutFail({
          duration: Duration.seconds(5),
          onTimeout: () => new Error("turn stream did not observe disconnect"),
        }),
      );
    }).pipe(Effect.scoped),
  );

  expect(result).toBeInstanceOf(ListenError);
  expect(result).toMatchObject({ reason: "connection" });
};

// @agent-code-guard/regression-only: this boundary example pins the branded-key encoding seam and the sole loopback listener.
describe("Harness MCP HTTP boundary", () => {
  it("serves the encoded Registry signer in discovery", servesEncodedSigner);
  it(
    "keeps malformed input separate from closed domain failures",
    distinguishesProtocolAndDomainFailures,
  );
  it(
    "sanitizes unexpected operation defects",
    sanitizesUnexpectedOperationDefects,
  );
  it(
    "reports an unexpected subscription disconnect",
    reportsUnexpectedSubscriptionLoss,
  );
});

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the MCP boundary. */
