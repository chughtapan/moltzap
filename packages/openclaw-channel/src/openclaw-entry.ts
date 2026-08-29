/** @file OpenClaw host integration over the public HarnessEndpoint. */

import type {
  ChannelGatewayContext,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import {
  acquireHarnessEndpoint,
  type Content,
  type HarnessEndpoint,
  type InboundDelivery,
  InboundMessage,
  MessageAddressInput,
  type MessageAddressInput as MessageAddressInputValue,
  PostId,
  type PostId as PostIdValue,
  SendInput,
} from "@moltzap/client";
import {
  Config,
  ConfigError,
  Data,
  Deferred,
  Effect,
  JSONSchema,
  Option,
  Schema,
  Stream,
} from "effect";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type ChannelIngressQueue,
  type ChannelMessageSendResult,
  type ChannelMessageSendTextContext,
  createDurableInboundReceiveJournalFromQueue,
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type DurableInboundReceiveJournal,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

const CHANNEL_ID = "moltzap";
const TARGET_HINT =
  'Use an explicit "agent:<name>" or canonical "group:<member>,<member>,..." address';
const INBOUND_LOG_PREVIEW_CHARS = 80;

type OpenClawTargetKind = "user" | "group";
type OpenClawOutboundFailure = "invalid-native-send" | "not-connected";
type OpenClawInboundFailure =
  | "native-dispatch-failed"
  | "native-journal-failed"
  | "native-journal-unavailable"
  | "native-payload-collision"
  | "native-payload-invalid";

const nativeInboundPayloadSchema = Schema.Struct({ message: InboundMessage });
const exactSchemaOptions = {
  exact: true,
  onExcessProperty: "error",
} as const;

type NativeInboundPayload = Schema.Schema.Type<
  typeof nativeInboundPayloadSchema
>;
type NativeInboundQueue = ChannelIngressQueue<
  NativeInboundPayload,
  never,
  NativeInboundPayload
>;
type NativeInboundJournal = DurableInboundReceiveJournal<
  NativeInboundPayload,
  never,
  NativeInboundPayload
>;

interface NativeInboundPersistence {
  readonly journal: NativeInboundJournal;
  readonly queue: NativeInboundQueue;
}

interface NativeChannelRuntime {
  readonly inbound: Pick<
    PluginRuntime["channel"]["inbound"],
    "buildContext" | "run"
  >;
  readonly reply: Pick<
    PluginRuntime["channel"]["reply"],
    "dispatchReplyWithBufferedBlockDispatcher"
  >;
  readonly routing: Pick<
    PluginRuntime["channel"]["routing"],
    "resolveAgentRoute"
  >;
  readonly session: Pick<
    PluginRuntime["channel"]["session"],
    "recordInboundSession"
  >;
  readonly state: {
    readonly openChannelIngressQueue: (options: {
      readonly accountId: string;
    }) => NativeInboundQueue;
  };
}

const moltZapModeSchema = Schema.Literal("shared", "private");
const moltZapAccountSchema = Schema.Struct({
  id: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(moltZapModeSchema),
});

/** One OpenClaw account bound to the process-local MCP endpoint. */
type MoltZapAccount = Schema.Schema.Type<typeof moltZapAccountSchema>;

const moltZapChannelConfigSchema = Schema.Struct({
  accounts: Schema.optional(Schema.Array(moltZapAccountSchema)),
});
const moltZapOpenClawConfigSchema = Schema.Struct({
  channels: Schema.optional(
    Schema.Struct({ moltzap: Schema.optional(moltZapChannelConfigSchema) }),
  ),
});

interface ResolvedMessageTarget {
  readonly to: MessageAddressInputValue;
  readonly kind: OpenClawTargetKind;
  readonly display: string;
}

interface ActiveHarnessEndpoint {
  readonly endpoint: HarnessEndpoint;
  readonly stopSignal: Deferred.Deferred<undefined>;
}

interface GatewayActivation {
  readonly ctx: ChannelGatewayContext<MoltZapAccount>;
  readonly runtime: NativeChannelRuntime;
  readonly endpoint: HarnessEndpoint;
  readonly inbound: NativeInboundPersistence;
  readonly activeEndpoints: Map<string, ActiveHarnessEndpoint>;
}

interface InboundTurnProjection {
  readonly ctx: ChannelGatewayContext<MoltZapAccount>;
  readonly runtime: NativeChannelRuntime;
  readonly message: InboundDelivery["message"];
  readonly body: string;
  readonly route: ReturnType<
    NativeChannelRuntime["routing"]["resolveAgentRoute"]
  >;
  readonly routeSessionKey: string;
}

interface AddressedTextSend {
  readonly accountId?: string | null;
  readonly messageId: string;
  readonly text: string;
  readonly to: string;
}

interface MoltzapChannelPluginDeps {
  readonly harnessEndpointForAccount?: (
    accountId: string,
    account: MoltZapAccount,
  ) => HarnessEndpoint | undefined;
}

class OpenClawInboundError extends Data.TaggedError("OpenClawInboundError")<{
  readonly reason: OpenClawInboundFailure;
  readonly accountId: string;
  readonly postId?: PostIdValue;
  readonly detail: string;
}> {
  override get message(): string {
    const identity =
      this.postId === undefined
        ? this.accountId
        : `${this.accountId}/${this.postId}`;
    return `MoltZap inbound delivery failed for ${identity}: ${this.reason}: ${this.detail}`;
  }
}

class OpenClawOutboundError extends Data.TaggedError("OpenClawOutboundError")<{
  readonly reason: OpenClawOutboundFailure;
  readonly accountId: string;
}> {
  override get message(): string {
    return `MoltZap native message delivery failed for account ${this.accountId}: ${this.reason}`;
  }
}

class OpenClawConfigurationError extends Data.TaggedError(
  "OpenClawConfigurationError",
)<{
  readonly source: "MOLTZAP_MCP_URL";
  readonly detail: string;
}> {
  override get message(): string {
    return `MoltZap configuration ${this.source} is invalid: ${this.detail}`;
  }
}

const isMessageAddressInput = Schema.is(MessageAddressInput);

/**
 * Returns the manifest schema for one MoltZap channel configuration.
 * @returns The JSON Schema embedded in the OpenClaw plugin manifest.
 */
export function makeMoltZapChannelConfigJsonSchema() {
  return JSONSchema.make(moltZapChannelConfigSchema);
}

/**
 * Creates one runtime-bound OpenClaw channel plugin.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Host as OpenClaw
 *   participant Plugin as MoltZap plugin
 *   participant Client as HarnessEndpoint
 *   Host->>Plugin: start account
 *   Plugin->>Client: acquire endpoint
 *   Plugin->>Host: open native receive journal
 *   Plugin->>Host: drain pending native deliveries
 *   Client-->>Plugin: addressed delivery
 *   Plugin->>Host: accept message under PostId
 *   Plugin->>Client: acknowledge delivery
 *   Plugin->>Host: native inbound run
 *   Host->>Host: complete native journal entry
 *   Host->>Plugin: native message send
 *   Plugin->>Client: addressed content
 * ```
 * @param runtime Native host services required by the channel adapter.
 * @param deps Optional process-local dependency overrides used by tests.
 * @returns An OpenClaw channel plugin bound to the supplied host runtime.
 * @internal
 */
export function createMoltzapChannelPlugin(
  runtime: NativeChannelRuntime,
  deps: MoltzapChannelPluginDeps = {},
): ChannelPlugin<MoltZapAccount> {
  const activeEndpoints = new Map<string, ActiveHarnessEndpoint>();
  return {
    id: CHANNEL_ID,
    meta: createPluginMeta(),
    capabilities: { chatTypes: ["direct", "group"] },
    messaging: createMessagingSection(),
    config: createConfigSection(),
    gateway: {
      startAccount: (ctx) =>
        startGatewayAccount(ctx, runtime, activeEndpoints, deps),
      stopAccount: (ctx) => stopGatewayAccount(ctx, activeEndpoints),
    },
    message: createMessageSection(activeEndpoints),
  };
}

function createPluginMeta() {
  return {
    id: CHANNEL_ID,
    label: "MoltZap",
    selectionLabel: "MoltZap (agent messaging)",
    docsPath: "/channels/moltzap",
    docsLabel: "moltzap",
    blurb: "Agent-to-agent messaging through the local MoltZap endpoint.",
    detailLabel: "MoltZap",
    aliases: ["mz"],
    order: 200,
  };
}

function createMessagingSection() {
  return {
    normalizeTarget(raw: string): string | undefined {
      return normalizeMessageTarget(raw)?.to;
    },
    targetResolver: {
      looksLikeId: isCanonicalMessageTarget,
      hint: TARGET_HINT,
      resolveTarget(params: { readonly normalized: string }) {
        const target = normalizeMessageTarget(params.normalized);
        return Promise.resolve(
          target === null ? null : { ...target, source: "normalized" as const },
        );
      },
    },
  };
}

function createConfigSection() {
  return {
    listAccountIds(cfg: OpenClawConfig): string[] {
      return resolveAccountList(cfg)
        .map((account) => account.id)
        .filter((id) => id.length > 0);
    },
    resolveAccount,
    isConfigured(account: MoltZapAccount): boolean {
      return account.enabled !== false && account.id.trim().length > 0;
    },
    unconfiguredReason(): string {
      return "A nonempty MoltZap OpenClaw account id is required";
    },
    isEnabled(account: MoltZapAccount): boolean {
      return account.enabled !== false;
    },
  };
}

function createMessageSection(
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
) {
  return defineChannelMessageAdapter({
    id: CHANNEL_ID,
    send: {
      text: (ctx) => runHostPromise(sendNativeText(activeEndpoints, ctx)),
    },
  });
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): MoltZapAccount {
  if (accountId === undefined || accountId === null) {
    return { id: "", enabled: false };
  }
  return (
    resolveAccountList(cfg).find((account) => account.id === accountId) ?? {
      id: accountId,
      enabled: false,
    }
  );
}

function resolveAccountList(cfg: OpenClawConfig): readonly MoltZapAccount[] {
  return Option.match(
    Schema.decodeUnknownOption(moltZapOpenClawConfigSchema)(cfg),
    {
      onNone: () => [],
      onSome: (decoded) => decoded.channels?.moltzap?.accounts ?? [],
    },
  );
}

function isCanonicalMessageTarget(raw: string): boolean {
  const target = raw.trim();
  return normalizeMessageTarget(target)?.to === target;
}

function normalizeMessageTarget(raw: string): ResolvedMessageTarget | null {
  const target = raw.trim();
  if (!isMessageAddressInput(target)) {
    return null;
  }
  return {
    to: target,
    kind: target.startsWith("group:") ? "group" : "user",
    display: target,
  };
}

function startGatewayAccount(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: NativeChannelRuntime,
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
  deps: MoltzapChannelPluginDeps,
) {
  if (ctx.abortSignal.aborted) {
    return Promise.resolve();
  }
  return runHostPromise(
    acquireAccountEndpoint(deps, ctx.accountId, ctx.account).pipe(
      Effect.flatMap((endpoint) =>
        runGateway(ctx, runtime, endpoint, activeEndpoints),
      ),
      Effect.scoped,
    ),
  );
}

function stopGatewayAccount(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
) {
  if (activeEndpoints.has(ctx.accountId)) {
    ctx.log?.info?.("MoltZap: stopping");
  }
  return runHostPromise(
    stopActiveGatewayAccount(activeEndpoints, ctx.accountId),
  );
}

function acquireAccountEndpoint(
  deps: MoltzapChannelPluginDeps,
  accountId: string,
  account: MoltZapAccount,
) {
  const injected = deps.harnessEndpointForAccount?.(accountId, account);
  if (injected !== undefined) {
    return Effect.succeed(injected);
  }
  return configuredMcpEndpoint().pipe(Effect.flatMap(acquireHarnessEndpoint));
}

function configuredMcpEndpoint() {
  return Config.url("MOLTZAP_MCP_URL");
}

function runGateway(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: NativeChannelRuntime,
  endpoint: HarnessEndpoint,
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
) {
  return openNativeInboundPersistence(runtime, ctx.accountId).pipe(
    Effect.flatMap((inbound) =>
      activateGateway({
        ctx,
        runtime,
        endpoint,
        inbound,
        activeEndpoints,
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        ctx.setStatus({
          ...ctx.getStatus(),
          accountId: ctx.accountId,
          connected: false,
          running: false,
        });
      }),
    ),
    Effect.tapError((cause) =>
      Effect.sync(() => {
        ctx.log?.error?.(
          `MoltZap: connection failed for ${ctx.accountId}: ${String(cause)}`,
        );
      }),
    ),
  );
}

function openNativeInboundPersistence(
  runtime: NativeChannelRuntime,
  accountId: string,
): Effect.Effect<NativeInboundPersistence, OpenClawInboundError> {
  return Effect.try({
    try: () => {
      const queue = runtime.state.openChannelIngressQueue({ accountId });
      return {
        journal: createDurableInboundReceiveJournalFromQueue({ queue }),
        queue,
      };
    },
    catch: (cause) =>
      new OpenClawInboundError({
        reason: "native-journal-unavailable",
        accountId,
        detail: String(cause),
      }),
  });
}

function activateGateway(activation: GatewayActivation) {
  return Deferred.make<undefined>().pipe(
    Effect.flatMap((stopSignal) => {
      const active: ActiveHarnessEndpoint = {
        endpoint: activation.endpoint,
        stopSignal,
      };
      return runActiveGateway(activation, active).pipe(
        Effect.ensuring(
          finishActiveGatewayAccount(
            activation.activeEndpoints,
            activation.ctx.accountId,
            active,
          ),
        ),
      );
    }),
  );
}

function runActiveGateway(
  activation: GatewayActivation,
  active: ActiveHarnessEndpoint,
) {
  const { activeEndpoints, ctx, inbound, runtime } = activation;
  return stopActiveGatewayAccount(activeEndpoints, ctx.accountId).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        activeEndpoints.set(ctx.accountId, active);
      }),
    ),
    Effect.zipRight(drainPendingDeliveries(ctx, runtime, inbound)),
    Effect.zipRight(reportConnected(ctx)),
    Effect.zipRight(runGatewayMessageLoop(ctx, runtime, inbound, active)),
  );
}

