/**
 * @file Packaged daemon integration for the two runtime adapter surfaces.
 * Each case owns its server, profile, loopback MCP endpoint, HarnessClient
 * checkpoint store, and adapter drain.
 */
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { harnessClientForProfile } from "@moltzap/client";
import type { HarnessClientService } from "@moltzap/client/harness-client";
import {
  reserveTestMcpPort,
  registerAgent,
  registerAndConnect,
  withTestServiceConfig,
  type ConnectedHarnessAgent,
  type RegisterResponse,
} from "@moltzap/client/test-utils";
import { makeMoltZapAdapter } from "@moltzap/nanoclaw-channel";
import { createMoltzapChannelPlugin } from "@moltzap/openclaw-channel";
import {
  agentConversationCreate,
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
  Config,
  ConfigProvider,
  Data,
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
const RESTART_PROFILE = "harness-restart-integration";
const RESTART_OWNER_NAME = "harness-restart-owner";
const RESTART_TARGET_NAME = "harness-restart-target";
const RESTART_SOURCE_NAME = "harness-restart-source";
const SOURCE_BEFORE_RESTART = "source content before the restart";
const SOURCE_AFTER_RESTART = "source content after the restart";
const SOURCE_AFTER_CHECKPOINT_LOSS = "source content after checkpoint loss";
const TARGET_FIRST = "target content one";
const TARGET_SECOND = "target content two";
const TARGET_THIRD = "target content three";
const RESTART_REPLY = "reply from the restarted client";
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

/** What one case needs before it decides who acquires the slot's client. */
interface CaseInput {
  readonly profileName: string;
  readonly peerName: string;
  readonly owner: RegisterResponse;
  readonly peer: ConnectedHarnessAgent;
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

/** The NanoClaw factory refused the profile slot this case just wrote. */
class MissingNanoClawAdapterError extends Data.TaggedError(
  "MissingNanoClawAdapterError",
)<Record<never, never>> {
  override get message(): string {
    return "the NanoClaw factory returned no adapter";
  }
}

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

// ─── restart ──────────────────────────────────────────────────────────────

// `20260801-harness-client-owns-runtime-context` (v2-owned; production
// adoption is still main-owned): "The client stores stable per-conversation
// presentation checkpoints locally. After restart it uses search and history
// reads to rebuild context from those positions." and "This boundary presents
// context at most once during normal operation."
//
// One slot, three client lifetimes. Only the slot's checkpoint directory
// survives between them; each lifetime spawns its own daemon.

const configHome = Config.string("MOLTZAP_CONFIG_HOME").pipe(
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  Effect.mapError(toError),
);

const checkpointDirectory = (
  profileName: string,
): Effect.Effect<string, Error> =>
  configHome.pipe(Effect.map((home) => join(home, "checkpoints", profileName)));

// Turns arrive for every conversation the owner participates in. Selecting by
// conversation drains the source conversation's own turn on the way past.
const takeTurnFor = (
  harness: HarnessClientService,
  conversationId: ConversationId,
) =>
  harness.turns.pipe(
    Stream.filter((turn) => turn.conversationId === conversationId),
    Stream.runHead,
    Effect.timeoutFail({
      duration: WAIT_TIMEOUT,
      onTimeout: () => new Error("timed out waiting for a harness turn"),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(new Error("harness turn stream closed before delivery")),
        onSome: Effect.succeed,
      }),
    ),
    Effect.mapError(toError),
  );

interface RestartExchange {
  readonly harness: HarnessClientService;
  readonly peer: ConnectedHarnessAgent;
  readonly conversationId: ConversationId;
  readonly text: string;
}

// Sends one peer message and returns the turn it produces, with the take
// forked first so a fast daemon cannot deliver before the stream is pulled.
const exchangeTurn = (input: RestartExchange) =>
  Effect.gen(function* () {
    const turnFiber = yield* Effect.fork(
      takeTurnFor(input.harness, input.conversationId),
    );
    yield* input.peer.client
      .sendRpc(messagesSend, {
        conversationId: input.conversationId,
        parts: [{ type: "text", text: input.text }],
      })
      .pipe(Effect.mapError(toError));
    return yield* Fiber.join(turnFiber);
  });

interface CrossConversationContext {
  readonly contextBlocks: {
    readonly crossConversationMessages?: ReadonlyArray<{
      readonly text: string;
    }>;
  };
}

const crossConversationTexts = (
  turn: CrossConversationContext,
): readonly string[] =>
  (turn.contextBlocks.crossConversationMessages ?? []).map(
    (message) => message.text,
  );

interface RestartLifetimeInput {
  readonly owner: RegisterResponse;
  readonly targetPeer: ConnectedHarnessAgent;
  readonly sourcePeer: ConnectedHarnessAgent;
  readonly targetConversationId: ConversationId;
  readonly sourceConversationId: ConversationId;
  readonly sourceText: string;
  readonly targetText: string;
  /** When set, the turn's bound reply is exercised before the scope closes. */
  readonly replyWith?: string;
}

// One client lifetime: the source conversation gains content, then the target
// conversation produces the turn whose cross-conversation context is measured.
// A turn's reply is bound to the MCP client that produced it, so it is
// exercised here rather than escaping the scope that owns that client.
const runRestartLifetime = (
  input: RestartLifetimeInput,
): Effect.Effect<readonly string[], Error, Scope.Scope> =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* harnessClientForProfile(RESTART_PROFILE);
      yield* exchangeTurn({
        harness,
        peer: input.sourcePeer,
        conversationId: input.sourceConversationId,
        text: input.sourceText,
      });
      const turn = yield* exchangeTurn({
        harness,
        peer: input.targetPeer,
        conversationId: input.targetConversationId,
        text: input.targetText,
      });

      if (input.replyWith !== undefined) {
        const replyFiber = yield* Effect.fork(
          takePeerReply(
            input.targetPeer,
            input.owner,
            input.targetConversationId,
          ),
        );
        yield* turn.reply(input.replyWith).pipe(Effect.mapError(toError));
        const delivered = yield* Fiber.join(replyFiber);
        expect(delivered.conversationId).toBe(input.targetConversationId);
        expect(messageText(delivered)).toBe(input.replyWith);
      }

      return crossConversationTexts(turn);
    }),
  );

