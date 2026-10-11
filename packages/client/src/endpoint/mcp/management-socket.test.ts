/** @file Real HTTP and Unix-socket requests pin the daemon's private management boundary. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { AgentCard } from "@moltzap/identity";
import { Effect, Redacted, Schema } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- These tests inspect actual Unix socket modes and preserve exact pre-existing path fixtures.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Agent, fetch } from "undici";
import { describe, expect, it, onTestFinished } from "vitest";
import { makeFixture } from "../../__tests__/daemon-runtime-fixtures.js";
import { acquireHarnessMcpHttpServer } from "./http.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Protocol status, closed reasons and POSIX modes are the security contract under test. */

const implementation = { name: "management-socket-test", version: "1" };
const credentials = {
  runtime: Redacted.make("runtime-management-test-000000001"),
};
const unreadOperation = () => Effect.dieMessage("unrelated operation reached");
const operations: HarnessMcpOperations = {
  protocolActive: () => false,
  readStatus: () => Effect.succeed({ kind: "unregistered" }),
  register: unreadOperation,
  searchAgents: unreadOperation,
  searchConversations: unreadOperation,
  readConversation: unreadOperation,
  send: unreadOperation,
  readInbox: () => Effect.succeed({ items: [] }),
  readInboxSummary: () =>
    Effect.succeed({ pendingCount: 0, newestSequence: 0 }),
  readSend: () => Effect.succeed({ state: "absent" }),
  readEvent: unreadOperation,
  acknowledgeDelivery: unreadOperation,
};

/** A short, private path avoids the platform's Unix socket pathname limit. */
const socketPath = () => {
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp atomically creates a private 0700 directory; a short path is required by Unix sockets.
  const directory = mkdtempSync("/tmp/moltzap-management-");
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return join(directory, "mcp.sock");
};

const acquireHandler = (selected: HarnessMcpOperations = operations) =>
  Effect.gen(function* () {
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation,
      credentials,
      operations: selected,
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => handler.close()).pipe(Effect.ignore),
    );
    return handler;
  });

const acquireServer = (
  socket: string,
  selected: HarnessMcpOperations = operations,
) =>
  Effect.gen(function* () {
    const handler = yield* acquireHandler(selected);
    const server = yield* acquireHarnessMcpHttpServer({
      port: 0,
      handler,
      management: { socket, handler: handler.management },
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.dieMessage("expected a TCP address");
    }
    const socketAgent = yield* Effect.acquireRelease(
      Effect.sync(() => new Agent({ connect: { socketPath: socket } })),
      (agent) => Effect.tryPromise(() => agent.close()).pipe(Effect.ignore),
    );
    return { url: `http://127.0.0.1:${address.port}/mcp`, socketAgent };
  });

type RunningServer = Effect.Effect.Success<ReturnType<typeof acquireServer>>;

const request = (
  server: RunningServer,
  method: string,
  params: Readonly<Record<string, unknown>>,
  access: { readonly management?: boolean; readonly bearer?: string } = {},
) =>
  Effect.tryPromise(() =>
    // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Undici's explicit socketPath proves real MCP requests traverse the filesystem listener, not the TCP route.
    fetch(server.url, {
      method: "POST",
      ...(access.management === true ? { dispatcher: server.socketAgent } : {}),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": method,
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        ...(access.bearer === undefined
          ? {}
          : { authorization: `Bearer ${access.bearer}` }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [CLIENT_INFO_META_KEY]: implementation,
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          },
        },
      }),
    }),
  );

const json = Schema.decodeUnknown(Schema.parseJson(Schema.Unknown));
const body = (response: Awaited<ReturnType<typeof fetch>>) =>
  Effect.tryPromise(() => response.text()).pipe(Effect.flatMap(json));
const catalog = Schema.parseJson(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  }),
);
const catalogNames = (response: Awaited<ReturnType<typeof fetch>>) =>
  Effect.tryPromise(() => response.text()).pipe(
    Effect.flatMap(Schema.decodeUnknown(catalog)),
    Effect.map((value) =>
      value.result.tools
        .map((tool) => tool.name)
        .sort((left, right) => left.localeCompare(right)),
    ),
  );

const runtimeAccess = { bearer: Redacted.value(credentials.runtime) };
const ownerAccess = { management: true };

