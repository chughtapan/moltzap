import { HttpClient } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { live as it } from "@effect/vitest";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- This integration test needs a passive TCP port blocker to force the package-private Node listener's real bind-failure path.
import { createServer, type Server as NodeHttpServer } from "node:http";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { expect } from "vitest";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { Message } from "@moltzap/protocol/message";
import { withTestServiceConfig } from "../../../config.test-utils.js";
import { reserveTestMcpPort } from "../../../test-utils/process/reserve-port.js";
import {
  acquireHarnessClient,
  type HarnessClientService,
  type HarnessTurn,
} from "../../../harness-client.js";
import { decodeHarnessStartConversationResult } from "../../../harness/index.js";
import { acquireMoltzapd } from "../../../moltzapd.js";
import * as H from "../../support/index.js";

const PROFILE_NAME = "moltzapd-integration";
const MCP_PATH = "/mcp";
const LOOPBACK_HOST = "127.0.0.1";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PEER_MESSAGE = "hello through the harness";
const HARNESS_REPLY = "reply through the harness";
const INITIAL_CONTENT = "start through the harness";
const healthSchema = Schema.Struct({ connections: Schema.Number });

type RegisteredAgent = Effect.Effect.Success<
  ReturnType<typeof H.registerAgent>
>;
type MoltzapdServer = Effect.Effect.Success<ReturnType<typeof acquireMoltzapd>>;

interface RoundTripFixture {
  readonly harness: HarnessClientService;
  readonly mcp: Client;
  readonly owner: RegisteredAgent;
  readonly peer: RegisteredAgent;
  readonly conversationId: ConversationId;
}

interface PortBlocker {
  readonly port: number;
  readonly server: NodeHttpServer;
}

class PortBlockerError extends Data.TaggedError("PortBlockerError")<{
  readonly cause: unknown;
}> {}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const healthConnections = (): Effect.Effect<number, unknown> =>
  HttpClient.get(new URL("/health", H.coreBaseUrl())).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknown(healthSchema)),
    Effect.map((health) => health.connections),
    Effect.provide(NodeHttpClient.layer),
  );

const waitForConnectionCount = (
  expected: number,
): Effect.Effect<void, unknown> => {
  const poll: Effect.Effect<void, unknown> = Effect.suspend(() =>
    healthConnections().pipe(
      Effect.flatMap((actual) =>
        actual === expected
          ? Effect.void
          : Effect.sleep("10 millis").pipe(Effect.zipRight(poll)),
      ),
    ),
  );
  return poll.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(H.NOTIFICATION_WAIT_MS),
      onTimeout: () =>
        new Error(`timeout waiting for ${expected} server connections`),
    }),
  );
};

const listenPortBlocker = (
  port: number,
): Effect.Effect<PortBlocker, PortBlockerError> =>
  Effect.async<PortBlocker, PortBlockerError>((resume) => {
    const server = createServer();
    const onError = (error: Error): void => {
      resume(Effect.fail(new PortBlockerError({ cause: error })));
    };
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        resume(
          Effect.fail(
            new PortBlockerError({
              cause: new Error("expected a TCP blocker address"),
            }),
          ),
        );
        return;
      }
      resume(Effect.succeed({ port: address.port, server }));
    });
    return Effect.sync(() => {
      server.off("error", onError);
      if (server.listening) {
        server.close();
      }
    });
  });

const closePortBlocker = (blocker: PortBlocker): Effect.Effect<void, Error> =>
  Effect.async((resume) => {
    if (!blocker.server.listening) {
      resume(Effect.void);
      return;
    }
    blocker.server.close((error) => {
      resume(error === undefined ? Effect.void : Effect.fail(error));
    });
  });

const acquirePortBlocker = (
  port: number,
): Effect.Effect<PortBlocker, PortBlockerError, Scope.Scope> =>
  Effect.acquireRelease(listenPortBlocker(port), (blocker) =>
    closePortBlocker(blocker).pipe(Effect.ignore),
  );

