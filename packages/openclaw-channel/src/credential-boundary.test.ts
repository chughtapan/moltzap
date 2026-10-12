/** @file Exact credential bytes are checked before the public Client's real HTTP boundary. */

import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/channel-contract";
import { scopedLive as it } from "@effect/vitest";
import {
  Data,
  Deferred,
  Effect,
  Either,
  FastCheck as fc,
  Schema,
} from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Protected credential files are native OpenClaw startup inputs; this fixture creates that same filesystem boundary, without adding a filesystem service to the adapter.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- A hermetic external MCP protocol listener exercises the public Client's real HTTP transport; it is not production adapter networking or a private Client dependency.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { createMoltzapChannelPlugin } from "./plugin.js";

const GRANT = "openclaw-boundary-runtime-credential-000001";
const CREDENTIAL_ERROR = "must contain exactly one bearer token";
const consumerMetadata = {
  "xyz.moltzap/consumer": {
    generation: "00000000-0000-4000-8000-000000000001",
  },
};
const requestSchema = Schema.parseJson(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Union(Schema.String, Schema.Number),
    method: Schema.String,
  }),
);
const protocolResults = {
  "server/discover": {
    supportedVersions: ["2026-07-28"],
    capabilities: {},
    ttlMs: 0,
    cacheScope: "private",
  },
  "events/list": {
    events: [{ name: "moltzap.inbox.item", delivery: ["poll"] }],
  },
  "events/poll": {
    events: [],
    cursor: "fixture-cursor",
    truncated: false,
    hasMore: false,
    nextPollMs: 1000,
    _meta: consumerMetadata,
  },
  "tools/call": { content: [], structuredContent: { items: [] } },
};
const isProtocolMethod = Schema.is(
  Schema.Literal("server/discover", "events/list", "events/poll", "tools/call"),
);

class CredentialFixtureError extends Data.TaggedError(
  "CredentialFixtureError",
)<{
  readonly detail: string;
}> {}

describe("OpenClaw credential HTTP boundary", () => {
  it("connects the exact protected credential through the real public Client", () =>
    exerciseCredential(GRANT, true));
  it("rejects a newline-suffixed valid credential without an HTTP request", () =>
    exerciseCredential(`${GRANT}\n`, false));
  it("rejects a CRLF-suffixed valid credential without an HTTP request", () =>
    exerciseCredential(`${GRANT}\r\n`, false));
  it("rejects a UTF-8 BOM without an HTTP request", () =>
    exerciseCredential(`\uFEFF${GRANT}`, false));
  it("rejects invalid UTF-8 without an HTTP request", () =>
    exerciseCredential(
      new Uint8Array([...new TextEncoder().encode(GRANT), 0xff]),
      false,
    ));
  it.prop(
    "never normalizes generated credential whitespace into an authenticated connection",
    [fc.constantFrom("\n", "\r\n", " ", "\t", "\uFEFF"), fc.boolean()],
    ([whitespace, prefix]) =>
      exerciseCredential(
        prefix ? `${whitespace}${GRANT}` : `${GRANT}${whitespace}`,
        false,
      ),
    { fastCheck: { numRuns: 8 } },
  );
});

function exerciseCredential(
  value: string | Uint8Array,
  shouldConnect: boolean,
) {
  return Effect.gen(function* () {
    const directory = yield* temporaryDirectory();
    const file = join(directory, "runtime.txt");
    yield* Effect.tryPromise(() => writeFile(file, value, { mode: 0o400 }));
    const fixture = yield* httpFixture();
    vi.stubEnv("MOLTZAP_MCP_URL", fixture.endpoint.href);
    vi.stubEnv("MOLTZAP_MCP_CREDENTIAL_FILE", file);
    const outcome = yield* observeConnection();
    if (shouldConnect) {
      expect(outcome.result).toEqual(Either.right(undefined));
      expect(fixture.authorization).toContain(`Bearer ${GRANT}`);
      expect(
        fixture.authorization.every((header) => header === `Bearer ${GRANT}`),
      ).toBe(true);
    } else {
      Either.match(outcome.result, {
        onLeft: (failure) => {
          expect(failure.detail).toContain(CREDENTIAL_ERROR);
          expect(failure.detail).not.toContain(file);
          expect(failure.detail).not.toContain(GRANT);
        },
        onRight: () => {
          expect.fail("a malformed credential reached the native connection");
        },
      });
      expect(fixture.authorization).toEqual([]);
    }
    expect(outcome.connected).toBe(shouldConnect);
  }).pipe(Effect.scoped);
}