function runGatewayMessageLoop(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: NativeChannelRuntime,
  inbound: NativeInboundPersistence,
  active: ActiveHarnessEndpoint,
) {
  return Effect.raceFirst(
    active.endpoint.messages.pipe(
      Stream.runForEach((delivery) =>
        handleDelivery(ctx, runtime, inbound, delivery),
      ),
    ),
    Effect.raceFirst(
      waitForAbort(ctx.abortSignal),
      Deferred.await(active.stopSignal),
    ),
  );
}

function drainPendingDeliveries(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: NativeChannelRuntime,
  inbound: NativeInboundPersistence,
): Effect.Effect<void, OpenClawInboundError> {
  return Effect.tryPromise({
    try: () => inbound.journal.pending(),
    catch: (cause) =>
      new OpenClawInboundError({
        reason: "native-journal-failed",
        accountId: ctx.accountId,
        detail: String(cause),
      }),
  }).pipe(
    Effect.flatMap((records) =>
      Effect.forEach(
        records,
        (record) =>
          decodeJournalPostId(ctx.accountId, record.id).pipe(
            Effect.flatMap((postId) =>
              decodeJournalPayload(ctx.accountId, postId, record.payload),
            ),
            Effect.flatMap((payload) =>
              dispatchJournaledPayload(ctx, runtime, inbound, payload),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
  );
}

function reportConnected(
  ctx: ChannelGatewayContext<MoltZapAccount>,
): Effect.Effect<void> {
  return Effect.sync(() => {
    ctx.log?.info?.(`MoltZap: connected for account ${ctx.accountId}`);
    ctx.setStatus({
      ...ctx.getStatus(),
      accountId: ctx.accountId,
      connected: true,
      running: true,
      lastConnectedAt: Date.now(),
    });
  });
}

function handleDelivery(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: NativeChannelRuntime,
  inbound: NativeInboundPersistence,
  delivery: InboundDelivery,
) {
  const payload: NativeInboundPayload = { message: delivery.message };
  return acceptDelivery(ctx.accountId, inbound.journal, delivery, payload).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (storedPayload) =>
          dispatchJournaledPayload(ctx, runtime, inbound, storedPayload),
      }),
    ),
  );
}

