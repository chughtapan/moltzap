/** @file Real-daemon acceptance for both public runtime adapters. */

import {
  acquireHarnessEndpoint,
  AgentAddress,
  type Content,
  type InboundDelivery,
  type InboundMessage,
} from "@moltzap/client";
import { MoltZapAdapter } from "@moltzap/nanoclaw-channel";
import openClawPlugin from "@moltzap/openclaw-channel";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { expect, it } from "vitest";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  ProcessTestError,
} from "../../packages/client/integration/daemon-process-harness.js";

const DELIVERY_TIMEOUT = Duration.seconds(60);
const OPENCLAW_ACCOUNT_ID = "adapter-target";
const OPENCLAW_MAIN_SESSION_KEY = "agent:primary:main";
const OPENCLAW_REPLY = "reply from the real OpenClaw adapter";
const NANOCLAW_REPLY = "reply from the real NanoClaw adapter";

interface Scenario {
  readonly caller: DaemonProcessFixture;
  readonly target: DaemonProcessFixture;
}

interface RecordedSessionSnapshot {
  readonly messageIds: readonly string[];
}

class RecordedSessionStore {
  private readonly messagesBySession = new Map<string, string[]>();

  acceptMessage(sessionKey: string, messageId: string): void {
    const messageIds = this.messagesBySession.get(sessionKey) ?? [];
    if (!messageIds.includes(messageId)) {
      messageIds.push(messageId);
    }
    this.messagesBySession.set(sessionKey, messageIds);
  }

  keys(): readonly string[] {
    return [...this.messagesBySession.keys()];
  }

  snapshot(sessionKey: string): RecordedSessionSnapshot {
    return {
      messageIds: [...(this.messagesBySession.get(sessionKey) ?? [])],
    };
  }
}

interface OpenClawConfig {
  readonly channels: {
    readonly moltzap: {
      readonly accounts: readonly [
        {
          readonly id: string;
        },
      ];
    };
  };
  readonly session: { readonly store: string };
}

interface OpenClawBuildContextInput {
  readonly channel: string;
  readonly accountId: string;
  readonly provider: string;
  readonly surface: string;
  readonly messageId: string;
  readonly from: string;
  readonly sender: { readonly id: string; readonly name: string };
  readonly conversation: {
    readonly kind: "direct" | "group";
    readonly id: string;
    readonly label: string;
  };
  readonly route: {
    readonly routeSessionKey: string;
    readonly mainSessionKey: string;
  };
  readonly reply: { readonly to: string; readonly originatingTo: string };
  readonly message: {
    readonly body: string;
    readonly rawBody: string;
    readonly bodyForAgent: string;
    readonly commandBody: string;
  };
  readonly extra?: { readonly GroupMembers?: string };
}

interface OpenClawInboundContext {
  readonly AccountId: string;
  readonly Body: string;
  readonly BodyForAgent: string;
  readonly BodyForCommands: string;
  readonly ChatId: string;
  readonly ChatType: "direct" | "group";
  readonly CommandAuthorized: boolean;
  readonly CommandBody: string;
  readonly From: string;
  readonly GroupMembers?: string;
  readonly GroupSubject?: string;
  readonly InboundEventKind: "message";
  readonly MessageSid: string;
  readonly OriginatingTo: string;
  readonly Provider: string;
  readonly RawBody: string;
  readonly SenderId: string;
  readonly SenderName: string;
  readonly SessionKey: string;
  readonly Surface: string;
  readonly To: string;
}

interface OpenClawRecordInput {
  readonly ctx: OpenClawInboundContext;
  readonly sessionKey: string;
  readonly storePath: string;
}

interface OpenClawDeliveryResult {
  readonly visibleReplySent: boolean;
}

interface OpenClawReplyDispatcherInput {
  readonly ctx: OpenClawInboundContext;
  readonly dispatcherOptions: {
    readonly deliver: (
      payload: { readonly text: string },
      context: { readonly kind: "final" },
    ) => Promise<OpenClawDeliveryResult>;
  };
  readonly replyOptions?: object;
}

interface OpenClawReplyResult {
  readonly queuedFinal: false;
  readonly counts: {
    readonly tool: number;
    readonly block: number;
    readonly final: number;
  };
  readonly sourceReplyDeliveryMode: "automatic";
}