const createPeerDm = (
  peer: ConnectedHarnessAgent,
  owner: RegisterResponse,
): Effect.Effect<ConversationId, Error> =>
  peer.client
    .sendRpc(agentConversationCreate, { participants: [owner.agentId] })
    .pipe(
      Effect.map((created) => created.conversation.id),
      Effect.mapError(toError),
    );

// The OpenClaw plugin takes an injected client, so the test acquires the
// slot's client itself and asserts the conversation boundary through it.
const runOpenClawCase = (input: CaseInput) =>
  Effect.gen(function* () {
    // The production composition end to end: the slot's own daemon, the
    // endpoint derived from the slot, and a real file-backed checkpoint
    // store — no test-only acquisition path.
    const harness = yield* harnessClientForProfile(input.profileName);
    const conversationId = yield* assertConversationBoundary(
      harness,
      input.owner,
      input.peer,
      input.peerName,
    );
    yield* runOpenClawExchange({
      harness,
      peer: input.peer,
      owner: input.owner,
      conversationId,
      profileName: input.profileName,
    });
  });

// The NanoClaw adapter acquires the slot's client itself, and one slot names
// one loopback port, so nothing else here may open a second daemon against
// it. The peer therefore opens the conversation.
const runNanoClawCase = (input: CaseInput) =>
  Effect.gen(function* () {
    const inboundText = yield* Deferred.make<string>();
    const adapter = makeMoltZapAdapter({
      profileName: input.profileName,
      evalMode: false,
    });
    if (adapter === null) {
      return yield* new MissingNanoClawAdapterError();
    }
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

    const conversationId = yield* createPeerDm(input.peer, input.owner);
    yield* runPeerExchange({
      peer: input.peer,
      owner: input.owner,
      conversationId,
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

      const input: CaseInput = {
        profileName: adapterCase.profileName,
        peerName: adapterCase.peerName,
        owner,
        peer,
      };
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
          adapterCase.kind === "openclaw"
            ? runOpenClawCase(input)
            : runNanoClawCase(input),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeContext.layer));

interface RestartPrincipals {
  readonly owner: RegisterResponse;
  readonly targetPeer: ConnectedHarnessAgent;
  readonly sourcePeer: ConnectedHarnessAgent;
}

// Three lifetimes against one slot: cold, warm across a restart, and warm
// again after the stored positions are deleted.
const runRestartLifetimes = ({
  owner,
  targetPeer,
  sourcePeer,
}: RestartPrincipals) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const targetConversationId = yield* createPeerDm(targetPeer, owner);
    const sourceConversationId = yield* createPeerDm(sourcePeer, owner);
    const lifetime = (
      sourceText: string,
      targetText: string,
      replyWith?: string,
    ) =>
      runRestartLifetime({
        owner,
        targetPeer,
        sourcePeer,
        targetConversationId,
        sourceConversationId,
        sourceText,
        targetText,
        ...(replyWith === undefined ? {} : { replyWith }),
      });

    const cold = yield* lifetime(SOURCE_BEFORE_RESTART, TARGET_FIRST);
    expect(cold).toContain(SOURCE_BEFORE_RESTART);

    // Second lifetime: new daemon, new client, same checkpoint
    // directory. Its reply also proves authority comes from the live
    // turn rather than the history reads that rebuilt the context.
    const warm = yield* lifetime(
      SOURCE_AFTER_RESTART,
      TARGET_SECOND,
      RESTART_REPLY,
    );
    expect(warm).toContain(SOURCE_AFTER_RESTART);
    // At most once: content already presented is not presented again.
    expect(warm).not.toContain(SOURCE_BEFORE_RESTART);

    // Non-vacuity: without the stored positions the same lifetime
    // re-presents everything, so the narrowing above was the checkpoints.
    const checkpoints = yield* checkpointDirectory(RESTART_PROFILE);
    yield* fileSystem
      .remove(checkpoints, { recursive: true })
      .pipe(Effect.mapError(toError));

    const reread = yield* lifetime(SOURCE_AFTER_CHECKPOINT_LOSS, TARGET_THIRD);
    expect(reread).toContain(SOURCE_BEFORE_RESTART);
    expect(reread).toContain(SOURCE_AFTER_RESTART);
    expect(reread).toContain(SOURCE_AFTER_CHECKPOINT_LOSS);
  });