function acceptDelivery(
  accountId: string,
  journal: NativeInboundJournal,
  delivery: InboundDelivery,
  payload: NativeInboundPayload,
) {
  const postId = delivery.message.postId;
  return Effect.tryPromise({
    try: () => journal.accept(postId, payload),
    catch: (cause) =>
      new OpenClawInboundError({
        reason: "native-journal-failed",
        accountId,
        postId,
        detail: String(cause),
      }),
  }).pipe(
    Effect.flatMap((result) =>
      validateJournalRecordId(accountId, postId, result.record.id).pipe(
        Effect.zipRight(
          decodeJournalPayload(
            accountId,
            postId,
            result.kind === "completed"
              ? result.record.metadata
              : result.record.payload,
          ),
        ),
        Effect.flatMap((storedPayload) =>
          ensureMatchingPayload(accountId, postId, payload, storedPayload).pipe(
            Effect.zipRight(acknowledgeDelivery(delivery)),
            Effect.as(
              result.kind === "completed"
                ? Option.none()
                : Option.some(storedPayload),
            ),
          ),
        ),
      ),
    ),
  );
}

function validateJournalRecordId(
  accountId: string,
  expectedPostId: PostIdValue,
  value: string,
): Effect.Effect<void, OpenClawInboundError> {
  return decodeJournalPostId(accountId, value).pipe(
    Effect.flatMap((storedPostId) =>
      storedPostId === expectedPostId
        ? Effect.void
        : Effect.fail(
            new OpenClawInboundError({
              reason: "native-payload-collision",
              accountId,
              postId: expectedPostId,
              detail:
                "the native journal record identity does not match its message",
            }),
          ),
    ),
  );
}

