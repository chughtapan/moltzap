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
import { isDeepStrictEqual } from "node:util";
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
const OPENCLAW_OUTBOX_ID = "openclaw-messages-out-1";
const OPENCLAW_REPLY = "reply from the real OpenClaw adapter";
const NANOCLAW_REPLY = "reply from the real NanoClaw adapter";

interface Scenario {
  readonly caller: DaemonProcessFixture;
  readonly target: DaemonProcessFixture;
}

interface DurableOutboundRow {
  readonly id: string;
  readonly text: string;
  readonly to: string;
}

class DurableNativeOutbox {
  private readonly rowsById = new Map<string, DurableOutboundRow>();

  insert(row: DurableOutboundRow): void {
    const existing = this.rowsById.get(row.id);
    if (existing !== undefined && !isDeepStrictEqual(existing, row)) {
      throw new ProcessTestError({
        message: `native outbox identity ${row.id} has conflicting content`,
      });
    }
    this.rowsById.set(row.id, row);
  }

  rows(): readonly DurableOutboundRow[] {
    return [...this.rowsById.values()];
  }
}

interface NativeSessionSnapshot {
  readonly messageIds: readonly string[];
  readonly privateFinals: readonly string[];
}

class NativeSessionStore {
  private readonly messagesBySession = new Map<string, string[]>();
  private readonly privateFinalsBySession = new Map<string, string[]>();

  acceptMessage(sessionKey: string, messageId: string): void {
    const messageIds = this.messagesBySession.get(sessionKey) ?? [];
    if (!messageIds.includes(messageId)) {
      messageIds.push(messageId);
    }
    this.messagesBySession.set(sessionKey, messageIds);
  }

  recordPrivateFinal(sessionKey: string, text: string): void {
    const finals = this.privateFinalsBySession.get(sessionKey) ?? [];
    finals.push(text);
    this.privateFinalsBySession.set(sessionKey, finals);
  }

  keys(): readonly string[] {
    return [...this.messagesBySession.keys()];
  }

  snapshot(sessionKey: string): NativeSessionSnapshot {
    return {
      messageIds: [...(this.messagesBySession.get(sessionKey) ?? [])],
      privateFinals: [...(this.privateFinalsBySession.get(sessionKey) ?? [])],
    };
  }
}

interface NativeInboundPayload {
  readonly message: InboundMessage;
}

interface QueueRecordReference {
  readonly id: string;
}

interface NativeQueuePendingRecord extends QueueRecordReference {
  readonly channelId: string;
  readonly accountId: string;
  readonly queueName: string;
  readonly payload: NativeInboundPayload;
  readonly receivedAt: number;
  readonly updatedAt: number;
  readonly laneKey?: string;
  readonly attempts: number;
  readonly lastAttemptAt?: number;
  readonly lastError?: string;
}

interface NativeQueueCompletedRecord extends QueueRecordReference {
  readonly channelId: string;
  readonly accountId: string;
  readonly queueName: string;
  readonly completedAt: number;
  readonly metadata?: NativeInboundPayload;
}

interface NativeQueueFailedRecord extends QueueRecordReference {
  readonly channelId: string;
  readonly accountId: string;
  readonly queueName: string;
  readonly failedAt: number;
  readonly reason: string;
  readonly message?: string;
}

type NativeQueueEnqueueResult =
  | {
      readonly kind: "accepted";
      readonly duplicate: false;
      readonly record: NativeQueuePendingRecord;
    }
  | {
      readonly kind: "pending";
      readonly duplicate: true;
      readonly record: NativeQueuePendingRecord;
    }
  | {
      readonly kind: "completed";
      readonly duplicate: true;
      readonly record: NativeQueueCompletedRecord;
    }
  | {
      readonly kind: "failed";
      readonly duplicate: true;
      readonly record: NativeQueueFailedRecord;
    };

interface NativeQueueEnqueueOptions {
  readonly receivedAt?: number;
  readonly laneKey?: string;
}

