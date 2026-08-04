/**
 * @file Packaged daemon integration for the two runtime adapter surfaces.
 * Each case owns its server, profile, loopback MCP endpoint, HarnessClient
 * checkpoint store, and adapter drain.
 */
import { FileSystem } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { NodeContext } from "@effect/platform-node";
import {
  acquireHarnessClient,
  type HarnessClientService,
} from "@moltzap/client/harness-client";
import {
  acquirePackagedMoltzapd,
  reserveTestMcpPort,
  registerAgent,
  registerAndConnect,
  withTestServiceConfig,
  type ConnectedHarnessAgent,
  type RegisterResponse,
} from "@moltzap/client/test-utils";
import { MoltZapAdapter } from "@moltzap/nanoclaw-channel";
import { createMoltzapChannelPlugin } from "@moltzap/openclaw-channel";
import {
  conversationList,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import { agentName } from "@moltzap/protocol/identity";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
  type Message,
} from "@moltzap/protocol/message";
import {
  startCoreTestServer,
  stopCoreTestServer,
  type CoreTestServer,
} from "@moltzap/server-core/test-utils";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Schema,
  Stream,
  type Scope,
} from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WAIT_TIMEOUT = Duration.seconds(20);
const CONVERSATION_LIST_LIMIT = 100;
const INITIAL_CONTENT = "hello from the harness owner";
const PEER_CONTENT = "hello through the packaged harness";
const OPENCLAW_REPLY = "reply through OpenClaw";
const NANOCLAW_REPLY = "reply through NanoClaw";
const OPENCLAW_PROFILE = "harness-openclaw-integration";
const NANOCLAW_PROFILE = "harness-nanoclaw-integration";
const OPENCLAW_OWNER_NAME = "harness-openclaw-owner";
const OPENCLAW_PEER_NAME = "harness-openclaw-peer";
const NANOCLAW_OWNER_NAME = "harness-nanoclaw-owner";
const NANOCLAW_PEER_NAME = "harness-nanoclaw-peer";
const OPENCLAW_HOME_ENV = "OPENCLAW_HOME";
const OPENCLAW_STATE_DIR_ENV = "OPENCLAW_STATE_DIR";
const OPENCLAW_CONFIG_PATH_ENV = "OPENCLAW_CONFIG_PATH";

interface OpenClawEnvironment {
  readonly home?: string;
  readonly stateDir?: string;
  readonly configPath?: string;
}

interface AdapterCase {
  readonly kind: "openclaw" | "nanoclaw";
  readonly profileName: string;
  readonly ownerName: string;
  readonly peerName: string;
}

interface AdapterExchange {
  readonly harness: HarnessClientService;
  readonly peer: ConnectedHarnessAgent;
  readonly owner: RegisterResponse;
  readonly conversationId: ConversationId;
}

interface PeerExchange extends Omit<AdapterExchange, "harness"> {
  readonly expectedReply: string;
  readonly inboundText: Deferred.Deferred<string>;
}

interface OpenClawExchange extends AdapterExchange {
  readonly profileName: string;
}

const OPENCLAW_CASE: AdapterCase = {
  kind: "openclaw",
  profileName: OPENCLAW_PROFILE,
  ownerName: OPENCLAW_OWNER_NAME,
  peerName: OPENCLAW_PEER_NAME,
};

const NANOCLAW_CASE: AdapterCase = {
  kind: "nanoclaw",
  profileName: NANOCLAW_PROFILE,
  ownerName: NANOCLAW_OWNER_NAME,
  peerName: NANOCLAW_PEER_NAME,
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const tryPromise = <A>(
  operation: () => PromiseLike<A>,
): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: toError,
  });

const acquireCoreTestServer: Effect.Effect<CoreTestServer, Error, Scope.Scope> =
  Effect.acquireRelease(
    tryPromise(() => startCoreTestServer()),
    () => tryPromise(() => stopCoreTestServer()).pipe(Effect.orDie),
  );