function decodeJournalPostId(
  accountId: string,
  value: string,
): Effect.Effect<PostIdValue, OpenClawInboundError> {
  const decoded = Schema.decodeUnknownOption(PostId)(value, exactSchemaOptions);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(
        new OpenClawInboundError({
          reason: "native-payload-invalid",
          accountId,
          detail: "the native journal contains an invalid PostId",
        }),
      );
}

function decodeJournalPayload(
  accountId: string,
  postId: PostIdValue,
  value?: NativeInboundPayload,
): Effect.Effect<NativeInboundPayload, OpenClawInboundError> {
  const decoded = Schema.decodeUnknownOption(nativeInboundPayloadSchema)(
    value,
    exactSchemaOptions,
  );
  if (Option.isNone(decoded)) {
    return Effect.fail(
      new OpenClawInboundError({
        reason: "native-payload-invalid",
        accountId,
        postId,
        detail: "the native journal contains an invalid inbound message",
      }),
    );
  }
  return Effect.succeed(decoded.value).pipe(
    Effect.flatMap((payload) =>
      payload.message.postId === postId
        ? Effect.succeed(payload)
        : Effect.fail(
            new OpenClawInboundError({
              reason: "native-payload-collision",
              accountId,
              postId,
              detail:
                "the native journal payload belongs to a different PostId",
            }),
          ),
    ),
  );
}