const harnessUrl = (server: MoltzapdServer): URL => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP moltzapd address");
  }
  return new URL(MCP_PATH, `http://${LOOPBACK_HOST}:${address.port}`);
};

const acquireMcpClient = (
  url: URL,
): Effect.Effect<Client, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const client = new Client(
        { name: "moltzapd-integration", version: "1.0.0" },
        {
          versionNegotiation: {
            mode: { pin: MODERN_PROTOCOL_VERSION },
          },
        },
      );
      yield* Effect.tryPromise({
        try: () => client.connect(new StreamableHTTPClientTransport(url)),
        catch: toError,
      });
      return client;
    }),
    (client) =>
      Effect.tryPromise({ try: () => client.close(), catch: toError }).pipe(
        Effect.ignore,
      ),
  );

const callMcpTool = (
  client: Client,
  name: string,
  input: Record<string, unknown>,
) =>
  Effect.tryPromise({
    try: () => client.callTool({ name, arguments: input }),
    catch: toError,
  });

const runScopedDaemon = () =>
  Effect.gen(function* () {
    const server = yield* acquireMoltzapd({ profileName: PROFILE_NAME });
    const client = yield* acquireMcpClient(harnessUrl(server));
    const result = yield* Effect.tryPromise({
      try: () => client.callTool({ name: "status", arguments: {} }),
      catch: toError,
    });
    expect(server.listening).toBe(true);
    expect(yield* healthConnections()).toBe(1);
    return { result, server };
  });

function runRegisteredAgent(registered: RegisteredAgent) {
  return Effect.gen(function* () {
    const running = yield* Effect.scoped(runScopedDaemon());

    expect(running.result.structuredContent).toEqual({
      agentId: registered.agentId,
      connected: true,
      conversations: 0,
    });
    expect(running.server.listening).toBe(false);
    yield* waitForConnectionCount(0);
  }).pipe(Effect.provide(NodeContext.layer));
}

const takeHead = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  label: string,
): Effect.Effect<A, E | Error, R> =>
  stream.pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(H.NOTIFICATION_WAIT_MS),
      onTimeout: () => new Error(`timeout waiting for ${label}`),
    }),
    Effect.map((head) =>
      Option.getOrThrowWith(
        head,
        () => new Error(`${label} stream closed before delivery`),
      ),
    ),
  );

const expectHarnessTurn = (
  turn: HarnessTurn,
  owner: RegisteredAgent,
  peer: RegisteredAgent,
  conversationId: ConversationId,
): void => {
  expect(turn.conversationId).toBe(conversationId);
  expect(turn.sender).toEqual({ id: peer.agentId, name: peer.name });
  expect(turn.text).toBe(PEER_MESSAGE);
  expect(turn.isFromMe).toBe(false);
  expect(turn.conversationMeta?.type).toBe("dm");
  expect(new Set(turn.conversationMeta?.participants)).toEqual(
    new Set([`agent:${peer.agentId}`, `agent:${owner.agentId}`]),
  );
  expect(turn).not.toHaveProperty("messages");
};

const expectPeerReply = (
  reply: Message,
  owner: RegisteredAgent,
  conversationId: ConversationId,
): void => {
  expect(reply.conversationId).toBe(conversationId);
  expect(reply.senderId).toBe(owner.agentId);
  expect(H.textContent(reply)).toBe(HARNESS_REPLY);
};

const waitForPeerReply = (
  peer: RegisteredAgent,
  owner: RegisteredAgent,
  conversationId: ConversationId,
) =>
  takeHead(
    peer.client
      .subscribe(H.messageReceivedNotificationDefinition)
      .pipe(
        Stream.filter(
          ({ message }) =>
            message.senderId === owner.agentId &&
            message.conversationId === conversationId,
        ),
      ),
    "harness reply",
  ).pipe(Effect.map(({ message }) => message));

