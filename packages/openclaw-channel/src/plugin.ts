/** @file OpenClaw plugin that registers the MoltZap channel. */

import type {
  ChannelGatewayContext,
  ChannelRuntimeSurface,
} from "openclaw/plugin-sdk/channel-contract";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  acquireHarnessEndpoint,
  type Content,
  type DirectMessage,
  type GroupMessage,
  type HarnessEndpoint,
  type InboundDelivery,
  MessageAddressInput,
  type MessageAddressInput as MessageAddressInputValue,
  SendInput,
} from "@moltzap/client";
import {
  Config,
  ConfigError,
  Data,
  Effect,
  JSONSchema,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  type ChannelPlugin,
  createChannelPluginBase,
  defineChannelPluginEntry,
  type OpenClawConfig,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import {
  type ChannelMessageSendResult,
  type ChannelMessageSendTextContext,
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  waitUntilAbort,
} from "openclaw/plugin-sdk/channel-outbound";

import {
  type GatherAdapter,
  type GatherReport,
  makeGatherAdapter,
} from "./gather-adapter.js";
import {
  DELIVERY_DISPOSITION,
  type DeliveryDisposition,
} from "./gather-overlay.js";

const CHANNEL_ID = "moltzap";
const TARGET_HINT =
  'Use an explicit "agent:<name>" or "group:<member>,<member>,..." address';
const INBOUND_LOG_PREVIEW_CHARS = 80;
/**
 * OpenClaw refuses new work while a reversible restart-signal fence or host
 * suspension is closed and reopens it when the fence clears. Five retries
 * doubling from half a second wait about fifteen seconds in total; a one-way
 * restart drain outlasts them and the report is logged as lost.
 */
const REPORT_TURN_RETRY = Schedule.exponential("500 millis").pipe(
  Schedule.intersect(Schedule.recurs(5)),
);
/** The error name OpenClaw gives a turn refused by its work admission. */
const GATEWAY_DRAINING_ERROR_NAME = "GatewayDrainingError";

type OpenClawTargetKind = "user" | "group";
type OpenClawOutboundFailure = "account-not-connected" | "invalid-address";
type OpenClawInboundFailure = "gateway-draining" | "turn-failed";

interface OpenClawAccountRuntime {
  readonly inbound: Pick<
    PluginRuntime["channel"]["inbound"],
    "buildContext" | "run"
  >;
  readonly routing: Pick<
    PluginRuntime["channel"]["routing"],
    "resolveAgentRoute"
  >;
}

/**
 * OpenClaw's services for one account task, and a runner that enters the
 * asynchronous context the task started in.
 *
 * OpenClaw keeps the admitted request of the current asynchronous chain in an
 * `AsyncLocalStorage` and refuses a turn whose inherited request has
 * finished, reporting `GatewayDrainingError` although the gateway is open. It
 * starts channel accounts outside any request. A turn the account starts
 * itself, such as a gather report, resumes on whichever callback woke its
 * fiber: a deadline timer armed during the model's `message` tool call
 * carries that call's request, which has finished by the time the report
 * runs. Every turn enters the account's own context so it is admitted as
 * ordinary inbound is.
 */
interface AccountTurnRuntime extends OpenClawAccountRuntime {
  readonly inAccountContext: <R>(run: () => R) => R;
}

const moltZapAccountSchema = Schema.Struct({
  id: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.Literal("shared", "private")),
});

/** One OpenClaw account bound to the process-local MCP endpoint. */
type MoltZapAccount = Schema.Schema.Type<typeof moltZapAccountSchema>;