function ensureMatchingPayload(
  accountId: string,
  postId: PostIdValue,
  expected: NativeInboundPayload,
  stored: NativeInboundPayload,
): Effect.Effect<void, OpenClawInboundError> {
  return isDeepStrictEqual(expected, stored)
    ? Effect.void
    : Effect.fail(
        new OpenClawInboundError({
          reason: "native-payload-collision",
          accountId,
          postId,
          detail: "the PostId is already bound to a different inbound message",
        }),
      );
}

function acknowledgeDelivery(delivery: InboundDelivery) {
  return delivery.acknowledge;
}

function dispatchJournaledPayload(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: NativeChannelRuntime,
  inbound: NativeInboundPersistence,
  payload: NativeInboundPayload,
): Effect.Effect<void, OpenClawInboundError> {
  const message = payload.message;
  const dispatch = logInbound(ctx, message).pipe(
    Effect.zipRight(dispatchInboundPayload(ctx, runtime, payload)),
  );
  return dispatch.pipe(
    Effect.tapError((cause) =>
      releaseJournaledPayload(
        ctx.accountId,
        inbound.journal,
        message.postId,
        cause.message,
      ),
    ),
    Effect.zipRight(
      completeJournaledPayload(
        ctx.accountId,
        inbound.queue,
        message.postId,
        payload,
      ),
    ),
  );
}