const expectReadConversationResult = (
  content: unknown,
  owner: RegisteredAgent,
  peer: RegisteredAgent,
  conversationId: ConversationId,
): void => {
  if (!isRecord(content)) {
    throw new Error("read_conversation returned no structured content");
  }
  if (typeof content.checkpoint !== "string") {
    throw new Error("read_conversation returned no checkpoint");
  }
  expect(content).toMatchObject({
    messages: [
      {
        conversationId,
        senderId: owner.agentId,
        parts: [{ type: "text", text: INITIAL_CONTENT }],
      },
      {
        conversationId,
        senderId: peer.agentId,
        parts: [{ type: "text", text: PEER_MESSAGE }],
      },
      {
        conversationId,
        senderId: owner.agentId,
        parts: [{ type: "text", text: HARNESS_REPLY }],
      },
    ],
  });
};

const expectMcpReadPlane = ({
  mcp,
  owner,
  peer,
  conversationId,
}: RoundTripFixture) =>
  Effect.gen(function* () {
    const agents = yield* callMcpTool(mcp, "search_agents", {
      query: peer.name,
    });
    expect(agents.structuredContent).toMatchObject({
      agents: [{ id: peer.agentId, name: peer.name }],
    });

    const conversations = yield* callMcpTool(mcp, "search_conversations", {
      query: peer.name,
    });
    expect(conversations.structuredContent).toMatchObject({
      conversations: [{ id: conversationId }],
    });

    const history = yield* callMcpTool(mcp, "read_conversation", {
      conversationId,
    });
    expectReadConversationResult(
      history.structuredContent,
      owner,
      peer,
      conversationId,
    );
  });

const runMcpMessageRoundTrip = ({
  harness,
  mcp,
  owner,
  peer,
  conversationId,
}: RoundTripFixture) =>
  Effect.gen(function* () {
    const turnFiber = yield* Effect.fork(
      takeHead(harness.turns, "harness turn"),
    );
    const peerReplyFiber = yield* Effect.fork(
      waitForPeerReply(peer, owner, conversationId),
    );

    yield* peer.client.call(H.messagesSend.name, {
      conversationId,
      parts: [{ type: "text", text: PEER_MESSAGE }],
    });

    const turn = yield* Fiber.join(turnFiber);
    expectHarnessTurn(turn, owner, peer, conversationId);

    yield* turn.reply(HARNESS_REPLY);
    expectPeerReply(yield* Fiber.join(peerReplyFiber), owner, conversationId);
    yield* expectMcpReadPlane({
      harness,
      mcp,
      owner,
      peer,
      conversationId,
    });
  });

const startConversationThroughMcp = (
  mcp: Client,
  owner: RegisteredAgent,
  peer: RegisteredAgent,
) =>
  Effect.gen(function* () {
    const toolResult = yield* callMcpTool(mcp, "start_conversation", {
      otherAgentNames: [peer.name],
      initialContent: INITIAL_CONTENT,
    });
    const { conversation } = yield* decodeHarnessStartConversationResult(
      toolResult.structuredContent,
    ).pipe(Effect.mapError(toError));

    expect(conversation.participants).toEqual([owner.agentId, peer.agentId]);
    const history = yield* peer.client.call(H.messagesList.name, {
      conversationId: conversation.id,
      limit: 10,
    });
    expect(history.messages).toHaveLength(1);
    const initialMessage = history.messages[0];
    if (initialMessage === undefined) {
      throw new Error("initial conversation message was not persisted");
    }
    expect(initialMessage.senderId).toBe(owner.agentId);
    expect(H.textContent(initialMessage)).toBe(INITIAL_CONTENT);
    return conversation.id;
  });