const moltZapChannelConfigSchema = Schema.Struct({
  accounts: Schema.optional(Schema.Tuple(moltZapAccountSchema)),
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

interface ConnectedAccount {
  readonly accountId: string;
  readonly endpoint: HarnessEndpoint;
  readonly gather: Option.Option<GatherAdapter>;
}

interface ConnectedAccountState {
  current?: ConnectedAccount;
}

/** The routing facts of a host turn: a message without its post identity. */
type TurnMessage = Omit<DirectMessage, "postId"> | Omit<GroupMessage, "postId">;

/**
 * One OpenClaw turn. `id` is the delivery's PostId for a certified message and
 * the report's own identity for a gather report.
 */
interface HostTurn {
  readonly id: string;
  readonly message: TurnMessage;
}

interface InboundMessageTurnInput {
  readonly ctx: ChannelGatewayContext<MoltZapAccount>;
  readonly runtime: OpenClawAccountRuntime;
  readonly turn: HostTurn;
  readonly body: string;
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
  readonly turnId?: string;
  readonly detail: string;
}> {
  override get message(): string {
    const identity =
      this.turnId === undefined
        ? this.accountId
        : `${this.accountId}/${this.turnId}`;
    return `MoltZap inbound delivery failed for ${identity}: ${this.reason}: ${this.detail}`;
  }
}

class OpenClawOutboundError extends Data.TaggedError("OpenClawOutboundError")<{
  readonly reason: OpenClawOutboundFailure;
  readonly accountId: string;
}> {
  override get message(): string {
    return `MoltZap message delivery failed for account ${this.accountId}: ${this.reason}`;
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

class OpenClawRuntimeError extends Data.TaggedError("OpenClawRuntimeError")<{
  readonly reason: "abort-wait-failed" | "channel-runtime-unavailable";
  readonly accountId: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `MoltZap account ${this.accountId} runtime failed: ${this.reason}: ${this.detail}`;
  }
}

const isMessageAddressInput = Schema.is(MessageAddressInput);

/**
 * Returns the manifest schema for one MoltZap channel configuration.
 * @returns The JSON Schema embedded in the OpenClaw plugin manifest.
 * @internal
 */
export function makeMoltZapChannelConfigJsonSchema() {
  return JSONSchema.make(moltZapChannelConfigSchema);
}

/**
 * Creates the MoltZap OpenClaw channel plugin.
 *
 * OpenClaw supplies the account runtime to `startAccount`. The registered
 * plugin does not retain an account runtime or session.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Host as OpenClaw
 *   participant Plugin as MoltZap plugin
 *   participant Client as HarnessEndpoint
 *   Host->>Plugin: start account with its runtime
 *   Plugin->>Client: acquire endpoint
 *   Client-->>Plugin: addressed delivery
 *   Plugin->>Host: submit routed turn
 *   Host->>Host: record session and run agent
 *   Host-->>Plugin: final reply withheld
 *   Plugin->>Client: acknowledge delivery
 *   Host->>Plugin: proactive send with explicit address
 *   Plugin->>Client: send addressed content
 * ```
 * @param deps Optional process-local dependency overrides used by tests.
 * @returns The MoltZap channel plugin.
 * @internal
 */
export function createMoltzapChannelPlugin(
  deps: MoltzapChannelPluginDeps = {},
): ChannelPlugin<MoltZapAccount> {
  const connectedAccount: ConnectedAccountState = {};
  return {
    ...createChannelPluginBase<MoltZapAccount>({
      id: CHANNEL_ID,
      meta: createPluginMeta(),
    }),
    capabilities: { chatTypes: ["direct", "group"] },
    config: createConfigSection(),
    messaging: createMessagingSection(),
    gateway: {
      startAccount: (ctx) =>
        startAccountConnection(ctx, connectedAccount, deps),
    },
    message: createMessageSection(connectedAccount),
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
      looksLikeId: isExplicitMessageTarget,
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

function createMessageSection(connectedAccount: ConnectedAccountState) {
  return defineChannelMessageAdapter({
    id: CHANNEL_ID,
    send: {
      text: (ctx) => runHostPromise(sendOpenClawText(connectedAccount, ctx)),
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

function isExplicitMessageTarget(raw: string): boolean {
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

function startAccountConnection(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  connectedAccount: ConnectedAccountState,
  deps: MoltzapChannelPluginDeps,
) {
  if (ctx.abortSignal.aborted) {
    return Promise.resolve();
  }
  const inAccountContext = AsyncLocalStorage.snapshot();
  return runHostPromise(
    requireOpenClawAccountRuntime(ctx).pipe(
      Effect.map(
        (services): AccountTurnRuntime => ({
          inbound: services.inbound,
          routing: services.routing,
          inAccountContext,
        }),
      ),
      Effect.flatMap((runtime) =>
        acquireAccountEndpoint(deps, ctx.accountId, ctx.account).pipe(
          Effect.flatMap((endpoint) =>
            runAccountConnection(ctx, runtime, endpoint, connectedAccount),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
}

/**
 * Returns the OpenClaw services for an account task.
 *
 * OpenClaw creates a channel runtime for each account task. Reading it here
 * prevents the registered plugin from retaining another account's runtime.
 * @param ctx The account connection context supplied by OpenClaw.
 * @returns The routing and inbound services scoped to this account task.
 */
function requireOpenClawAccountRuntime(
  ctx: ChannelGatewayContext<MoltZapAccount>,
): Effect.Effect<OpenClawAccountRuntime, OpenClawRuntimeError> {
  if (
    ctx.channelRuntime !== undefined &&
    isOpenClawAccountRuntime(ctx.channelRuntime)
  ) {
    return Effect.succeed(ctx.channelRuntime);
  }
  return Effect.fail(
    new OpenClawRuntimeError({
      reason: "channel-runtime-unavailable",
      accountId: ctx.accountId,
      detail: "the account task did not receive OpenClaw channel services",
    }),
  );
}

function isOpenClawAccountRuntime(
  runtime: ChannelRuntimeSurface,
): runtime is ChannelRuntimeSurface & OpenClawAccountRuntime {
  return (
    hasOpenClawInboundRuntime(runtime) && hasOpenClawRoutingRuntime(runtime)
  );
}

function hasOpenClawInboundRuntime(runtime: ChannelRuntimeSurface): boolean {
  const inbound = runtime.inbound;
  if (typeof inbound !== "object" || inbound === null) {
    return false;
  }
  if (!("buildContext" in inbound)) {
    return false;
  }
  if (typeof inbound.buildContext !== "function") {
    return false;
  }
  return "run" in inbound && typeof inbound.run === "function";
}

function hasOpenClawRoutingRuntime(runtime: ChannelRuntimeSurface): boolean {
  const routing = runtime.routing;
  if (typeof routing !== "object" || routing === null) {
    return false;
  }
  return (
    "resolveAgentRoute" in routing &&
    typeof routing.resolveAgentRoute === "function"
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

function runAccountConnection(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: AccountTurnRuntime,
  endpoint: HarnessEndpoint,
  connectedAccount: ConnectedAccountState,
) {
  return accountGatherAdapter(ctx, runtime, endpoint).pipe(
    Effect.tap((gather) =>
      Effect.sync(() => {
        connectedAccount.current = {
          accountId: ctx.accountId,
          endpoint,
          gather,
        };
      }),
    ),
    Effect.zipRight(reportConnected(ctx)),
    Effect.zipRight(
      consumeInboundMessages(ctx, runtime, endpoint, connectedAccount),
    ),
    Effect.ensuring(
      removeConnectedEndpoint(connectedAccount, ctx.accountId, endpoint),
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

/**
 * A report turn that OpenClaw refuses at admission is retried on
 * `REPORT_TURN_RETRY`, since the gather it reports has ended and nothing
 * delivers the report again. A turn that still fails is logged as an error.
 */
function accountGatherAdapter(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: AccountTurnRuntime,
  endpoint: HarnessEndpoint,
) {
  return makeGatherAdapter({
    send: endpoint.send,
    runTurn: (report) =>
      runOpenClawTurn(ctx, runtime, gatherReportTurn(report)).pipe(
        Effect.retry({
          schedule: REPORT_TURN_RETRY,
          while: (error) => error.reason === "gateway-draining",
        }),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            ctx.log?.error?.(
              `MoltZap gather: result turn failed: ${error.detail}`,
            );
          }),
        ),
      ),
    log: (line) => ctx.log?.info?.(line),
  });
}

/**
 * Consumes messages until the stream ends or OpenClaw aborts the account.
 *
 * The stream can complete or fail independently of the account abort signal.
 * Racing both operations sends every result through the cleanup in
 * `runAccountConnection`.
 * @param ctx The account task and abort signal supplied by OpenClaw.
 * @param runtime OpenClaw routing and inbound services for this account task.
 * @param endpoint The daemon-backed message stream for this account.
 * @param connectedAccount The account's connection, whose gather adapter sees
 *   each delivery before the stock inbound path.
 * @returns An effect that ends with the stream or the abort signal.
 */
function consumeInboundMessages(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: AccountTurnRuntime,
  endpoint: HarnessEndpoint,
  connectedAccount: ConnectedAccountState,
) {
  return Effect.raceFirst(
    endpoint.messages.pipe(
      Stream.runForEach((delivery) =>
        gatherDisposition(connectedAccount, delivery).pipe(
          Effect.flatMap((disposition) =>
            disposition === DELIVERY_DISPOSITION.consumed
              ? Effect.void
              : handleInboundDelivery(ctx, runtime, delivery),
          ),
        ),
      ),
    ),
    Effect.tryPromise({
      try: () => waitUntilAbort(ctx.abortSignal),
      catch: (cause) =>
        new OpenClawRuntimeError({
          reason: "abort-wait-failed",
          accountId: ctx.accountId,
          detail: String(cause),
        }),
    }),
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

/**
 * A gather report is a direct message from the local agent to itself. In
 * shared mode it joins the main session like every turn; in private mode it
 * lands in the session for the agent's own address, never a member's, and no
 * member's conversation history matches it.
 */
function gatherReportTurn(report: GatherReport): HostTurn {
  return {
    id: report.turnId,
    message: {
      kind: "direct",
      address: report.from,
      sender: report.from,
      content: [{ type: "text", text: report.text }],
    },
  };
}

/** The overlay acknowledges what it consumes; the rest takes the stock path. */
function gatherDisposition(
  connectedAccount: ConnectedAccountState,
  delivery: InboundDelivery,
): Effect.Effect<DeliveryDisposition> {
  const gather = connectedAccount.current?.gather ?? Option.none();
  return Option.match(gather, {
    onNone: () => Effect.succeed(DELIVERY_DISPOSITION.passthrough),
    onSome: (adapter) => adapter.onDelivery(delivery),
  });
}

function handleInboundDelivery(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: AccountTurnRuntime,
  delivery: InboundDelivery,
) {
  return logInbound(ctx, delivery.message).pipe(
    Effect.zipRight(
      runOpenClawTurn(ctx, runtime, {
        id: delivery.message.postId,
        message: delivery.message,
      }),
    ),
    Effect.zipRight(delivery.acknowledge),
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

function runOpenClawTurn(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: AccountTurnRuntime,
  turn: HostTurn,
): Effect.Effect<void, OpenClawInboundError> {
  const { id, message } = turn;
  const body = renderContent(message.content);
  return Effect.tryPromise({
    try: () =>
      runtime.inAccountContext(() =>
        runtime.inbound.run({
          channel: CHANNEL_ID,
          accountId: ctx.accountId,
          raw: { message },
          adapter: {
            ingest: () => ({
              id,
              rawText: body,
              textForAgent: body,
              textForCommands: body,
              raw: message,
            }),
            resolveTurn: () =>
              buildRoutedTurnPlan({ ctx, runtime, turn, body }),
          },
        }),
      ),
    catch: (cause) =>
      new OpenClawInboundError({
        reason: inboundFailure(cause),
        accountId: ctx.accountId,
        turnId: id,
        detail: String(cause),
      }),
  });
}

function inboundFailure(cause: unknown): OpenClawInboundFailure {
  return cause instanceof Error && cause.name === GATEWAY_DRAINING_ERROR_NAME
    ? "gateway-draining"
    : "turn-failed";
}

function buildRoutedTurnPlan(
  input: InboundMessageTurnInput,
): ChannelInboundTurnPlan {
  const { ctx, runtime } = input;
  const { message } = input.turn;
  const peer = inboundRoutePeer(message);
  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    peer,
  });
  const sessionKey =
    (ctx.account.mode ?? "shared") === "shared"
      ? route.mainSessionKey
      : route.sessionKey;
  const ctxPayload = buildInboundContext(input, route, sessionKey);
  return {
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    route: {
      agentId: route.agentId,
      sessionKey,
      ...(route.dmScope === undefined ? {} : { dmScope: route.dmScope }),
    },
    ctxPayload,
    delivery: { deliver: (payload) => withholdFinalText(ctx, payload) },
    record: {
      updateLastRoute: {
        sessionKey,
        channel: CHANNEL_ID,
        to: message.address,
        accountId: ctx.accountId,
      },
    },
    messageId: input.turn.id,
  };
}

function buildInboundContext(
  input: InboundMessageTurnInput,
  route: ReturnType<OpenClawAccountRuntime["routing"]["resolveAgentRoute"]>,
  sessionKey: string,
) {
  const { body, ctx, runtime } = input;
  const { message } = input.turn;
  return runtime.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    provider: CHANNEL_ID,
    surface: CHANNEL_ID,
    messageId: input.turn.id,
    from: message.sender,
    sender: inboundSenderFacts(message),
    conversation: inboundConversationFacts(message),
    route: {
      agentId: route.agentId,
      accountId: ctx.accountId,
      routeSessionKey: sessionKey,
      dispatchSessionKey: sessionKey,
      persistedSessionKey: sessionKey,
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

/**
 * Every MoltZap sender is another principal's agent, so the sender is marked
 * as a bot. OpenClaw records that as the participant's `senderKind` in session
 * and transcript metadata; it does not change routing, reply mode, or admit
 * the sender's text as instructions.
 */
function inboundSenderFacts(message: TurnMessage) {
  return {
    id: message.sender,
    name: message.sender.slice("agent:".length),
    isBot: true,
  };
}

function inboundConversationFacts(message: TurnMessage) {
  const routePeer = inboundRoutePeer(message);
  return {
    kind: message.kind,
    id: message.address,
    label: message.address,
    routePeer,
  };
}

function inboundRoutePeer(message: TurnMessage) {
  const prefix = message.kind === "group" ? "group:" : "agent:";
  return {
    kind: message.kind,
    id: message.address.slice(prefix.length),
  };
}

function inboundReplyFacts(message: TurnMessage) {
  return {
    to: message.address,
    originatingTo: message.address,
    replyTarget: message.address,
    deliveryTarget: message.address,
  };
}

function inboundGroupFacts(message: TurnMessage) {
  return message.kind === "group"
    ? { GroupMembers: message.members.join(",") }
    : undefined;
}

/**
 * Final assistant text never becomes a MoltZap post. The simulator's OpenClaw
 * configuration selects tool-only visible replies, and this callback withholds
 * anything that still reaches it, so the `message` tool with an explicit
 * target is the only send path. Non-empty text reaching here means OpenClaw
 * fell back to automatic delivery, which it does when the `message` tool is
 * outside the tool policy, or the model wrote a reply without the tool; the
 * warning is the only trace of that, so it names the size, never the text.
 */
function withholdFinalText(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  payload: ReplyPayload,
) {
  if (payload.text !== undefined && payload.text.length > 0) {
    ctx.log?.warn?.(
      `MoltZap: withheld ${payload.text.length} chars of final text; visible replies use the message tool`,
    );
  }
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

function removeConnectedEndpoint(
  connectedAccount: ConnectedAccountState,
  accountId: string,
  active: HarnessEndpoint,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (
      connectedAccount.current?.accountId === accountId &&
      connectedAccount.current.endpoint === active
    ) {
      connectedAccount.current = undefined;
    }
  });
}

function sendOpenClawText(
  connectedAccount: ConnectedAccountState,
  ctx: ChannelMessageSendTextContext,
) {
  return sendAddressedText(connectedAccount, {
    accountId: ctx.accountId,
    messageId: randomUUID(),
    text: ctx.text,
    to: ctx.to,
  });
}

function sendAddressedText(
  connectedAccount: ConnectedAccountState,
  params: AddressedTextSend,
) {
  const accountId = params.accountId?.trim() ?? "(unspecified)";
  const endpoint = connectedEndpoint(connectedAccount, params.accountId);
  if (endpoint === undefined) {
    return Effect.fail(
      new OpenClawOutboundError({
        reason: "account-not-connected",
        accountId,
      }),
    );
  }
  return decodeSendInput(params, accountId).pipe(
    Effect.flatMap((input) =>
      Option.getOrElse(
        Option.flatMap(
          connectedAccount.current?.gather ?? Option.none(),
          (adapter) => adapter.commandSend(input.to, params.text),
        ),
        () => endpoint.send(input),
      ),
    ),
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
          reason: "invalid-address",
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

function connectedEndpoint(
  connectedAccount: ConnectedAccountState,
  accountId?: string | null,
): HarnessEndpoint | undefined {
  const active = connectedAccount.current;
  if (active === undefined) {
    return undefined;
  }
  const requested = accountId?.trim();
  if (
    requested !== undefined &&
    requested.length > 0 &&
    requested !== active.accountId
  ) {
    return undefined;
  }
  return active.endpoint;
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

const plugin: OpenClawPluginDefinition &
  Required<Pick<OpenClawPluginDefinition, "id" | "register">> =
  defineChannelPluginEntry({
    id: "openclaw-channel",
    name: "MoltZap",
    description: "Agent-to-agent messaging through the local MoltZap endpoint",
    plugin: createMoltzapChannelPlugin(),
  });

// eslint-disable-next-line import-x/no-default-export -- OpenClaw discovers plugins through a required default export.
export default plugin;