const acquirePeer = (
  server: CoreTestServer,
  name: string,
): Effect.Effect<ConnectedHarnessAgent, Error, Scope.Scope> =>
  Effect.acquireRelease(registerAndConnect(server.baseUrl, name), (peer) =>
    peer.client.close().pipe(Effect.ignore),
  );

const awaitDeferred = <A>(
  deferred: Deferred.Deferred<A>,
  label: string,
): Effect.Effect<A, Error> =>
  Deferred.await(deferred).pipe(
    Effect.timeoutFail({
      duration: WAIT_TIMEOUT,
      onTimeout: () => new Error(`timed out waiting for ${label}`),
    }),
  );

const takePeerReply = (
  peer: ConnectedHarnessAgent,
  owner: RegisterResponse,
  conversationId: ConversationId,
): Effect.Effect<Message, Error> =>
  peer.client.subscribe(messageReceivedNotificationDefinition).pipe(
    Stream.filter(
      ({ message }) =>
        message.senderId === owner.agentId &&
        message.conversationId === conversationId,
    ),
    Stream.runHead,
    Effect.timeoutFail({
      duration: WAIT_TIMEOUT,
      onTimeout: () => new Error("timed out waiting for the adapter reply"),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(new Error("peer reply stream closed before delivery")),
        onSome: ({ message }) => Effect.succeed(message),
      }),
    ),
    Effect.mapError(toError),
  );

const messageText = (message: Message): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");

const assertConversationBoundary = (
  harness: HarnessClientService,
  owner: RegisterResponse,
  peer: ConnectedHarnessAgent,
  peerName: string,
) =>
  Effect.gen(function* () {
    const conversation = yield* harness.startConversation(
      [Schema.decodeSync(agentName)(peerName)],
      INITIAL_CONTENT,
    );

    expect(new Set(conversation.participants)).toEqual(
      new Set([owner.agentId, peer.agentId]),
    );

    const listed = yield* peer.client.sendRpc(conversationList, {
      limit: CONVERSATION_LIST_LIMIT,
    });
    const item = listed.items.find(
      (candidate) => candidate.conversation.id === conversation.id,
    );
    expect(item).toBeDefined();
    expect(item?.conversation).not.toHaveProperty("participants");
    expect(new Set(item?.participants)).toEqual(
      new Set([owner.agentId, peer.agentId]),
    );
    return conversation.id;
  });

const runPeerExchange = (exchange: PeerExchange) =>
  Effect.gen(function* () {
    const replyFiber = yield* Effect.fork(
      takePeerReply(exchange.peer, exchange.owner, exchange.conversationId),
    );
    yield* exchange.peer.client.sendRpc(messagesSend, {
      conversationId: exchange.conversationId,
      parts: [{ type: "text", text: PEER_CONTENT }],
    });

    expect(
      yield* awaitDeferred(exchange.inboundText, "adapter inbound delivery"),
    ).toBe(PEER_CONTENT);
    const reply = yield* Fiber.join(replyFiber);
    expect(reply.conversationId).toBe(exchange.conversationId);
    expect(reply.senderId).toBe(exchange.owner.agentId);
    expect(messageText(reply)).toBe(exchange.expectedReply);
  });

const makeOpenClawConfig = (storePath: string, workspacePath: string) => ({
  session: { store: storePath },
  agents: {
    defaults: {
      workspace: workspacePath,
    },
  },
});

type OpenClawConfig = ReturnType<typeof makeOpenClawConfig>;
type OpenClawPlugin = ReturnType<typeof createMoltzapChannelPlugin>;
type OpenClawStartContext = Parameters<
  OpenClawPlugin["gateway"]["startAccount"]
>[0];
type OpenClawReplyDispatcher = NonNullable<
  NonNullable<
    NonNullable<OpenClawStartContext["channelRuntime"]>["reply"]
  >["dispatchReplyWithBufferedBlockDispatcher"]
>;

const loadOpenClawReplyRuntime = () =>
  import("openclaw/plugin-sdk/reply-dispatch-runtime");

type OpenClawReplyRuntime = Awaited<
  ReturnType<typeof loadOpenClawReplyRuntime>
>;