const runRestartCase = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* acquireCoreTestServer;
      const owner = yield* registerAgent(server.baseUrl, RESTART_OWNER_NAME);
      const targetPeer = yield* acquirePeer(server, RESTART_TARGET_NAME);
      const sourcePeer = yield* acquirePeer(server, RESTART_SOURCE_NAME);
      const mcpPort = yield* Effect.scoped(reserveTestMcpPort);

      yield* withTestServiceConfig(
        {
          profileName: RESTART_PROFILE,
          agentName: RESTART_OWNER_NAME,
          agentId: owner.agentId,
          agentKey: owner.apiKey,
          serverUrl: server.baseUrl,
          mcpPort,
        },
        runRestartLifetimes({ owner, targetPeer, sourcePeer }),
      );
    }),
  ).pipe(Effect.provide(NodeContext.layer));

describe("packaged moltzapd Harness adapters", () => {
  it("delivers and replies through the real OpenClaw dispatcher", () =>
    Effect.runPromise(runAdapterCase(OPENCLAW_CASE)));

  it("delivers and replies through the NanoClaw adapter", () =>
    Effect.runPromise(runAdapterCase(NANOCLAW_CASE)));

  it("rebuilds context from stored checkpoints after a restart", () =>
    Effect.runPromise(runRestartCase()));
});