/** Abort as soon as the native connection is reported, so the fixture never enters a host turn. */
function observeConnection() {
  return Effect.gen(function* () {
    const connected = yield* Deferred.make<undefined>();
    const controller = new AbortController();
    const start = createMoltzapChannelPlugin().gateway?.startAccount;
    if (start === undefined) {
      return yield* Effect.dieMessage("native gateway start missing");
    }
    const result = yield* Effect.tryPromise({
      try: () => start(gatewayContext(controller, connected)),
      catch: (cause) =>
        new CredentialFixtureError({
          detail:
            cause instanceof Error ? cause.message : "non-error native failure",
        }),
    }).pipe(
      Effect.either,
      Effect.ensuring(
        Effect.sync(() => {
          controller.abort();
        }),
      ),
    );
    return { connected: yield* Deferred.isDone(connected), result };
  });
}

function gatewayContext(
  controller: AbortController,
  connected: Deferred.Deferred<undefined>,
): ChannelGatewayContext<{ readonly id: string }> {
  let snapshot: ChannelAccountSnapshot = { accountId: "primary" };
  const unused = (): never => {
    throw new Error("the credential fixture cannot enter the native turn");
  };
  return {
    cfg: {},
    accountId: "primary",
    account: { id: "primary" },
    abortSignal: controller.signal,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    channelRuntime: {
      runtimeContexts: {
        register: () => ({ dispose: () => undefined }),
        get: () => undefined,
        watch: () => () => undefined,
      },
      inbound: { buildContext: unused, run: unused },
      routing: { resolveAgentRoute: unused },
    },
    getStatus: () => snapshot,
    setStatus: (next) => {
      snapshot = next;
      if (next.connected === true) {
        Deferred.unsafeDone(connected, Effect.succeed(undefined));
        controller.abort();
      }
    },
  };
}

/** Node HTTP supplies the external MCP protocol fixture; the adapter still imports only public Client. */
function httpFixture() {
  const authorization: string[] = [];
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization ?? "");
    if (request.headers.authorization !== `Bearer ${GRANT}`) {
      response.writeHead(401).end();
      return;
    }
    readRequest(request, response);
  });
  return Effect.acquireRelease(listen(server), () =>
    Effect.async<undefined>((resume) => {
      server.close(() => {
        resume(Effect.succeed(undefined));
      });
      server.closeAllConnections();
    }),
  ).pipe(
    Effect.map(() => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new CredentialFixtureError({
          detail: "fixture TCP address missing",
        });
      }
      return {
        authorization,
        endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
      };
    }),
  );
}

function listen(server: Server) {
  return Effect.async<Server, CredentialFixtureError>((resume) => {
    const onError = () => {
      resume(
        Effect.fail(
          new CredentialFixtureError({ detail: "fixture listen failed" }),
        ),
      );
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });
}

function readRequest(request: IncomingMessage, response: ServerResponse) {
  request.setEncoding("utf8");
  let body = "";
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    Either.match(Schema.decodeUnknownEither(requestSchema)(body), {
      onLeft: () => response.writeHead(400).end(),
      onRight: (rpc) => {
        respond(response, rpc.id, rpc.method);
      },
    });
  });
}

function respond(
  response: ServerResponse,
  id: string | number,
  method: string,
) {
  response.setHeader("content-type", "application/json");
  const payload = isProtocolMethod(method)
    ? { result: { resultType: "complete", ...protocolResults[method] } }
    : { error: { code: -32601, message: "fixture method not found" } };
  response.end(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
}

function temporaryDirectory() {
  return Effect.acquireRelease(
    Effect.tryPromise(() =>
      mkdtemp(join(tmpdir(), "moltzap-openclaw-boundary-")),
    ),
    (directory) =>
      Effect.tryPromise(() =>
        rm(directory, { recursive: true, force: true }),
      ).pipe(Effect.ignore),
  );
}