function logInbound(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  message: InboundDelivery["message"],
): Effect.Effect<void> {
  return Effect.sync(() => {
    const body = renderContent(message.content);
    ctx.log?.info?.(
      `MoltZap: inbound from ${message.sender}: ${body.slice(0, INBOUND_LOG_PREVIEW_CHARS)}`,
    );
    ctx.setStatus({
      ...ctx.getStatus(),
      accountId: ctx.accountId,
      lastInboundAt: Date.now(),
      lastEventAt: Date.now(),
    });
  });
}

function dispatchInboundPayload(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: NativeChannelRuntime,
  payload: NativeInboundPayload,
): Effect.Effect<void, OpenClawInboundError> {
  const message = payload.message;
  const body = renderContent(message.content);
  return Effect.tryPromise({
    try: () =>
      runtime.inbound.run({
        channel: CHANNEL_ID,
        accountId: ctx.accountId,
        raw: payload,
        adapter: {
          ingest: () => ({
            id: message.postId,
            rawText: body,
            textForAgent: body,
            textForCommands: body,
            raw: message,
          }),
          resolveTurn: () => resolveInboundTurn(ctx, runtime, message, body),
        },
      }),
    catch: (cause) =>
      new OpenClawInboundError({
        reason: "native-dispatch-failed",
        accountId: ctx.accountId,
        postId: message.postId,
        detail: String(cause),
      }),
  });
}

function releaseJournaledPayload(
  accountId: string,
  journal: NativeInboundJournal,
  postId: PostIdValue,
  lastError: string,
): Effect.Effect<void, OpenClawInboundError> {
  return Effect.tryPromise({
    try: () => journal.release(postId, { lastError }),
    catch: (cause) =>
      new OpenClawInboundError({
        reason: "native-journal-failed",
        accountId,
        postId,
        detail: String(cause),
      }),
  }).pipe(
    Effect.flatMap((released) =>
      released
        ? Effect.void
        : Effect.fail(
            new OpenClawInboundError({
              reason: "native-journal-failed",
              accountId,
              postId,
              detail: "the failed native delivery was not pending",
            }),
          ),
    ),
  );
}

function completeJournaledPayload(
  accountId: string,
  queue: NativeInboundQueue,
  postId: PostIdValue,
  payload: NativeInboundPayload,
): Effect.Effect<void, OpenClawInboundError> {
  return Effect.tryPromise({
    try: () => queue.complete(postId, { metadata: payload }),
    catch: (cause) =>
      new OpenClawInboundError({
        reason: "native-journal-failed",
        accountId,
        postId,
        detail: String(cause),
      }),
  }).pipe(
    Effect.flatMap((completed) =>
      completed
        ? Effect.void
        : Effect.fail(
            new OpenClawInboundError({
              reason: "native-journal-failed",
              accountId,
              postId,
              detail:
                "the native ingress queue did not complete the pending delivery",
            }),
          ),
    ),
  );
}