const verifyRuntimeCatalog = (server: RunningServer) =>
  Effect.gen(function* () {
    const after = yield* request(server, "tools/list", {}, runtimeAccess).pipe(
      Effect.flatMap(catalogNames),
    );
    expect(after).toEqual(["read_event", "search_agents", "send_message"]);
    const owner = yield* request(server, "tools/list", {}, ownerAccess).pipe(
      Effect.flatMap(catalogNames),
    );
    expect(owner).toContain("revoke_event_subscription");
    const denied = yield* request(
      server,
      "tools/call",
      { name: "status", arguments: {} },
      runtimeAccess,
    ).pipe(Effect.flatMap(body));
    expect(denied).toMatchObject({ error: { code: -32602 } });
    const unauthenticated = yield* request(server, "tools/list", {});
    yield* Effect.tryPromise(() => unauthenticated.text());
    expect(unauthenticated.status).toBe(401);
  });

const sharesRegistration = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
        let protocolActive = false;
        const selected: HarnessMcpOperations = {
          ...operations,
          protocolActive: () => protocolActive,
          register: () =>
            Effect.sync(() => {
              protocolActive = true;
              return { kind: "registered", agentCard };
            }),
        };
        const server = yield* acquireServer(socketPath(), selected);
        const before = yield* request(
          server,
          "tools/list",
          {},
          runtimeAccess,
        ).pipe(Effect.flatMap(catalogNames));
        expect(before).toEqual([]);
        const registered = yield* request(
          server,
          "tools/call",
          { name: "register", arguments: fixture.registerRequest },
          ownerAccess,
        ).pipe(Effect.flatMap(body));
        expect(registered).toMatchObject({
          result: { structuredContent: { kind: "registered", agentCard } },
        });
        yield* verifyRuntimeCatalog(server);
      }),
    ),
  );

const protectsAndReleases = () => {
  const socket = socketPath();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireServer(socket);
        expect(statSync(socket).mode & 0o7777).toBe(0o600);
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(existsSync(socket)).toBe(false);
        }),
      ),
    ),
  );
};

const rebindsAfterShutdown = () => {
  const socket = socketPath();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(acquireServer(socket));
      yield* Effect.scoped(acquireServer(socket));
      expect(existsSync(socket)).toBe(false);
    }),
  );
};

const refusesPublicParent = () => {
  const socket = socketPath();
  const directory = join(socket, "..");
  chmodSync(directory, 0o755);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* acquireServer(socket).pipe(Effect.flip);
        expect(error).toMatchObject({ reason: "permissions" });
        expect(statSync(directory).mode & 0o7777).toBe(0o755);
        expect(existsSync(socket)).toBe(false);
      }),
    ),
  );
};

const preservesExistingFile = () => {
  const socket = socketPath();
  writeFileSync(socket, "operator-owned", { mode: 0o600, flag: "wx" });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* acquireServer(socket).pipe(Effect.flip);
        expect(error).toMatchObject({ reason: "occupied" });
        expect(readFileSync(socket, "utf8")).toBe("operator-owned");
      }),
    ),
  );
};

const preservesLiveSocket = () => {
  const socket = socketPath();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* acquireServer(socket);
        const error = yield* Effect.scoped(acquireServer(socket)).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ reason: "occupied" });
        const status = yield* request(
          first,
          "tools/call",
          { name: "status", arguments: {} },
          ownerAccess,
        ).pipe(Effect.flatMap(body));
        expect(status).toMatchObject({
          result: { structuredContent: { kind: "unregistered" } },
        });
      }),
    ),
  );
};

const preservesReplacedPath = () => {
  const socket = socketPath();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* acquireServer(socket);
        renameSync(socket, `${socket}.retired`);
        writeFileSync(socket, "replacement-owned", { mode: 0o600, flag: "wx" });
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(readFileSync(socket, "utf8")).toBe("replacement-owned");
        }),
      ),
    ),
  );
};

// @agent-code-guard/regression-only: real transport, pathname custody and POSIX permissions require concrete process-boundary probes.
describe("private daemon management socket", () => {
  it(
    "does not unlink a replaced configured path when the old listener closes",
    preservesReplacedPath,
  );
  it(
    "registers the same Client instance while HTTP remains runtime-only",
    sharesRegistration,
  );
  it(
    "uses mode 0600 and releases its socket on scoped shutdown",
    protectsAndReleases,
  );
  it(
    "can bind the same configured path after clean shutdown",
    rebindsAfterShutdown,
  );
  it(
    "refuses a nonprivate parent without changing its permissions",
    refusesPublicParent,
  );
  it(
    "refuses an existing file without deleting or overwriting it",
    preservesExistingFile,
  );
  it("refuses a live socket without disrupting its owner", preservesLiveSocket);
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