interface OpenClawInboundTurnInput {
  readonly cfg: OpenClawConfig;
  readonly channel: string;
  readonly accountId: string;
  readonly route: {
    readonly agentId: string;
    readonly sessionKey: string;
  };
  readonly ctxPayload: OpenClawInboundContext;
  readonly delivery: OpenClawReplyDispatcherInput["dispatcherOptions"];
  readonly record?: {
    readonly updateLastRoute?: {
      readonly sessionKey: string;
      readonly channel: string;
      readonly to: string;
      readonly accountId: string;
    };
  };
  readonly replyOptions?: OpenClawReplyDispatcherInput["replyOptions"];
}

interface OpenClawInboundRunnerInput {
  readonly channel: string;
  readonly accountId: string;
  readonly raw: { readonly message: InboundMessage };
  readonly adapter: {
    readonly ingest: () => {
      readonly id: string;
      readonly rawText: string;
      readonly textForAgent: string;
      readonly textForCommands: string;
      readonly raw: InboundMessage;
    };
    readonly resolveTurn: () => OpenClawInboundTurnInput;
  };
}

interface OpenClawRouteInput {
  readonly accountId?: string | null;
  readonly peer?: { readonly kind: string; readonly id: string };
}

interface ObservedOpenClawAccountRuntime {
  readonly channel: {
    readonly runtimeContexts: object;
    readonly inbound: {
      readonly buildContext: (
        input: OpenClawBuildContextInput,
      ) => OpenClawInboundContext;
      readonly run: (input: OpenClawInboundRunnerInput) => Promise<object>;
    };
    readonly routing: {
      readonly resolveAgentRoute: (input: OpenClawRouteInput) => {
        readonly agentId: string;
        readonly channel: string;
        readonly accountId: string;
        readonly sessionKey: string;
        readonly mainSessionKey: string;
        readonly lastRoutePolicy: "session";
        readonly matchedBy: "default";
      };
    };
  };
}

interface OpenClawGatewayStatus {
  readonly accountId: string;
  readonly connected?: boolean;
  readonly running?: boolean;
  readonly lastConnectedAt?: number;
}

interface OpenClawGatewayContext {
  readonly cfg: OpenClawConfig;
  readonly accountId: string;
  readonly account: { readonly id: string };
  readonly abortSignal: AbortSignal;
  readonly runtime: {
    readonly log: (message: string) => void;
    readonly error: (message: string) => void;
    readonly exit: (code: number) => void;
  };
  readonly channelRuntime: ObservedOpenClawAccountRuntime["channel"];
  readonly getStatus: () => OpenClawGatewayStatus;
  readonly setStatus: (status: OpenClawGatewayStatus) => void;
}

interface OpenClawMessageSendContext {
  readonly cfg: OpenClawConfig;
  readonly accountId: string;
  readonly to: string;
  readonly text: string;
}

interface OpenClawMessageSendResult {
  readonly channel: string;
  readonly messageId?: string;
}

interface StableOpenClawChannelPlugin {
  readonly gateway: {
    readonly startAccount: (context: OpenClawGatewayContext) => Promise<void>;
  };
  readonly message: {
    readonly send: {
      readonly text: (
        context: OpenClawMessageSendContext,
      ) => Promise<OpenClawMessageSendResult>;
    };
  };
}

interface StableOpenClawPluginApi {
  readonly runtime: object;
  registerChannel(registration: object): void;
}

interface StableOpenClawEntry {
  register(api: StableOpenClawPluginApi): void;
}

function isStableOpenClawEntry(value: unknown): value is StableOpenClawEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "register" in value &&
    typeof value.register === "function"
  );
}

interface OpenClawReplyFixture {
  readonly callerAddress: string;
  readonly responseSent: Deferred.Deferred<void>;
  readonly sessions: RecordedSessionStore;
}

type OpenClawRuntimeFixture = OpenClawReplyFixture;

const nanoInboundContentSchema = Schema.Struct({
  text: Schema.String,
  address: AgentAddress,
  sender: AgentAddress,
  senderId: AgentAddress,
});

interface NanoClawInboundProjection {
  readonly id: string;
  readonly platformId: string;
  readonly threadId: string | null;
  readonly content: typeof nanoInboundContentSchema.Type;
  readonly isGroup: boolean;
}

function textContent(text: string): Content {
  return [{ type: "text", text }];
}

function directAddress(agentName: string) {
  return Schema.decodeUnknownSync(AgentAddress)(`agent:${agentName}`);
}