interface NativeQueueListOptions {
  readonly limit?: number;
  readonly orderBy?: "id" | "receivedAt";
}

interface NativeQueueMutationOptions {
  readonly releasedAt?: number;
  readonly completedAt?: number;
  readonly failedAt?: number;
  readonly metadata?: NativeInboundPayload;
  readonly lastError?: string;
  readonly message?: string;
  readonly reason?: string;
}

/** Faithful in-memory implementation of OpenClaw's durable ingress queue ABI. */
class InMemoryChannelIngressQueue {
  private readonly pending = new Map<string, NativeQueuePendingRecord>();
  private readonly completed = new Map<string, NativeQueueCompletedRecord>();
  private readonly failed = new Map<string, NativeQueueFailedRecord>();
  private readonly completedSignal: Deferred.Deferred<void>;
  private currentTime = 1;

  constructor(completedSignal: Deferred.Deferred<void>) {
    this.completedSignal = completedSignal;
  }

  pendingIds(): readonly string[] {
    return [...this.pending.keys()];
  }

  completedIds(): readonly string[] {
    return [...this.completed.keys()];
  }

  enqueue(
    id: string,
    payload: NativeInboundPayload,
    options?: NativeQueueEnqueueOptions,
  ): Promise<NativeQueueEnqueueResult> {
    const duplicate = this.duplicate(id);
    if (duplicate !== null) {
      return Promise.resolve(duplicate);
    }
    const receivedAt = options?.receivedAt ?? this.nextTime();
    const record: NativeQueuePendingRecord = {
      id,
      channelId: "openclaw-channel",
      accountId: OPENCLAW_ACCOUNT_ID,
      queueName: "default",
      payload,
      receivedAt,
      updatedAt: receivedAt,
      ...(options?.laneKey === undefined ? {} : { laneKey: options.laneKey }),
      attempts: 0,
    };
    this.pending.set(id, record);
    return Promise.resolve({ kind: "accepted", duplicate: false, record });
  }

  listPending(
    options?: NativeQueueListOptions,
  ): Promise<readonly NativeQueuePendingRecord[]> {
    const records = [...this.pending.values()].sort((left, right) =>
      options?.orderBy === "id"
        ? left.id.localeCompare(right.id)
        : left.receivedAt - right.receivedAt || left.id.localeCompare(right.id),
    );
    return Promise.resolve(
      options?.limit === undefined ? records : records.slice(0, options.limit),
    );
  }

  listClaims(): Promise<readonly []> {
    const claims: readonly [] = [];
    return Promise.resolve(claims);
  }

  claimNext(): Promise<null> {
    return Promise.resolve(null);
  }

  claim(): Promise<null> {
    return Promise.resolve(null);
  }

  refreshClaim(): Promise<boolean> {
    return Promise.resolve(false);
  }

  complete(
    idOrRecord: string | QueueRecordReference,
    options?: NativeQueueMutationOptions,
  ): Promise<boolean> {
    const id = queueRecordId(idOrRecord);
    if (!this.pending.delete(id)) {
      return Promise.resolve(false);
    }
    const record: NativeQueueCompletedRecord = {
      id,
      channelId: "openclaw-channel",
      accountId: OPENCLAW_ACCOUNT_ID,
      queueName: "default",
      completedAt: options?.completedAt ?? this.nextTime(),
      ...(options?.metadata === undefined
        ? {}
        : { metadata: options.metadata }),
    };
    this.completed.set(id, record);
    Effect.runSync(Deferred.succeed(this.completedSignal, undefined));
    return Promise.resolve(true);
  }

  release(
    idOrRecord: string | QueueRecordReference,
    options?: NativeQueueMutationOptions,
  ): Promise<boolean> {
    const id = queueRecordId(idOrRecord);
    const record = this.pending.get(id);
    if (record === undefined) {
      return Promise.resolve(false);
    }
    const releasedAt = options?.releasedAt ?? this.nextTime();
    this.pending.set(id, {
      ...record,
      updatedAt: releasedAt,
      attempts: record.attempts + 1,
      lastAttemptAt: releasedAt,
      ...(options?.lastError === undefined
        ? {}
        : { lastError: options.lastError }),
    });
    return Promise.resolve(true);
  }

