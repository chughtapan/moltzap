/** @file A real daemon combines private bootstrap and authenticated native delivery without an owner bearer. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Chunk, Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { join } from "node:path";
import { Agent, fetch } from "undici";
import { expect, it } from "vitest";
import {
  acquireHarnessEndpoint,
  AgentAddress,
  type HarnessEndpoint,
  type HarnessEndpointOptions,
} from "../src/index.js";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  stopProcess,
} from "./daemon-process-harness.js";

const credential = Redacted.make("authenticated-process-runtime-000001");
const registeredResult = Schema.parseJson(
  Schema.Struct({
    result: Schema.Struct({
      structuredContent: Schema.Struct({ kind: Schema.Literal("registered") }),
    }),
  }),
);
const unreadResult = Schema.parseJson(
  Schema.Struct({
    result: Schema.Struct({
      structuredContent: Schema.Struct({ items: Schema.Array(Schema.Unknown) }),
    }),
  }),
);

const configureRemoteFixture = (fixture: DaemonProcessFixture) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      directory: "/tmp",
      prefix: "moltzap-auth-",
    });
    const managementDirectory = join(directory, "management");
    const socket = join(managementDirectory, "mcp.sock");
    const runtimeFile = join(directory, "runtime.txt");
    yield* fileSystem.makeDirectory(managementDirectory, { mode: 0o700 });
    yield* fileSystem.writeFileString(runtimeFile, Redacted.value(credential), {
      mode: 0o400,
    });
    return {
      socket,
      fixture: {
        ...fixture,
        environment: {
          ...fixture.environment,
          MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE: runtimeFile,
          MOLTZAPD_MCP_MANAGEMENT_SOCKET: socket,
        },
      } satisfies DaemonProcessFixture,
    };
  });

const acquireSocketAgent = (socket: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Agent({ connect: { socketPath: socket } })),
    (agent) => Effect.tryPromise(() => agent.close()).pipe(Effect.ignore),
  );

const managementCall = (
  fixture: DaemonProcessFixture,
  dispatcher: Agent,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
) =>
  Effect.tryPromise((signal) =>
    fetch(fixture.endpoint, {
      method: "POST",
      dispatcher,
      signal,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: arguments_,
          _meta: {
            [CLIENT_INFO_META_KEY]: {
              name: "authenticated-daemon-fixture",
              version: "1",
            },
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          },
        },
      }),
    }),
  ).pipe(
    Effect.flatMap((response) => Effect.tryPromise(() => response.text())),
  );

const registerPrivate = (fixture: DaemonProcessFixture, socket: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatcher = yield* acquireSocketAgent(socket);
      yield* managementCall(fixture, dispatcher, "register", {
        ...makeRegistrationRequest(fixture),
      }).pipe(Effect.flatMap(Schema.decodeUnknown(registeredResult)));
    }),
  );

const registerLocal = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(
        (yield* management.register(makeRegistrationRequest(fixture))).kind,
      ).toBe("registered");
    }),
  );

const receive = (endpoint: HarnessEndpoint) =>
  endpoint.messages.pipe(
    Stream.mapEffect((delivery) =>
      delivery.acknowledge.pipe(Effect.as(delivery.item)),
    ),
    Stream.take(1),
    Stream.runCollect,
  );

const exchange = (
  from: DaemonProcessFixture,
  to: DaemonProcessFixture,
  text: string,
  options: {
    readonly from?: HarnessEndpointOptions;
    readonly to?: HarnessEndpointOptions;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sender = yield* acquireHarnessEndpoint(from.endpoint, options.from);
      const receiver = yield* acquireHarnessEndpoint(to.endpoint, options.to);
      const inbound = yield* receive(receiver).pipe(Effect.forkScoped);
      yield* sender.send({
        to: Schema.decodeUnknownSync(AgentAddress)(`agent:${to.agentName}`),
        text,
      });
      expect(Chunk.toReadonlyArray(yield* Fiber.join(inbound))).toMatchObject([
        {
          kind: "multicast",
          message: {
            kind: "direct",
            sender: `agent:${from.agentName}`,
            content: [{ type: "text", text }],
          },
        },
      ]);
    }),
  );

const assertPrivateBoundary = (fixture: DaemonProcessFixture, socket: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    expect((yield* fileSystem.stat(socket)).mode & 0o7777).toBe(0o600);
    const refused = yield* acquireHarnessEndpoint(fixture.endpoint).pipe(
      Effect.flip,
    );
    expect(refused.reason).toBe("transport-failed");
    const dispatcher = yield* acquireSocketAgent(socket);
    const unread = yield* managementCall(
      fixture,
      dispatcher,
      "read_inbox",
      {},
    ).pipe(Effect.flatMap(Schema.decodeUnknown(unreadResult)));
    expect(unread.result.structuredContent.items).toEqual([]);
  });

const authenticatedProcessBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const peer = yield* makeDaemonProcessFixture(infrastructure, "remote-peer");
  const remote = yield* makeDaemonProcessFixture(
    infrastructure,
    "remote-native",
  ).pipe(Effect.flatMap(configureRemoteFixture));
  const running = yield* acquireDaemonProcess(remote.fixture);
  yield* acquireDaemonProcess(peer);
  yield* registerPrivate(remote.fixture, remote.socket);
  yield* registerLocal(peer);
  yield* exchange(peer, remote.fixture, "authenticated native receive", {
    to: { credential },
  });
  yield* assertPrivateBoundary(remote.fixture, remote.socket);
  yield* stopProcess(running);
  const fileSystem = yield* FileSystem.FileSystem;
  expect(yield* fileSystem.exists(remote.socket)).toBe(false);
  const restarted = yield* acquireDaemonProcess(remote.fixture);
  yield* exchange(remote.fixture, peer, "same-grant send after restart", {
    from: { credential },
  });
  yield* stopProcess(restarted);
  expect(yield* fileSystem.exists(remote.socket)).toBe(false);
}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

it("privately registers, exchanges over one runtime grant, and restarts without replacing credentials", () => {
  expect.hasAssertions();
  return Effect.runPromise(authenticatedProcessBehavior);
}, 180_000);