interface OpenClawFixture {
  readonly cfg: OpenClawConfig;
  readonly runtime: OpenClawReplyRuntime;
  readonly inboundText: Deferred.Deferred<string>;
  readonly connected: Deferred.Deferred<boolean>;
}

/* eslint-disable agent-code-guard/no-process-env-at-runtime -- The real OpenClaw dispatcher reads these documented paths from process.env; the enclosing scope restores every value. */
const restoreEnvironment = (name: string, value?: string): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
};

const acquireOpenClawEnvironment = (
  home: string,
  configPath: string,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous: OpenClawEnvironment = {
        home: process.env[OPENCLAW_HOME_ENV],
        stateDir: process.env[OPENCLAW_STATE_DIR_ENV],
        configPath: process.env[OPENCLAW_CONFIG_PATH_ENV],
      };
      process.env[OPENCLAW_HOME_ENV] = home;
      process.env[OPENCLAW_STATE_DIR_ENV] = home;
      process.env[OPENCLAW_CONFIG_PATH_ENV] = configPath;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        restoreEnvironment(OPENCLAW_HOME_ENV, previous.home);
        restoreEnvironment(OPENCLAW_STATE_DIR_ENV, previous.stateDir);
        restoreEnvironment(OPENCLAW_CONFIG_PATH_ENV, previous.configPath);
      }),
  ).pipe(Effect.asVoid);
/* eslint-enable agent-code-guard/no-process-env-at-runtime -- Restore strict defaults after the scoped OpenClaw environment helper. */

const prepareOpenClawFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const sessionRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "moltzap-openclaw-harness-",
  });
  const workspacePath = join(sessionRoot, "workspace");
  yield* fileSystem.makeDirectory(workspacePath);
  const configPath = join(sessionRoot, "openclaw.json");
  yield* fileSystem.writeFileString(configPath, "{}\n");
  yield* acquireOpenClawEnvironment(sessionRoot, configPath);
  const runtime = yield* tryPromise(loadOpenClawReplyRuntime);
  const cfg = makeOpenClawConfig(
    join(sessionRoot, "sessions.json"),
    workspacePath,
  );
  const inboundText = yield* Deferred.make<string>();
  const connected = yield* Deferred.make<boolean>();
  return { cfg, runtime, inboundText, connected } satisfies OpenClawFixture;
});

const makeOpenClawReplyDispatcher =
  (fixture: OpenClawFixture): OpenClawReplyDispatcher =>
  (params) =>
    fixture.runtime.dispatchReplyWithBufferedBlockDispatcher({
      ctx: fixture.runtime.finalizeInboundContext(params.ctx),
      cfg: fixture.cfg,
      dispatcherOptions: {
        ...params.dispatcherOptions,
        deliver: (payload, info) =>
          Promise.resolve(params.dispatcherOptions.deliver(payload, info)),
      },
      replyResolver: (ctx) => {
        Effect.runSync(Deferred.succeed(fixture.inboundText, ctx.Body ?? ""));
        return Promise.resolve({ text: OPENCLAW_REPLY });
      },
    });

const makeOpenClawStatusHandler =
  (connected: Deferred.Deferred<boolean>): OpenClawStartContext["setStatus"] =>
  (status) => {
    if (status.connected === true) {
      Effect.runSync(Deferred.succeed(connected, true));
    }
  };

const startOpenClawGateway = (
  harness: HarnessClientService,
  profileName: string,
  fixture: OpenClawFixture,
) =>
  Effect.gen(function* () {
    const abortController = new AbortController();
    const plugin = createMoltzapChannelPlugin({
      harnessClientForAccount: () => harness,
    });
    const startFiber = yield* Effect.fork(
      tryPromise(() =>
        plugin.gateway.startAccount({
          cfg: fixture.cfg,
          accountId: profileName,
          account: { id: profileName, agentName: profileName },
          abortSignal: abortController.signal,
          setStatus: makeOpenClawStatusHandler(fixture.connected),
          channelRuntime: {
            reply: {
              dispatchReplyWithBufferedBlockDispatcher:
                makeOpenClawReplyDispatcher(fixture),
            },
          },
        }),
      ),
    );
    yield* Effect.addFinalizer(() =>
      tryPromise(() =>
        plugin.gateway.stopAccount({ accountId: profileName }),
      ).pipe(
        Effect.ignore,
        Effect.zipRight(
          Effect.sync(() => {
            abortController.abort();
          }),
        ),
        Effect.zipRight(Fiber.interrupt(startFiber)),
        Effect.asVoid,
      ),
    );
  });