  fail(
    idOrRecord: string | QueueRecordReference,
    options: NativeQueueMutationOptions,
  ): Promise<boolean> {
    const id = queueRecordId(idOrRecord);
    if (!this.pending.delete(id)) {
      return Promise.resolve(false);
    }
    const record: NativeQueueFailedRecord = {
      id,
      channelId: "openclaw-channel",
      accountId: OPENCLAW_ACCOUNT_ID,
      queueName: "default",
      failedAt: options.failedAt ?? this.nextTime(),
      reason: options.reason ?? "native ingress failed",
      ...(options.message === undefined ? {} : { message: options.message }),
    };
    this.failed.set(id, record);
    return Promise.resolve(true);
  }

  delete(idOrRecord: string | QueueRecordReference): Promise<boolean> {
    const id = queueRecordId(idOrRecord);
    const removedPending = this.pending.delete(id);
    const removedCompleted = this.completed.delete(id);
    const removedFailed = this.failed.delete(id);
    return Promise.resolve(removedPending || removedCompleted || removedFailed);
  }

  recoverStaleClaims(): Promise<number> {
    return Promise.resolve(0);
  }

  prune(): Promise<number> {
    return Promise.resolve(0);
  }

  private duplicate(id: string): NativeQueueEnqueueResult | null {
    const completed = this.completed.get(id);
    if (completed !== undefined) {
      return { kind: "completed", duplicate: true, record: completed };
    }
    const failed = this.failed.get(id);
    if (failed !== undefined) {
      return { kind: "failed", duplicate: true, record: failed };
    }
    const pending = this.pending.get(id);
    if (pending !== undefined) {
      return { kind: "pending", duplicate: true, record: pending };
    }
    return null;
  }

  private nextTime(): number {
    const now = this.currentTime;
    this.currentTime += 1;
    return now;
  }
}