function runHarnessRoundTrip(owner: RegisteredAgent, peer: RegisteredAgent) {
  return Effect.gen(function* () {
    yield* peer.client.connect();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* acquireMoltzapd({ profileName: PROFILE_NAME });
        const harness = yield* acquireHarnessClient({
          url: harnessUrl(server).href,
        }).pipe(Effect.provide(KeyValueStore.layerMemory));
        expect(harness.agentId).toBe(owner.agentId);
        const mcp = yield* acquireMcpClient(harnessUrl(server));

        const conversationId = yield* startConversationThroughMcp(
          mcp,
          owner,
          peer,
        );
        yield* runMcpMessageRoundTrip({
          harness,
          mcp,
          owner,
          peer,
          conversationId,
        });
      }),
    );

    yield* waitForConnectionCount(1);
  }).pipe(Effect.provide(NodeContext.layer));
}

const runFailedAcquisition = (mcpPort: number) =>
  Effect.gen(function* () {
    // The daemon binds the slot's port, so the conflict has to be on that port.
    yield* acquirePortBlocker(mcpPort);
    const ambientScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );

    expect(yield* healthConnections()).toBe(0);
    const attempted = yield* Effect.exit(
      acquireMoltzapd({ profileName: PROFILE_NAME }).pipe(
        Scope.extend(ambientScope),
      ),
    );

    expect(Exit.isFailure(attempted)).toBe(true);
    if (Exit.isFailure(attempted)) {
      expect(Cause.squash(attempted.cause)).toMatchObject({
        code: "EADDRINUSE",
      });
    }
    yield* waitForConnectionCount(0);
  });

function runWithProfile(registered: RegisteredAgent) {
  return Effect.scoped(reserveTestMcpPort).pipe(
    Effect.flatMap((mcpPort) =>
      withTestServiceConfig(
        {
          profileName: PROFILE_NAME,
          agentName: PROFILE_NAME,
          agentId: registered.agentId,
          agentKey: registered.apiKey,
          serverUrl: H.coreBaseUrl(),
          mcpPort,
        },
        runRegisteredAgent(registered),
      ),
    ),
  );
}

function runFailedAcquisitionWithProfile(registered: RegisteredAgent) {
  return Effect.scoped(reserveTestMcpPort).pipe(
    Effect.flatMap((mcpPort) =>
      withTestServiceConfig(
        {
          profileName: PROFILE_NAME,
          agentName: PROFILE_NAME,
          agentId: registered.agentId,
          agentKey: registered.apiKey,
          serverUrl: H.coreBaseUrl(),
          mcpPort,
        },
        Effect.scoped(runFailedAcquisition(mcpPort)),
      ),
    ),
  );
}

function runHarnessRoundTripWithProfile({
  owner,
  peer,
}: {
  readonly owner: RegisteredAgent;
  readonly peer: RegisteredAgent;
}) {
  return Effect.scoped(reserveTestMcpPort).pipe(
    Effect.flatMap((mcpPort) =>
      withTestServiceConfig(
        {
          profileName: PROFILE_NAME,
          agentName: PROFILE_NAME,
          agentId: owner.agentId,
          agentKey: owner.apiKey,
          serverUrl: H.coreBaseUrl(),
          mcpPort,
        },
        runHarnessRoundTrip(owner, peer),
      ),
    ),
  );
}

H.setupServiceIntegration();

it("owns one agent connection and MCP listener without a Unix socket", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    H.registerAgent("moltzapd-owner"),
    runWithProfile,
    (registered) => registered.client.close().pipe(Effect.ignore),
  );
});

it("starts a conversation and round-trips a bound reply through MCP only", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    Effect.all({
      owner: H.registerAgent("moltzapd-round-trip-owner"),
      peer: H.registerAgent("moltzapd-round-trip-peer"),
    }),
    runHarnessRoundTripWithProfile,
    ({ owner, peer }) =>
      H.closeAll([], [owner.client, peer.client]).pipe(
        Effect.zipRight(waitForConnectionCount(0)),
        Effect.orDieWith(toError),
      ),
  );
});

it("rolls back the agent connection when MCP listener acquisition fails", () => {
  expect.hasAssertions();
  return Effect.acquireUseRelease(
    H.registerAgent("moltzapd-rollback"),
    runFailedAcquisitionWithProfile,
    (registered) => registered.client.close().pipe(Effect.ignore),
  );
});