const runOpenClawExchange = (exchange: OpenClawExchange) =>
  Effect.gen(function* () {
    const fixture = yield* prepareOpenClawFixture;
    yield* startOpenClawGateway(
      exchange.harness,
      exchange.profileName,
      fixture,
    );
    yield* awaitDeferred(
      fixture.connected,
      "OpenClaw Harness gateway readiness",
    );
    yield* runPeerExchange({
      peer: exchange.peer,
      owner: exchange.owner,
      conversationId: exchange.conversationId,
      expectedReply: OPENCLAW_REPLY,
      inboundText: fixture.inboundText,
    });
  });

const readNanoClawText = (content: unknown): string => {
  if (
    typeof content !== "object" ||
    content === null ||
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error("NanoClaw inbound content contained no text");
  }
  return content.text;
};

const runNanoClawExchange = (exchange: AdapterExchange) =>
  Effect.gen(function* () {
    const inboundText = yield* Deferred.make<string>();
    const adapter = MoltZapAdapter.fromHarnessClient(exchange.harness);
    yield* tryPromise(() =>
      adapter.setup({
        onInbound: (...[jid, , message]) => {
          Effect.runSync(
            Deferred.succeed(inboundText, readNanoClawText(message.content)),
          );
          return adapter.deliver(jid, null, {
            kind: "chat",
            content: { text: NANOCLAW_REPLY },
          });
        },
        onMetadata: () => undefined,
      }),
    );
    yield* Effect.addFinalizer(() =>
      tryPromise(() => adapter.teardown()).pipe(Effect.ignore),
    );

    yield* runPeerExchange({
      peer: exchange.peer,
      owner: exchange.owner,
      conversationId: exchange.conversationId,
      expectedReply: NANOCLAW_REPLY,
      inboundText,
    });
  });

const runAdapterCase = (adapterCase: AdapterCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* acquireCoreTestServer;
      const owner = yield* registerAgent(server.baseUrl, adapterCase.ownerName);
      const peer = yield* acquirePeer(server, adapterCase.peerName);

      // The daemon binds exactly the port its slot records, so the port is
      // chosen here and written into the slot before the child starts.
      const mcpPort = yield* Effect.scoped(reserveTestMcpPort);

      yield* withTestServiceConfig(
        {
          profileName: adapterCase.profileName,
          agentName: adapterCase.ownerName,
          agentId: owner.agentId,
          agentKey: owner.apiKey,
          serverUrl: server.baseUrl,
          mcpPort,
        },
        Effect.scoped(
          Effect.gen(function* () {
            const daemon = yield* acquirePackagedMoltzapd({
              profileName: adapterCase.profileName,
            });
            const harness = yield* acquireHarnessClient({
              url: daemon.mcpUrl,
            }).pipe(Effect.provide(KeyValueStore.layerMemory));
            const conversationId = yield* assertConversationBoundary(
              harness,
              owner,
              peer,
              adapterCase.peerName,
            );

            const exchange = { harness, peer, owner, conversationId };
            yield* adapterCase.kind === "openclaw"
              ? runOpenClawExchange({
                  ...exchange,
                  profileName: adapterCase.profileName,
                })
              : runNanoClawExchange(exchange);
          }),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeContext.layer));

describe("packaged moltzapd Harness adapters", () => {
  it("delivers and replies through the real OpenClaw dispatcher", () =>
    Effect.runPromise(runAdapterCase(OPENCLAW_CASE)));

  it("delivers and replies through the NanoClaw adapter", () =>
    Effect.runPromise(runAdapterCase(NANOCLAW_CASE)));
});
