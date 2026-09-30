/** @file Real-daemon acceptance for the runtime adapter boundaries. */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  acquireHarnessEndpoint,
  AgentAddress,
  type Content,
  GroupAddress,
  type InboundDelivery,
  type InboundItem,
} from "@moltzap/client";
import openClawPlugin from "@moltzap/openclaw-channel";
import {
  Chunk,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Queue,
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
const NANOCLAW_DIRECT_REPLY = "direct from NanoClaw send_message";
const NANOCLAW_GROUP_REPLY = "group from NanoClaw final output";
const NANOCLAW_INBOUND = "hello through the native NanoClaw inbox";
const executeFile = promisify(execFile);
const nanoClawBuildResultPath = fileURLToPath(
  new URL("../../.moltzap/agent-images/nanoclaw.json", import.meta.url),
);
const nanoClawProbePath = fileURLToPath(
  new URL("nanoclaw-addressed-send-probe.mjs", import.meta.url),
);

interface Scenario {
  readonly caller: DaemonProcessFixture;
  readonly target: DaemonProcessFixture;
}

interface GroupScenario extends Scenario {
  readonly peer: DaemonProcessFixture;
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
  readonly sourceReplyDeliveryMode: "message_tool_only";
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

/** The plugin's host turn, as far as this test reads it. */
interface OpenClawHostTurn {
  readonly id: string;
}

interface OpenClawInboundRunnerInput {
  readonly channel: string;
  readonly accountId: string;
  readonly raw: { readonly turn: OpenClawHostTurn };
  readonly adapter: {
    readonly ingest: () => {
      readonly id: string;
      readonly rawText: string;
      readonly textForAgent: string;
      readonly textForCommands: string;
      readonly raw: OpenClawHostTurn;
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

interface OpenClawMessageActionContext {
  readonly channel: string;
  readonly action: "send";
  readonly cfg: OpenClawConfig;
  readonly accountId: string;
  readonly params: {
    readonly to: string;
    readonly message: string;
    readonly collective?: object;
    readonly collectiveResponse?: object;
  };
}

interface OpenClawMessageActionResult {
  readonly details: unknown;
}

interface StableOpenClawChannelPlugin {
  readonly gateway: {
    readonly startAccount: (context: OpenClawGatewayContext) => Promise<void>;
  };
  readonly actions: {
    readonly handleAction: (
      context: OpenClawMessageActionContext,
    ) => Promise<OpenClawMessageActionResult>;
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
  readonly callerId: string;
  readonly responseSent: Deferred.Deferred<void>;
  readonly sessions: RecordedSessionStore;
  /** The plugin's `message` tool path, the only way a reply becomes a post. */
  readonly sendReply: () => Promise<OpenClawMessageActionResult>;
}

type OpenClawRuntimeFixture = OpenClawReplyFixture;

/** The certified content of one multicast: its text, then its operation part. */
function multicastContent(text: string): Content {
  return [
    { type: "text", text },
    {
      type: "data",
      value: {
        "xyz.moltzap/collective": { kind: "operation", op: "multicast" },
      },
    },
  ];
}

function directAddress(agentName: string) {
  return Schema.decodeUnknownSync(AgentAddress)(`agent:${agentName}`);
}

function groupAddress(agentNames: readonly string[]) {
  return Schema.decodeUnknownSync(GroupAddress)(
    `group:${[...agentNames].sort().join(",")}`,
  );
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

function nextDeliveries<E>(
  stream: Stream.Stream<InboundDelivery, E>,
  count: number,
) {
  return stream.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
    Effect.timeoutFail({
      duration: DELIVERY_TIMEOUT,
      onTimeout: () =>
        new ProcessTestError({
          message: `timed out awaiting ${String(count)} addressed deliveries`,
        }),
    }),
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

function acquireGroupScenario(
  prefix: string,
): Effect.Effect<GroupScenario, ProcessTestError, Scope.Scope> {
  return Effect.gen(function* () {
    const infrastructure = yield* acquireProcessInfrastructure;
    const [caller, target, peer] = yield* Effect.all(
      [
        makeDaemonProcessFixture(infrastructure, `${prefix}-caller`),
        makeDaemonProcessFixture(infrastructure, `${prefix}-target`),
        makeDaemonProcessFixture(infrastructure, `${prefix}-peer`),
      ] as const,
      { concurrency: 3 },
    );
    yield* Effect.all(
      [
        acquireDaemonProcess(caller),
        acquireDaemonProcess(target),
        acquireDaemonProcess(peer),
      ] as const,
      { concurrency: 3 },
    );
    yield* Effect.all(
      [registerFixture(caller), registerFixture(target), registerFixture(peer)],
      { concurrency: 3, discard: true },
    );
    return { caller, target, peer };
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
          expect(ingested.id).toBe(input.raw.turn.id);
          expect(ingested.raw).toEqual(input.raw.turn);
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
            id: fixture.callerId,
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
      const sent = yield* effectFromPromise("OpenClaw message tool send", () =>
        fixture.sendReply(),
      );
      expect(sent.details).toEqual({ ok: true, to: fixture.callerAddress });
      const delivery = yield* effectFromPromise("OpenClaw reply delivery", () =>
        input.dispatcherOptions.deliver(
          { text: "private final text" },
          { kind: "final" },
        ),
      );
      expect(delivery).toEqual({ visibleReplySent: false });
      yield* Deferred.succeed(fixture.responseSent, undefined);
      return {
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 1 },
        sourceReplyDeliveryMode: "message_tool_only",
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
    "actions" in value &&
    typeof value.actions === "object" &&
    value.actions !== null &&
    "handleAction" in value.actions &&
    typeof value.actions.handleAction === "function"
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

/**
 * Start the registered plugin's account against one daemon, with OpenClaw's
 * gateway context, and wait until it reports connected.
 */
function startOpenClawGateway(
  target: DaemonProcessFixture,
  channelPlugin: StableOpenClawChannelPlugin,
  runtime: ObservedOpenClawAccountRuntime,
) {
  return Effect.gen(function* () {
    const cfg = openClawConfig(target.stateDirectory);
    const connected = yield* Deferred.make<void>();
    const previousEndpoint = process.env.MOLTZAP_MCP_URL;
    process.env.MOLTZAP_MCP_URL = target.endpoint.href;

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
    return { abortController, runningGateway };
  });
}

function runOpenClawScenario() {
  return Effect.scoped(
    Effect.gen(function* () {
      const scenario = yield* acquireScenario("openclaw");
      const caller = yield* acquireHarnessEndpoint(scenario.caller.endpoint);
      const callerAddress = directAddress(scenario.caller.agentName);
      const targetAddress = directAddress(scenario.target.agentName);
      const initialText = "hello through the real OpenClaw adapter";
      const initial = multicastContent(initialText);
      const reply = multicastContent(OPENCLAW_REPLY);
      const responseSent = yield* Deferred.make<void>();
      const sessions = new RecordedSessionStore();
      const cfg = openClawConfig(scenario.target.stateDirectory);
      const channelPlugin = yield* registerOpenClawChannel();
      const runtime = makeObservedOpenClawAccountRuntime({
        callerAddress,
        callerId: scenario.caller.agentName,
        responseSent,
        sessions,
        sendReply: () =>
          channelPlugin.actions.handleAction({
            channel: "moltzap",
            action: "send",
            cfg,
            accountId: OPENCLAW_ACCOUNT_ID,
            params: { to: callerAddress, message: OPENCLAW_REPLY },
          }),
      });

      const { abortController, runningGateway } = yield* startOpenClawGateway(
        scenario.target,
        channelPlugin,
        runtime,
      );

      const callerDelivery = yield* Effect.forkScoped(
        nextDelivery(caller.messages),
      );
      yield* caller.send({ to: targetAddress, text: initialText });
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
      expect(returned.item).toMatchObject({
        kind: "multicast",
        message: {
          kind: "direct",
          address: targetAddress,
          sender: targetAddress,
          content: [{ type: "text", text: OPENCLAW_REPLY }],
        },
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

const SLOT_SCHEMA = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
} as const;
const GATHER_QUESTION = "Which day works?";

/**
 * An account runtime that hands every rendered turn to the test, standing in
 * for the model that reads it, and completes the turn at once.
 */
function makeTurnQueueRuntime(
  turns: Queue.Queue<OpenClawInboundContext>,
): ObservedOpenClawAccountRuntime {
  return {
    channel: {
      runtimeContexts: {},
      inbound: {
        buildContext: buildOpenClawContext,
        run: (input) =>
          Effect.runPromise(
            Queue.offer(turns, input.adapter.resolveTurn().ctxPayload).pipe(
              Effect.as({}),
            ),
          ),
      },
      routing: {
        resolveAgentRoute: (input) => ({
          agentId: "primary",
          channel: "moltzap",
          accountId: input.accountId ?? OPENCLAW_ACCOUNT_ID,
          sessionKey: OPENCLAW_MAIN_SESSION_KEY,
          mainSessionKey: OPENCLAW_MAIN_SESSION_KEY,
          lastRoutePolicy: "session",
          matchedBy: "default",
        }),
      },
    },
  };
}

function nextTurn(turns: Queue.Queue<OpenClawInboundContext>) {
  return Queue.take(turns).pipe(
    Effect.timeoutFail({
      duration: DELIVERY_TIMEOUT,
      onTimeout: () =>
        new ProcessTestError({
          message: "timed out awaiting an OpenClaw turn",
        }),
    }),
  );
}

function nextItem<E>(stream: Stream.Stream<InboundDelivery, E>) {
  return nextDelivery(stream).pipe(
    Effect.tap((delivery) => delivery.acknowledge),
    Effect.map((delivery): InboundItem => delivery.item),
  );
}

function requireRequest(item: InboundItem) {
  return item.kind === "collectiveRequest"
    ? Effect.succeed(item)
    : Effect.fail(
        new ProcessTestError({
          message: `expected a collective request, received ${item.kind}`,
        }),
      );
}

/** The request id a model reads from a rendered collective request turn. */
function requestIdOf(body: string): string {
  return /collective request (col_[\w-]+) from/u.exec(body)?.[1] ?? "";
}

function runOpenClawGatherScenario() {
  return Effect.scoped(
    Effect.gen(function* () {
      const scenario = yield* acquireScenario("openclaw-gather");
      const caller = yield* acquireHarnessEndpoint(scenario.caller.endpoint);
      const callerAddress = directAddress(scenario.caller.agentName);
      const targetAddress = directAddress(scenario.target.agentName);
      const cfg = openClawConfig(scenario.target.stateDirectory);
      const channelPlugin = yield* registerOpenClawChannel();
      const turns = yield* Queue.unbounded<OpenClawInboundContext>();
      const { abortController, runningGateway } = yield* startOpenClawGateway(
        scenario.target,
        channelPlugin,
        makeTurnQueueRuntime(turns),
      );
      const messageTool = (params: OpenClawMessageActionContext["params"]) =>
        effectFromPromise("OpenClaw message tool send", () =>
          channelPlugin.actions.handleAction({
            channel: "moltzap",
            action: "send",
            cfg,
            accountId: OPENCLAW_ACCOUNT_ID,
            params,
          }),
        );

      const started = yield* messageTool({
        to: callerAddress,
        message: GATHER_QUESTION,
        collective: {
          op: "gather",
          deadline: 60,
          requestedSchema: SLOT_SCHEMA,
        },
      });
      const request = yield* nextItem(caller.messages).pipe(
        Effect.flatMap(requireRequest),
      );
      expect(started.details).toEqual({
        ok: true,
        to: callerAddress,
        operationId: expect.stringMatching(/^col_/u),
      });
      expect(request).toMatchObject({
        kind: "collectiveRequest",
        from: targetAddress,
        question: GATHER_QUESTION,
        requestedSchema: SLOT_SCHEMA,
      });
      yield* caller.send({
        collectiveResponse: {
          id: request.id,
          action: "accept",
          content: { slot: "mon" },
        },
      });
      const resultTurn = yield* nextTurn(turns);
      expect(resultTurn).toMatchObject({
        Body: `MoltZap collective result ${request.id} for the question sent to ${callerAddress}: ${GATHER_QUESTION}\n- ${callerAddress}: answered {"slot":"mon"}`,
        SenderName: "MoltZap collective",
      });

      yield* caller.send({
        to: targetAddress,
        text: GATHER_QUESTION,
        collective: {
          op: "gather",
          deadline: 60,
          requestedSchema: SLOT_SCHEMA,
        },
      });
      const requestTurn = yield* nextTurn(turns);
      expect(requestTurn.From).toBe(callerAddress);
      const answered = yield* messageTool({
        to: callerAddress,
        message: "answering",
        collectiveResponse: {
          id: requestIdOf(requestTurn.Body),
          action: "accept",
          content: { slot: "tue" },
        },
      });
      expect(answered.details).toMatchObject({ ok: true });
      expect(yield* nextItem(caller.messages)).toMatchObject({
        kind: "collectiveResult",
        outcomes: [
          {
            member: targetAddress,
            outcome: { kind: "answered", content: { slot: "tue" } },
          },
        ],
      });

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
    }),
  );
}

function runOpenClawAllGatherScenario() {
  return Effect.scoped(
    Effect.gen(function* () {
      const scenario = yield* acquireGroupScenario("openclaw-all-gather");
      const caller = yield* acquireHarnessEndpoint(scenario.caller.endpoint);
      const peer = yield* acquireHarnessEndpoint(scenario.peer.endpoint);
      const callerAddress = directAddress(scenario.caller.agentName);
      const peerAddress = directAddress(scenario.peer.agentName);
      const targetAddress = directAddress(scenario.target.agentName);
      const group = groupAddress([
        scenario.caller.agentName,
        scenario.peer.agentName,
        scenario.target.agentName,
      ]);
      const cfg = openClawConfig(scenario.target.stateDirectory);
      const channelPlugin = yield* registerOpenClawChannel();
      const turns = yield* Queue.unbounded<OpenClawInboundContext>();
      const { abortController, runningGateway } = yield* startOpenClawGateway(
        scenario.target,
        channelPlugin,
        makeTurnQueueRuntime(turns),
      );
      const messageTool = (params: OpenClawMessageActionContext["params"]) =>
        effectFromPromise("OpenClaw message tool send", () =>
          channelPlugin.actions.handleAction({
            channel: "moltzap",
            action: "send",
            cfg,
            accountId: OPENCLAW_ACCOUNT_ID,
            params,
          }),
        );
      const allGather = {
        op: "all_gather",
        deadline: 60,
        requestedSchema: SLOT_SCHEMA,
      } as const;

      yield* caller.send({
        to: group,
        text: GATHER_QUESTION,
        collective: allGather,
      });
      const requestTurn = yield* nextTurn(turns);
      expect(requestTurn).toMatchObject({
        ChatType: "group",
        From: callerAddress,
      });
      const peerRequest = yield* nextItem(peer.messages).pipe(
        Effect.flatMap(requireRequest),
      );
      yield* peer.send({
        collectiveResponse: { id: peerRequest.id, action: "decline" },
      });
      const answered = yield* messageTool({
        to: group,
        message: "answering",
        collectiveResponse: {
          id: requestIdOf(requestTurn.Body),
          action: "accept",
          content: { slot: "tue" },
        },
      });
      expect(answered.details).toMatchObject({ ok: true });
      const callerResult = yield* nextItem(caller.messages);
      expect(callerResult).toMatchObject({
        kind: "collectiveResult",
        id: peerRequest.id,
        to: group,
        outcomes: [
          { member: peerAddress, outcome: { kind: "declined" } },
          {
            member: targetAddress,
            outcome: { kind: "answered", content: { slot: "tue" } },
          },
        ],
      });
      expect(yield* nextItem(peer.messages)).toEqual(callerResult);
      expect(yield* nextTurn(turns)).toMatchObject({
        Body: `MoltZap collective result ${peerRequest.id} for the question sent to ${group}: ${GATHER_QUESTION}\n- ${peerAddress}: declined\n- ${targetAddress}: answered {"slot":"tue"}`,
        ChatType: "group",
        SenderName: "MoltZap collective",
      });

      const started = yield* messageTool({
        to: group,
        message: GATHER_QUESTION,
        collective: allGather,
      });
      expect(started.details).toEqual({
        ok: true,
        to: group,
        operationId: expect.stringMatching(/^col_/u),
      });
      const callerRequest = yield* nextItem(caller.messages).pipe(
        Effect.flatMap(requireRequest),
      );
      yield* nextItem(peer.messages);
      yield* caller.send({
        collectiveResponse: {
          id: callerRequest.id,
          action: "accept",
          content: { slot: "mon" },
        },
      });
      yield* peer.send({
        collectiveResponse: { id: callerRequest.id, action: "decline" },
      });
      expect(yield* nextTurn(turns)).toMatchObject({
        Body: `MoltZap collective result ${callerRequest.id} for the question sent to ${group}: ${GATHER_QUESTION}\n- ${callerAddress}: answered {"slot":"mon"}\n- ${peerAddress}: declined`,
        SenderName: "MoltZap collective",
      });
      expect(yield* nextItem(caller.messages)).toEqual(
        yield* nextItem(peer.messages),
      );

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
    }),
  );
}

function readNanoClawImage() {
  return effectFromPromise("NanoClaw build result", async () => {
    const result: unknown = JSON.parse(
      await readFile(nanoClawBuildResultPath, "utf8"),
    );
    if (
      typeof result !== "object" ||
      result === null ||
      !("image" in result) ||
      typeof result.image !== "string" ||
      result.image.length === 0
    ) {
      throw new Error("NanoClaw build result contains no image");
    }
    return result.image;
  });
}

/**
 * Run the NanoClaw probe against one daemon. Each destination is queued as
 * `send_message` tool arguments, or through the final output when it is
 * marked `final`. The probe first waits for the inbound message whose text is
 * `text`, or starts with `textPrefix`.
 */
function runNanoClawProbe(
  image: string,
  endpoint: URL,
  destinations: readonly Readonly<Record<string, unknown>>[],
  inbound: {
    readonly platformId: string;
    readonly sender: string;
  } & ({ readonly text: string } | { readonly textPrefix: string }),
) {
  return effectFromPromise("NanoClaw native host process", () =>
    executeFile(
      "docker",
      [
        "run",
        "--rm",
        "--network=host",
        "--entrypoint=node",
        "--env",
        `MOLTZAP_MCP_URL=${endpoint.href}`,
        "--env",
        `NANOCLAW_DESTINATIONS_JSON=${JSON.stringify(destinations)}`,
        "--env",
        `NANOCLAW_INBOUND_JSON=${JSON.stringify(inbound)}`,
        "--volume",
        `${nanoClawProbePath}:/tmp/nanoclaw-addressed-send-probe.mjs:ro`,
        image,
        "/tmp/nanoclaw-addressed-send-probe.mjs",
      ],
      { maxBuffer: 4 * 1024 * 1024, timeout: 180_000 },
    ),
  );
}

type TestAddress =
  | ReturnType<typeof directAddress>
  | ReturnType<typeof groupAddress>;

function assertConversationContents(
  fixture: DaemonProcessFixture,
  address: TestAddress,
  expected: readonly Content[],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      const history = yield* management.readConversation(address);
      expect(
        history.records.map(
          ({ recordCore }) => recordCore.action.postIntent.content,
        ),
      ).toEqual(expected);
    }),
  );
}

function runNanoClawScenario() {
  return Effect.scoped(
    Effect.gen(function* () {
      const scenario = yield* acquireGroupScenario("nanoclaw");
      const caller = yield* acquireHarnessEndpoint(scenario.caller.endpoint);
      const peer = yield* acquireHarnessEndpoint(scenario.peer.endpoint);
      const callerAddress = directAddress(scenario.caller.agentName);
      const targetAddress = directAddress(scenario.target.agentName);
      const sharedAddress = groupAddress([
        scenario.caller.agentName,
        scenario.target.agentName,
        scenario.peer.agentName,
      ]);
      const direct = multicastContent(NANOCLAW_DIRECT_REPLY);
      const group = multicastContent(NANOCLAW_GROUP_REPLY);
      const inbound = multicastContent(NANOCLAW_INBOUND);

      yield* caller.send({ to: targetAddress, text: NANOCLAW_INBOUND });

      const callerDeliveries = yield* Effect.forkScoped(
        nextDeliveries(caller.messages, 2),
      );
      const peerDeliveries = yield* Effect.forkScoped(
        nextDeliveries(peer.messages, 1),
      );
      const image = yield* readNanoClawImage();
      yield* runNanoClawProbe(
        image,
        scenario.target.endpoint,
        [
          { to: callerAddress, text: NANOCLAW_DIRECT_REPLY },
          { to: sharedAddress, text: NANOCLAW_GROUP_REPLY, final: true },
        ],
        {
          platformId: callerAddress,
          sender: callerAddress,
          text: NANOCLAW_INBOUND,
        },
      );

      const callerReceived = yield* Fiber.join(callerDeliveries);
      const peerReceived = yield* Fiber.join(peerDeliveries);
      expect(callerReceived).toHaveLength(2);
      expect(callerReceived.map(({ item }) => item)).toEqual(
        expect.arrayContaining([
          {
            kind: "multicast",
            message: expect.objectContaining({
              kind: "direct",
              address: targetAddress,
              sender: targetAddress,
              content: [{ type: "text", text: NANOCLAW_DIRECT_REPLY }],
            }),
          },
          {
            kind: "multicast",
            message: expect.objectContaining({
              kind: "group",
              address: sharedAddress,
              sender: targetAddress,
              content: [{ type: "text", text: NANOCLAW_GROUP_REPLY }],
            }),
          },
        ]),
      );
      expect(peerReceived.map(({ item }) => item)).toEqual([
        {
          kind: "multicast",
          message: expect.objectContaining({
            kind: "group",
            address: sharedAddress,
            sender: targetAddress,
            content: [{ type: "text", text: NANOCLAW_GROUP_REPLY }],
          }),
        },
      ]);
      yield* Effect.all(
        [...callerReceived, ...peerReceived].map(
          ({ acknowledge }) => acknowledge,
        ),
        { discard: true },
      );

      yield* Effect.all(
        [
          assertConversationContents(scenario.caller, targetAddress, [
            inbound,
            direct,
          ]),
          assertConversationContents(scenario.target, callerAddress, [
            inbound,
            direct,
          ]),
          assertConversationContents(scenario.caller, sharedAddress, [group]),
          assertConversationContents(scenario.target, sharedAddress, [group]),
          assertConversationContents(scenario.peer, sharedAddress, [group]),
        ],
        { concurrency: 5, discard: true },
      );
    }),
  );
}

function runNanoClawGatherScenario() {
  return Effect.scoped(
    Effect.gen(function* () {
      const scenario = yield* acquireScenario("nanoclaw-gather");
      const caller = yield* acquireHarnessEndpoint(scenario.caller.endpoint);
      const callerAddress = directAddress(scenario.caller.agentName);
      const targetAddress = directAddress(scenario.target.agentName);

      const started = yield* caller.send({
        to: targetAddress,
        text: GATHER_QUESTION,
        collective: {
          op: "gather",
          deadline: 120,
          requestedSchema: SLOT_SCHEMA,
        },
      });
      const id = started.operationId ?? "";
      const result = yield* Effect.forkScoped(nextItem(caller.messages));
      const image = yield* readNanoClawImage();
      yield* runNanoClawProbe(
        image,
        scenario.target.endpoint,
        [
          {
            to: callerAddress,
            text: "answering",
            collectiveResponse: {
              id,
              action: "accept",
              content: { slot: "tue" },
            },
          },
        ],
        {
          platformId: callerAddress,
          sender: callerAddress,
          textPrefix: `MoltZap collective request ${id} from ${callerAddress}`,
        },
      );

      expect(id).toMatch(/^col_/u);
      expect(yield* Fiber.join(result)).toEqual({
        kind: "collectiveResult",
        id,
        to: targetAddress,
        question: GATHER_QUESTION,
        outcomes: [
          {
            member: targetAddress,
            outcome: { kind: "answered", content: { slot: "tue" } },
          },
        ],
      });
    }),
  );
}

it("keeps OpenClaw host identities local across a durable exchange", () => {
  expect.hasAssertions();
  return Effect.runPromise(runOpenClawScenario());
}, 300_000);

it("runs a gather in both directions through the OpenClaw message tool", () => {
  expect.hasAssertions();
  return Effect.runPromise(runOpenClawGatherScenario());
}, 300_000);

it("runs an all_gather in both directions through the OpenClaw message tool", () => {
  expect.hasAssertions();
  return Effect.runPromise(runOpenClawAllGatherScenario());
}, 300_000);

it("routes NanoClaw inbound and outbound through its native host boundaries", () => {
  expect.hasAssertions();
  return Effect.runPromise(runNanoClawScenario());
}, 300_000);

it("answers a gather through NanoClaw's send_message", () => {
  expect.hasAssertions();
  return Effect.runPromise(runNanoClawGatherScenario());
}, 300_000);