interface OpenClawConfig {
  readonly channels: {
    readonly moltzap: {
      readonly accounts: readonly [
        {
          readonly id: string;
          readonly mode: "shared";
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

interface OpenClawPrivateDeliveryResult {
  readonly visibleReplySent: false;
}

interface OpenClawReplyDispatcherInput {
  readonly ctx: OpenClawInboundContext;
  readonly dispatcherOptions: {
    readonly deliver: (
      payload: { readonly text: string },
      context: { readonly kind: "final" },
    ) => Promise<OpenClawPrivateDeliveryResult>;
  };
  readonly replyOptions: {
    readonly sourceReplyDeliveryMode: "message_tool_only";
  };
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
  readonly routeSessionKey: string;
  readonly storePath: string;
  readonly ctxPayload: OpenClawInboundContext;
  readonly recordInboundSession: (
    input: OpenClawRecordInput,
  ) => Promise<object | void>;
  readonly dispatchReplyWithBufferedBlockDispatcher: (
    input: OpenClawReplyDispatcherInput,
  ) => Promise<OpenClawReplyResult>;
  readonly delivery: OpenClawReplyDispatcherInput["dispatcherOptions"];
  readonly replyOptions: OpenClawReplyDispatcherInput["replyOptions"];
}

interface OpenClawInboundRunnerInput {
  readonly channel: string;
  readonly accountId: string;
  readonly raw: NativeInboundPayload;
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

interface StableOpenClawRuntime {
  readonly channel: {
    readonly inbound: {
      readonly buildContext: (
        input: OpenClawBuildContextInput,
      ) => OpenClawInboundContext;
      readonly run: (input: OpenClawInboundRunnerInput) => Promise<object>;
    };
    readonly reply: {
      readonly dispatchReplyWithBufferedBlockDispatcher: (
        input: OpenClawReplyDispatcherInput,
      ) => Promise<OpenClawReplyResult>;
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
    readonly session: {
      readonly recordInboundSession: (
        input: OpenClawRecordInput,
      ) => Promise<object | void>;
    };
  };
  readonly state: {
    readonly openChannelIngressQueue: (input: {
      readonly accountId: string;
    }) => object;
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
  readonly account: { readonly id: string; readonly mode: "shared" };
  readonly abortSignal: AbortSignal;
  readonly runtime: {
    readonly log: (message: string) => void;
    readonly error: (message: string) => void;
    readonly exit: (code: number) => void;
  };
  readonly getStatus: () => OpenClawGatewayStatus;
  readonly setStatus: (status: OpenClawGatewayStatus) => void;
}

interface OpenClawMessageSendContext {
  readonly cfg: OpenClawConfig;
  readonly accountId: string;
  readonly to: string;
  readonly text: string;
  readonly deliveryQueueId: string;
}

interface OpenClawMessageSendResult {
  readonly channel: string;
  readonly messageId?: string;
}

interface StableOpenClawChannelPlugin {
  readonly gateway: {
    readonly startAccount: (context: OpenClawGatewayContext) => Promise<void>;
    readonly stopAccount: (context: {
      readonly accountId: string;
    }) => Promise<void>;
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

interface OpenClawReplyFixture {
  readonly callerAddress: string;
  readonly channelPlugin: () => StableOpenClawChannelPlugin;
  readonly cfg: OpenClawConfig;
  readonly outbox: DurableNativeOutbox;
  readonly responseSent: Deferred.Deferred<void>;
  readonly sessions: NativeSessionStore;
}

interface OpenClawRuntimeFixture extends OpenClawReplyFixture {
  readonly ingressQueue: InMemoryChannelIngressQueue;
}

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

function queueRecordId(value: string | QueueRecordReference): string {
  return typeof value === "string" ? value : value.id;
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

function makeOpenClawRuntime(
  fixture: OpenClawRuntimeFixture,
): StableOpenClawRuntime {
  const recordInboundSession = (input: OpenClawRecordInput) => {
    expect(fixture.ingressQueue.pendingIds()).toContain(input.ctx.MessageSid);
    expect(input.sessionKey).toBe(OPENCLAW_MAIN_SESSION_KEY);
    fixture.sessions.acceptMessage(input.sessionKey, input.ctx.MessageSid);
    return Promise.resolve();
  };
  const dispatchReplyWithBufferedBlockDispatcher = (
    input: OpenClawReplyDispatcherInput,
  ) => dispatchOpenClawReply(input, fixture);
  return {
    channel: {
      inbound: {
        buildContext: buildOpenClawContext,
        run: (input) => {
          const ingested = input.adapter.ingest();
          expect(ingested.id).toBe(input.raw.message.postId);
          expect(ingested.raw).toEqual(input.raw.message);
          const turn = input.adapter.resolveTurn();
          return Promise.resolve(
            turn.recordInboundSession({
              ctx: turn.ctxPayload,
              sessionKey: turn.routeSessionKey,
              storePath: turn.storePath,
            }),
          ).then(() =>
            turn.dispatchReplyWithBufferedBlockDispatcher({
              ctx: turn.ctxPayload,
              dispatcherOptions: turn.delivery,
              replyOptions: turn.replyOptions,
            }),
          );
        },
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher },
      routing: {
        resolveAgentRoute: (input) => {
          expect(input.peer).toBeUndefined();
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
      session: { recordInboundSession },
    },
    state: {
      openChannelIngressQueue: () => fixture.ingressQueue,
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
      const privateDelivery = yield* effectFromPromise(
        "OpenClaw private final",
        () =>
          input.dispatcherOptions.deliver(
            { text: "private OpenClaw final" },
            { kind: "final" },
          ),
      );
      expect(privateDelivery).toEqual({ visibleReplySent: false });
      fixture.sessions.recordPrivateFinal(
        OPENCLAW_MAIN_SESSION_KEY,
        "private OpenClaw final",
      );
      expect(fixture.outbox.rows()).toEqual([]);

      const row: DurableOutboundRow = {
        id: OPENCLAW_OUTBOX_ID,
        text: OPENCLAW_REPLY,
        to: fixture.callerAddress,
      };
      fixture.outbox.insert(row);
      const sendContext: OpenClawMessageSendContext = {
        cfg: fixture.cfg,
        accountId: OPENCLAW_ACCOUNT_ID,
        to: row.to,
        text: row.text,
        deliveryQueueId: row.id,
      };
      const first = yield* effectFromPromise("OpenClaw native message", () =>
        fixture.channelPlugin().message.send.text(sendContext),
      );
      const repeated = yield* effectFromPromise(
        "OpenClaw repeated native message",
        () => fixture.channelPlugin().message.send.text(sendContext),
      );
      expect(first.messageId).toBe(OPENCLAW_OUTBOX_ID);
      expect(repeated.messageId).toBe(OPENCLAW_OUTBOX_ID);
      yield* Deferred.succeed(fixture.responseSent, undefined);
      return {
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
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
    typeof value.gateway.startAccount !== "function" ||
    !("stopAccount" in value.gateway) ||
    typeof value.gateway.stopAccount !== "function"
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

function registerOpenClawChannel(
  runtime: StableOpenClawRuntime,
): Effect.Effect<StableOpenClawChannelPlugin, ProcessTestError> {
  return Effect.try({
    try: () => {
      let registered: StableOpenClawChannelPlugin | null = null;
      const api: StableOpenClawPluginApi = {
        runtime,
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
      const entry: StableOpenClawEntry = openClawPlugin;
      entry.register(api);
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
        accounts: [{ id: OPENCLAW_ACCOUNT_ID, mode: "shared" }],
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
      const inboundCompleted = yield* Deferred.make<void>();
      const connected = yield* Deferred.make<void>();
      const ingressQueue = new InMemoryChannelIngressQueue(inboundCompleted);
      const outbox = new DurableNativeOutbox();
      const sessions = new NativeSessionStore();
      const cfg = openClawConfig(scenario.target.stateDirectory);
      let channelPlugin: StableOpenClawChannelPlugin | null = null;
      const runtime = makeOpenClawRuntime({
        callerAddress,
        channelPlugin: () => {
          if (channelPlugin === null) {
            throw new ProcessTestError({
              message: "OpenClaw channel is unavailable",
            });
          }
          return channelPlugin;
        },
        cfg,
        ingressQueue,
        outbox,
        responseSent,
        sessions,
      });
      channelPlugin = yield* registerOpenClawChannel(runtime);

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
        account: { id: OPENCLAW_ACCOUNT_ID, mode: "shared" },
        abortSignal: abortController.signal,
        runtime: {
          log: () => {},
          error: () => {},
          exit: () => {},
        },
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
        awaitSignal(responseSent, "OpenClaw native response"),
        Fiber.join(runningGateway).pipe(
          Effect.zipRight(
            Effect.fail(
              new ProcessTestError({
                message: "OpenClaw gateway stopped before its native response",
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
      yield* awaitSignal(inboundCompleted, "OpenClaw journal completion");

      yield* effectFromPromise("OpenClaw gateway stop", () =>
        channelPlugin.gateway.stopAccount({ accountId: OPENCLAW_ACCOUNT_ID }),
      );
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
      expect(session.privateFinals).toEqual(["private OpenClaw final"]);
      expect(ingressQueue.pendingIds()).toEqual([]);
      expect(ingressQueue.completedIds()).toEqual(session.messageIds);
      expect(outbox.rows()).toEqual([
        {
          id: OPENCLAW_OUTBOX_ID,
          text: OPENCLAW_REPLY,
          to: callerAddress,
        },
      ]);
      yield* assertDurableExchange(scenario, initial, [reply, reply]);
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