function effectFromPromise<A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, ProcessTestError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new ProcessTestError({
        message: `${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
}

function awaitSignal(signal: Deferred.Deferred<void>, description: string) {
  return Deferred.await(signal).pipe(
    Effect.timeoutFail({
      duration: DELIVERY_TIMEOUT,
      onTimeout: () =>
        new ProcessTestError({ message: `timed out awaiting ${description}` }),
    }),
  );
}

function nextDelivery<E>(stream: Stream.Stream<InboundDelivery, E>) {
  return Stream.runHead(stream).pipe(
    Effect.timeoutFail({
      duration: DELIVERY_TIMEOUT,
      onTimeout: () =>
        new ProcessTestError({
          message: "timed out awaiting addressed delivery",
        }),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ProcessTestError({ message: "delivery stream ended" }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function registerFixture(fixture: DaemonProcessFixture) {
  return Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.status()).toEqual({ kind: "unregistered" });
      expect(
        (yield* management.register(makeRegistrationRequest(fixture))).kind,
      ).toBe("registered");
    }),
  );
}

function acquireScenario(
  prefix: string,
): Effect.Effect<Scenario, ProcessTestError, Scope.Scope> {
  return Effect.gen(function* () {
    const infrastructure = yield* acquireProcessInfrastructure;
    const [caller, target] = yield* Effect.all(
      [
        makeDaemonProcessFixture(infrastructure, `${prefix}-caller`),
        makeDaemonProcessFixture(infrastructure, `${prefix}-target`),
      ] as const,
      { concurrency: 2 },
    );
    yield* Effect.all(
      [acquireDaemonProcess(caller), acquireDaemonProcess(target)] as const,
      { concurrency: 2 },
    );
    yield* Effect.all(
      [registerFixture(caller), registerFixture(target)] as const,
      { concurrency: 2, discard: true },
    );
    return { caller, target };
  });
}

function assertFixtureHistory(
  fixture: DaemonProcessFixture,
  peerAddress: ReturnType<typeof directAddress>,
  initial: Content,
  replies: readonly Content[],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.searchConversations()).toEqual({
        kind: "page",
        addresses: [peerAddress],
        hasMore: false,
      });
      const history = yield* management.readConversation(peerAddress);
      expect(history.continuation).toBeNull();
      expect(history.records).toHaveLength(1 + replies.length);
      expect(
        history.records.map(({ recordCore }) => recordCore.action.kind),
      ).toEqual(["GENESIS", ...replies.map(() => "POST" as const)]);
      expect(
        history.records.map(
          ({ recordCore }) => recordCore.action.postIntent.content,
        ),
      ).toEqual([initial, ...replies]);
      expect(
        new Set(
          history.records.map(
            ({ recordCore }) => recordCore.action.postIntent.postId,
          ),
        ).size,
      ).toBe(history.records.length);
    }),
  );
}

function assertDurableExchange(
  scenario: Scenario,
  initial: Content,
  replies: readonly Content[],
) {
  return Effect.all(
    [
      assertFixtureHistory(
        scenario.caller,
        directAddress(scenario.target.agentName),
        initial,
        replies,
      ),
      assertFixtureHistory(
        scenario.target,
        directAddress(scenario.caller.agentName),
        initial,
        replies,
      ),
    ] as const,
    { concurrency: 2, discard: true },
  );
}

function buildOpenClawContext(
  input: OpenClawBuildContextInput,
): OpenClawInboundContext {
  return {
    AccountId: input.accountId,
    Body: input.message.body,
    BodyForAgent: input.message.bodyForAgent,
    BodyForCommands: input.message.commandBody,
    ChatId: input.conversation.id,
    ChatType: input.conversation.kind,
    CommandAuthorized: false,
    CommandBody: input.message.commandBody,
    From: input.from,
    InboundEventKind: "message",
    MessageSid: input.messageId,
    OriginatingTo: input.reply.originatingTo,
    Provider: input.provider,
    RawBody: input.message.rawBody,
    SenderId: input.sender.id,
    SenderName: input.sender.name,
    SessionKey: input.route.routeSessionKey,
    Surface: input.surface,
    To: input.reply.to,
    ...(input.extra?.GroupMembers === undefined
      ? {}
      : {
          GroupMembers: input.extra.GroupMembers,
          GroupSubject: input.conversation.label,
        }),
  };
}

/**
 * Creates the smallest account runtime needed by the process-boundary test.
 * The channel package test covers OpenClaw's real inbound runner; this fixture
 * records only the values that must survive the daemon process boundary.
 */
function makeObservedOpenClawAccountRuntime(
  fixture: OpenClawRuntimeFixture,
): ObservedOpenClawAccountRuntime {
  const recordInboundSession = (input: OpenClawRecordInput) => {
    expect(input.sessionKey).toBe(OPENCLAW_MAIN_SESSION_KEY);
    fixture.sessions.acceptMessage(input.sessionKey, input.ctx.MessageSid);
    return Promise.resolve();
  };
  const dispatchReplyWithBufferedBlockDispatcher = (
    input: OpenClawReplyDispatcherInput,
  ) => dispatchOpenClawReply(input, fixture);
  return {
    channel: {
      runtimeContexts: {},
      inbound: {
        buildContext: buildOpenClawContext,
        run: (input) => {
          const ingested = input.adapter.ingest();
          expect(ingested.id).toBe(input.raw.message.postId);
          expect(ingested.raw).toEqual(input.raw.message);
          const turn = input.adapter.resolveTurn();
          expect(turn.route).toEqual({
            agentId: "primary",
            sessionKey: OPENCLAW_MAIN_SESSION_KEY,
          });
          expect(turn.record?.updateLastRoute).toEqual({
            sessionKey: OPENCLAW_MAIN_SESSION_KEY,
            channel: "moltzap",
            to: fixture.callerAddress,
            accountId: OPENCLAW_ACCOUNT_ID,
          });
          expect("routeSessionKey" in turn).toBe(false);
          expect("storePath" in turn).toBe(false);
          expect("recordInboundSession" in turn).toBe(false);
          expect("dispatchReplyWithBufferedBlockDispatcher" in turn).toBe(
            false,
          );
          return Promise.resolve(
            recordInboundSession({
              ctx: turn.ctxPayload,
              sessionKey: turn.route.sessionKey,
              storePath: turn.cfg.session.store,
            }),
          ).then(() =>
            dispatchReplyWithBufferedBlockDispatcher({
              ctx: turn.ctxPayload,
              dispatcherOptions: turn.delivery,
              ...(turn.replyOptions === undefined
                ? {}
                : { replyOptions: turn.replyOptions }),
            }),
          );
        },
      },
      routing: {
        resolveAgentRoute: (input) => {
          expect(input.peer).toEqual({
            kind: "direct",
            id: fixture.callerAddress,
          });
          return {
            agentId: "primary",
            channel: "moltzap",
            accountId: input.accountId ?? OPENCLAW_ACCOUNT_ID,
            sessionKey: OPENCLAW_MAIN_SESSION_KEY,
            mainSessionKey: OPENCLAW_MAIN_SESSION_KEY,
            lastRoutePolicy: "session",
            matchedBy: "default",
          };
        },
      },
    },
  };
}

function dispatchOpenClawReply(
  input: OpenClawReplyDispatcherInput,
  fixture: OpenClawReplyFixture,
): Promise<OpenClawReplyResult> {
  return Effect.runPromise(
    Effect.gen(function* () {
      expect(input.ctx.Body).toBe("hello through the real OpenClaw adapter");
      expect(input.ctx.SessionKey).toBe(OPENCLAW_MAIN_SESSION_KEY);
      const delivery = yield* effectFromPromise("OpenClaw reply delivery", () =>
        input.dispatcherOptions.deliver(
          { text: OPENCLAW_REPLY },
          { kind: "final" },
        ),
      );
      expect(delivery).toEqual({ visibleReplySent: true });
      yield* Deferred.succeed(fixture.responseSent, undefined);
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 1 },
        sourceReplyDeliveryMode: "automatic",
      };
    }),
  );
}

function isStableOpenClawChannelPlugin(
  value: object,
): value is StableOpenClawChannelPlugin {
  if (
    !("gateway" in value) ||
    typeof value.gateway !== "object" ||
    value.gateway === null ||
    !("startAccount" in value.gateway) ||
    typeof value.gateway.startAccount !== "function"
  ) {
    return false;
  }
  return (
    "message" in value &&
    typeof value.message === "object" &&
    value.message !== null &&
    "send" in value.message &&
    typeof value.message.send === "object" &&
    value.message.send !== null &&
    "text" in value.message.send &&
    typeof value.message.send.text === "function"
  );
}

function registerOpenClawChannel(): Effect.Effect<
  StableOpenClawChannelPlugin,
  ProcessTestError
> {
  return Effect.try({
    try: () => {
      let registered: StableOpenClawChannelPlugin | null = null;
      const api: StableOpenClawPluginApi = {
        runtime: {},
        registerChannel(registration) {
          if (
            !("plugin" in registration) ||
            typeof registration.plugin !== "object" ||
            registration.plugin === null ||
            !isStableOpenClawChannelPlugin(registration.plugin)
          ) {
            throw new ProcessTestError({
              message: "OpenClaw registered an invalid channel plugin",
            });
          }
          registered = registration.plugin;
        },
      };
      if (!isStableOpenClawEntry(openClawPlugin)) {
        throw new ProcessTestError({
          message: "OpenClaw loader entry has no registration hook",
        });
      }
      openClawPlugin.register(api);
      if (registered === null) {
        throw new ProcessTestError({
          message: "OpenClaw did not register the MoltZap channel",
        });
      }
      return registered;
    },
    catch: (cause) =>
      new ProcessTestError({
        message: "OpenClaw channel registration failed",
        cause,
      }),
  });
}

function openClawConfig(stateDirectory: string): OpenClawConfig {
  return {
    channels: {
      moltzap: {
        accounts: [{ id: OPENCLAW_ACCOUNT_ID }],
      },
    },
    session: { store: stateDirectory },
  };
}

function runOpenClawScenario() {
  return Effect.scoped(
    Effect.gen(function* () {
      const scenario = yield* acquireScenario("openclaw");
      const caller = yield* acquireHarnessEndpoint(scenario.caller.endpoint);
      const callerAddress = directAddress(scenario.caller.agentName);
      const targetAddress = directAddress(scenario.target.agentName);
      const initial = textContent("hello through the real OpenClaw adapter");
      const reply = textContent(OPENCLAW_REPLY);
      const responseSent = yield* Deferred.make<void>();
      const connected = yield* Deferred.make<void>();
      const sessions = new RecordedSessionStore();
      const cfg = openClawConfig(scenario.target.stateDirectory);
      let channelPlugin: StableOpenClawChannelPlugin | null = null;
      const runtime = makeObservedOpenClawAccountRuntime({
        callerAddress,
        responseSent,
        sessions,
      });
      channelPlugin = yield* registerOpenClawChannel();

      const previousEndpoint = process.env.MOLTZAP_MCP_URL;
      process.env.MOLTZAP_MCP_URL = scenario.target.endpoint.href;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousEndpoint === undefined) {
            Reflect.deleteProperty(process.env, "MOLTZAP_MCP_URL");
          } else {
            process.env.MOLTZAP_MCP_URL = previousEndpoint;
          }
        }),
      );

      const abortController = new AbortController();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          abortController.abort();
        }),
      );
      let status: OpenClawGatewayStatus = {
        accountId: OPENCLAW_ACCOUNT_ID,
      };
      const gatewayContext: OpenClawGatewayContext = {
        cfg,
        accountId: OPENCLAW_ACCOUNT_ID,
        account: { id: OPENCLAW_ACCOUNT_ID },
        abortSignal: abortController.signal,
        runtime: {
          log: () => {},
          error: () => {},
          exit: () => {},
        },
        channelRuntime: runtime.channel,
        getStatus: () => status,
        setStatus: (next) => {
          status = next;
          if (next.connected === true) {
            Effect.runSync(Deferred.succeed(connected, undefined));
          }
        },
      };
      const runningGateway = yield* effectFromPromise(
        "OpenClaw gateway start",
        () => channelPlugin.gateway.startAccount(gatewayContext),
      ).pipe(Effect.forkScoped);
      yield* awaitSignal(connected, "OpenClaw gateway connection");

      const callerDelivery = yield* Effect.forkScoped(
        nextDelivery(caller.messages),
      );
      yield* caller.send({
        to: targetAddress,
        content: initial,
      });
      yield* Effect.raceFirst(
        awaitSignal(responseSent, "OpenClaw channel reply"),
        Fiber.join(runningGateway).pipe(
          Effect.zipRight(
            Effect.fail(
              new ProcessTestError({
                message: "OpenClaw account stopped before its channel reply",
              }),
            ),
          ),
        ),
      );
      const returned = yield* Fiber.join(callerDelivery);
      expect(returned.message).toMatchObject({
        kind: "direct",
        address: targetAddress,
        sender: targetAddress,
        content: reply,
      });
      yield* returned.acknowledge;

      abortController.abort();
      yield* Fiber.join(runningGateway).pipe(
        Effect.timeoutFail({
          duration: DELIVERY_TIMEOUT,
          onTimeout: () =>
            new ProcessTestError({
              message: "timed out stopping OpenClaw gateway",
            }),
        }),
      );

      const session = sessions.snapshot(OPENCLAW_MAIN_SESSION_KEY);
      expect(sessions.keys()).toEqual([OPENCLAW_MAIN_SESSION_KEY]);
      expect(session.messageIds).toHaveLength(1);
      yield* assertDurableExchange(scenario, initial, [reply]);
    }),
  );
}

function runNanoClawScenario() {
  return Effect.scoped(
    Effect.gen(function* () {
      const scenario = yield* acquireScenario("nanoclaw");
      const caller = yield* acquireHarnessEndpoint(scenario.caller.endpoint);
      const target = yield* acquireHarnessEndpoint(scenario.target.endpoint);
      const callerAddress = directAddress(scenario.caller.agentName);
      const targetAddress = directAddress(scenario.target.agentName);
      const initial = textContent("hello through the real NanoClaw adapter");
      const reply = textContent(NANOCLAW_REPLY);
      const inboundAccepted = yield* Deferred.make<void>();
      const inbound: NanoClawInboundProjection[] = [];
      const metadata = new Map<
        string,
        {
          readonly name: string | undefined;
          readonly isGroup: boolean | undefined;
        }
      >();
      const adapter = MoltZapAdapter.fromEndpoint(target);
      yield* Effect.acquireRelease(
        effectFromPromise("NanoClaw setup", () =>
          adapter.setup({
            onMetadata: (platformId, name, isGroup) => {
              metadata.set(platformId, { name, isGroup });
            },
            onInbound: (platformId, threadId, message) => {
              const content = Schema.decodeUnknownSync(
                nanoInboundContentSchema,
              )(message.content);
              expect(metadata.get(platformId)).toEqual({
                name: platformId,
                isGroup: false,
              });
              inbound.push({
                id: message.id,
                platformId,
                threadId,
                content,
                isGroup: message.isGroup === true,
              });
              Effect.runSync(Deferred.succeed(inboundAccepted, undefined));
              return Promise.resolve();
            },
            onInboundEvent: () => {},
            onAction: () => {},
          }),
        ),
        () =>
          effectFromPromise("NanoClaw teardown", () => adapter.teardown()).pipe(
            Effect.ignore,
          ),
      );
      expect(adapter.isConnected()).toBe(true);

      const callerDelivery = yield* Effect.forkScoped(
        nextDelivery(caller.messages),
      );
      yield* caller.send({
        to: targetAddress,
        content: initial,
      });
      yield* awaitSignal(inboundAccepted, "NanoClaw inbound callback");
      expect(inbound).toEqual([
        expect.objectContaining({
          platformId: callerAddress,
          threadId: null,
          content: {
            text: "hello through the real NanoClaw adapter",
            address: callerAddress,
            sender: callerAddress,
            senderId: callerAddress,
          },
          isGroup: false,
        }),
      ]);
      const outboundMessage = {
        kind: "chat",
        content: { text: NANOCLAW_REPLY },
      };
      yield* effectFromPromise("NanoClaw native message", () =>
        adapter.deliver(callerAddress, null, outboundMessage),
      );
      yield* effectFromPromise("NanoClaw repeated native message", () =>
        adapter.deliver(callerAddress, null, outboundMessage),
      );

      const returned = yield* Fiber.join(callerDelivery);
      expect(returned.message).toMatchObject({
        kind: "direct",
        address: targetAddress,
        sender: targetAddress,
        content: reply,
      });
      yield* returned.acknowledge;
      yield* assertDurableExchange(scenario, initial, [reply, reply]);
    }),
  );
}

it("keeps host identities local while repeated adapter calls create separate posts", () => {
  expect.hasAssertions();
  return Effect.runPromise(
    Effect.zipRight(runOpenClawScenario(), runNanoClawScenario()),
  );
}, 300_000);