function resolveInboundTurn(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: NativeChannelRuntime,
  message: InboundDelivery["message"],
  body: string,
) {
  const mode = ctx.account.mode ?? "shared";
  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    ...(mode === "private"
      ? { peer: { kind: message.kind, id: message.address } }
      : {}),
  });
  const routeSessionKey =
    mode === "shared" ? route.mainSessionKey : route.sessionKey;
  const projection: InboundTurnProjection = {
    ctx,
    runtime,
    message,
    body,
    route,
    routeSessionKey,
  };
  return assembleInboundTurn(projection, buildInboundContext(projection));
}

function buildInboundContext(projection: InboundTurnProjection) {
  const { body, ctx, message, route, routeSessionKey, runtime } = projection;
  return runtime.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    provider: CHANNEL_ID,
    surface: CHANNEL_ID,
    messageId: message.postId,
    from: message.sender,
    sender: inboundSenderFacts(message),
    conversation: inboundConversationFacts(message),
    route: {
      agentId: route.agentId,
      accountId: ctx.accountId,
      routeSessionKey,
      dispatchSessionKey: routeSessionKey,
      persistedSessionKey: routeSessionKey,
      mainSessionKey: route.mainSessionKey,
    },
    reply: inboundReplyFacts(message),
    message: {
      body,
      rawBody: body,
      bodyForAgent: body,
      commandBody: body,
    },
    extra: inboundGroupFacts(message),
  });
}

function inboundSenderFacts(message: InboundDelivery["message"]) {
  return {
    id: message.sender,
    name: message.sender.slice("agent:".length),
  };
}

function inboundConversationFacts(message: InboundDelivery["message"]) {
  return {
    kind: message.kind,
    id: message.address,
    label: message.address,
    routePeer: { kind: message.kind, id: message.address },
  };
}

function inboundReplyFacts(message: InboundDelivery["message"]) {
  return {
    to: message.address,
    originatingTo: message.address,
    replyTarget: message.address,
    deliveryTarget: message.address,
  };
}

function inboundGroupFacts(message: InboundDelivery["message"]) {
  return message.kind === "group"
    ? { GroupMembers: message.members.join(",") }
    : undefined;
}

function assembleInboundTurn(
  projection: InboundTurnProjection,
  ctxPayload: ReturnType<NativeChannelRuntime["inbound"]["buildContext"]>,
) {
  const { ctx, message, route, routeSessionKey, runtime } = projection;
  return {
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    agentId: route.agentId,
    routeSessionKey,
    storePath: resolveStorePath(ctx.cfg.session?.store, {
      agentId: route.agentId,
    }),
    ctxPayload,
    recordInboundSession: runtime.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      runtime.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: { deliver: keepPlainFinalPrivate },
    replyOptions: {
      sourceReplyDeliveryMode: "message_tool_only" as const,
      // A wildcard leaves the runtime tool surface intact and makes OpenClaw
      // retain the channel's required message tool under narrow profiles.
      toolsAllow: ["*"],
    },
    record: {
      updateLastRoute: {
        sessionKey: routeSessionKey,
        channel: CHANNEL_ID,
        to: message.address,
        accountId: ctx.accountId,
      },
    },
    messageId: message.postId,
  };
}

function keepPlainFinalPrivate() {
  return Promise.resolve({ visibleReplySent: false as const });
}

function renderContent(content: Content): string {
  return content.map((part) => renderContentPart(part)).join("\n");
}

function renderContentPart(part: Content[number]): string {
  if (part.type === "text") {
    return part.text;
  }
  return JSON.stringify(part.value) ?? "null";
}

function waitForAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.async<undefined>((resume) => {
    if (signal.aborted) {
      resume(Effect.succeed(undefined));
      return;
    }
    const onAbort = () => {
      resume(Effect.succeed(undefined));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function stopActiveGatewayAccount(
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
  accountId: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const active = activeEndpoints.get(accountId);
    if (active === undefined) {
      return;
    }
    activeEndpoints.delete(accountId);
    yield* Deferred.succeed(active.stopSignal, undefined);
  });
}

function finishActiveGatewayAccount(
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
  accountId: string,
  active: ActiveHarnessEndpoint,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (activeEndpoints.get(accountId) === active) {
      activeEndpoints.delete(accountId);
    }
  });
}

function sendNativeText(
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
  ctx: ChannelMessageSendTextContext,
) {
  return sendAddressedText(activeEndpoints, {
    accountId: ctx.accountId,
    messageId: ctx.deliveryQueueId ?? randomUUID(),
    text: ctx.text,
    to: ctx.to,
  });
}

function sendAddressedText(
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
  params: AddressedTextSend,
) {
  const accountId = params.accountId?.trim() ?? "(unspecified)";
  const endpoint = activeEndpoint(activeEndpoints, params.accountId);
  if (endpoint === undefined) {
    return Effect.fail(
      new OpenClawOutboundError({ reason: "not-connected", accountId }),
    );
  }
  return decodeSendInput(params, accountId).pipe(
    Effect.flatMap((input) => endpoint.send(input)),
    Effect.as(makeMessageSendResult(params.messageId)),
  );
}

function decodeSendInput(
  params: AddressedTextSend,
  accountId: string,
): Effect.Effect<Schema.Schema.Type<typeof SendInput>, OpenClawOutboundError> {
  const decoded = Schema.decodeUnknownOption(SendInput)({
    to: params.to,
    content: [{ type: "text", text: params.text }],
  });
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(
        new OpenClawOutboundError({
          reason: "invalid-native-send",
          accountId,
        }),
      );
}

function makeMessageSendResult(messageId: string): ChannelMessageSendResult {
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: CHANNEL_ID, messageId }],
      kind: "text",
    }),
  };
}

function activeEndpoint(
  activeEndpoints: Map<string, ActiveHarnessEndpoint>,
  accountId?: string | null,
): HarnessEndpoint | undefined {
  const requested = accountId?.trim();
  if (requested !== undefined && requested.length > 0) {
    return activeEndpoints.get(requested)?.endpoint;
  }
  if (activeEndpoints.size !== 1) {
    return undefined;
  }
  return activeEndpoints.values().next().value?.endpoint;
}

function runHostPromise<A, E extends Error | ConfigError.ConfigError>(
  effect: Effect.Effect<A, E>,
) {
  return Effect.runPromise(Effect.mapError(effect, hostPromiseError));
}

function hostPromiseError(error: Error | ConfigError.ConfigError): Error {
  if (ConfigError.isConfigError(error)) {
    return new OpenClawConfigurationError({
      source: "MOLTZAP_MCP_URL",
      detail: error.message,
    });
  }
  return error;
}

const plugin = {
  id: "openclaw-channel",
  name: "MoltZap",
  description: "Agent-to-agent messaging through the local MoltZap endpoint",
  configSchema: {},
  register(api: OpenClawPluginApi) {
    api.registerChannel({
      plugin: createMoltzapChannelPlugin({
        inbound: api.runtime.channel.inbound,
        reply: api.runtime.channel.reply,
        routing: api.runtime.channel.routing,
        session: api.runtime.channel.session,
        state: {
          openChannelIngressQueue: (options) =>
            api.runtime.state.openChannelIngressQueue<
              NativeInboundPayload,
              never,
              NativeInboundPayload
            >(options),
        },
      }),
    });
  },
};

// eslint-disable-next-line import-x/no-default-export -- OpenClaw discovers plugins through a required default export.
export default plugin;
