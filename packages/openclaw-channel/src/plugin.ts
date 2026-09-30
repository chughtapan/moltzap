/** @file OpenClaw plugin that registers the MoltZap channel. */

import type {
  ChannelGatewayContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelRuntimeSurface,
} from "openclaw/plugin-sdk/channel-contract";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  acquireHarnessEndpoint,
  CollectiveOperation,
  CollectiveResponse,
  type Content,
  type HarnessEndpoint,
  type InboundDelivery,
  type InboundItem,
  type InboundMessage,
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
  Schema,
  Stream,
  Struct,
} from "effect";
import { absurd } from "effect/Function";
import { randomUUID } from "node:crypto";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
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
import { Type } from "typebox";

const CHANNEL_ID = "moltzap";
const TARGET_HINT =
  'Use an explicit "agent:<name>" or "group:<member>,<member>,..." address';
const INBOUND_LOG_PREVIEW_CHARS = 80;

type OpenClawTargetKind = "user" | "group";
type OpenClawOutboundFailure =
  | "account-not-connected"
  | "invalid-address"
  | "invalid-operation"
  | "unsupported-action";
type OpenClawInboundFailure = "turn-failed";

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
}

interface ConnectedAccountState {
  current?: ConnectedAccount;
}

/** Who a turn is from, as OpenClaw records the sender. */
interface TurnSender {
  readonly id: string;
  readonly name: string;
}

/**
 * One OpenClaw turn rendered from one inbound item. `id` is the certified
 * post's `PostId` for a multicast or a request, and a turn id derived from
 * the operation id for a result or a failure, which no post carries.
 * `address` is the conversation the turn belongs to and replies go to.
 */
interface HostTurn {
  readonly id: string;
  readonly kind: "direct" | "group";
  readonly address: MessageAddressInputValue;
  readonly sender: TurnSender;
  readonly members?: readonly string[];
  readonly body: string;
}

interface InboundTurnInput {
  readonly ctx: ChannelGatewayContext<MoltZapAccount>;
  readonly runtime: OpenClawAccountRuntime;
  readonly turn: HostTurn;
}

/** One host send before validation; the host supplies each field untyped. */
interface OperationSend {
  readonly accountId?: string | null;
  readonly to: unknown;
  readonly text: unknown;
  readonly collective?: unknown;
  readonly collectiveResponse?: unknown;
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
  readonly turnId: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `MoltZap inbound delivery failed for ${this.accountId}/${this.turnId}: ${this.reason}: ${this.detail}`;
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
 * The `collective` parameter MoltZap adds to the message tool's `send`
 * action. Its JSON Schema comes from the Client's `CollectiveOperation`, so
 * the tool accepts exactly the operations the endpoint does; TypeBox marks it
 * optional because a `send` without it is a multicast. The description names
 * OpenClaw's own `message` parameter, which carries the question.
 */
const collectiveParameter = Type.Optional(
  Type.Unsafe<CollectiveOperation>({
    ...Struct.omit(JSONSchema.make(CollectiveOperation), "$schema"),
    description:
      'The MoltZap collective operation. Omit it for an ordinary message to the target. {"op":"gather","deadline":<seconds>,"requestedSchema":<form>} sends message as a question to each member of the target, each privately, and later delivers one result turn listing every member\'s answer, decline, cancel or no-answer; deadline is a whole number of seconds from now, 1 to 2592000 (30 days). requestedSchema is an MCP form: {"type":"object","properties":{...},"required":[...]} of flat string, number, integer, boolean or enum-array properties. {"op":"all_gather","deadline":<seconds>,"requestedSchema":<form>} asks one question to a group: the target must be a group, members answer in the group but no one sees an answer before the close, and everyone, you included, receives the same result turn at the close. The tool result carries the operation\'s operationId.',
  }),
);

/**
 * The `collectiveResponse` parameter: one answer to a collective request
 * turn. Its JSON Schema comes from the Client's `CollectiveResponse`; the
 * description says what OpenClaw needs beyond it.
 */
const collectiveResponseParameter = Type.Optional(
  Type.Unsafe<CollectiveResponse>({
    ...Struct.omit(JSONSchema.make(CollectiveResponse), "$schema"),
    description:
      'Answer a MoltZap collective request turn, once. {"id":<request id>,"action":"accept","content":{...}} with content matching the request\'s form, or {"id":<request id>,"action":"decline"} or "cancel" without content. The answer goes to the conversation the request arrived in, the requester for a gather and the group for an all_gather, whatever target says, and message is not sent; OpenClaw still requires a short non-empty message, so write one such as "declining". An answer that does not match the form fails with the fields named; answer again.',
  }),
);

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
 *   Client-->>Plugin: multicast, collective request, result or failure item
 *   Plugin->>Host: submit routed turn in the item's fixed form
 *   Host->>Host: record session and run agent
 *   Host-->>Plugin: final reply withheld
 *   Plugin->>Client: acknowledge delivery
 *   Host->>Plugin: message tool send with address, collective or collectiveResponse
 *   Plugin->>Client: send the operation or response
 *   Plugin-->>Host: tool result with the operation id, or the Client error
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
    actions: createMessageActions(connectedAccount),
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

/**
 * The message tool's `send` action for MoltZap. OpenClaw routes every model
 * `send` here because the adapter defines no prepared payload or gateway
 * execution mode, so the `collective` parameter reaches the endpoint
 * unchanged. `message.send.text` remains for the sends OpenClaw's core makes
 * itself.
 * @param connectedAccount The account whose endpoint performs the operation.
 * @returns The action adapter registered on the channel plugin.
 */
function createMessageActions(
  connectedAccount: ConnectedAccountState,
): ChannelMessageActionAdapter {
  return {
    describeMessageTool: () => ({
      actions: ["send"],
      schema: {
        properties: {
          collective: collectiveParameter,
          collectiveResponse: collectiveResponseParameter,
        },
        actions: ["send"],
      },
    }),
    supportsAction: ({ action }) => action === "send",
    handleAction: (ctx) =>
      runHostPromise(handleMessageAction(connectedAccount, ctx)),
  };
}

function handleMessageAction(
  connectedAccount: ConnectedAccountState,
  ctx: ChannelMessageActionContext,
) {
  if (ctx.action !== "send") {
    return Effect.fail(
      new OpenClawOutboundError({
        reason: "unsupported-action",
        accountId: accountLabel(ctx.accountId),
      }),
    );
  }
  return sendOperation(connectedAccount, {
    accountId: ctx.accountId,
    to: ctx.params.to,
    text: ctx.params.message,
    collective: ctx.params.collective,
    collectiveResponse: ctx.params.collectiveResponse,
  }).pipe(
    Effect.map(({ input, result }) =>
      jsonResult({
        ok: true,
        ...("to" in input ? { to: input.to } : {}),
        ...result,
      }),
    ),
  );
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
  return runHostPromise(
    requireOpenClawAccountRuntime(ctx).pipe(
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
  runtime: OpenClawAccountRuntime,
  endpoint: HarnessEndpoint,
  connectedAccount: ConnectedAccountState,
) {
  return Effect.sync(() => {
    connectedAccount.current = { accountId: ctx.accountId, endpoint };
  }).pipe(
    Effect.zipRight(reportConnected(ctx)),
    Effect.zipRight(consumeInboundMessages(ctx, runtime, endpoint)),
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
 * Consumes messages until the stream ends or OpenClaw aborts the account.
 *
 * The stream can complete or fail independently of the account abort signal.
 * Racing both operations sends every result through the cleanup in
 * `runAccountConnection`.
 * @param ctx The account task and abort signal supplied by OpenClaw.
 * @param runtime OpenClaw routing and inbound services for this account task.
 * @param endpoint The daemon-backed message stream for this account.
 * @returns An effect that ends with the stream or the abort signal.
 */
function consumeInboundMessages(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: OpenClawAccountRuntime,
  endpoint: HarnessEndpoint,
) {
  return Effect.raceFirst(
    endpoint.messages.pipe(
      Stream.runForEach((delivery) =>
        handleInboundDelivery(ctx, runtime, delivery),
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

function handleInboundDelivery(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  runtime: OpenClawAccountRuntime,
  delivery: InboundDelivery,
) {
  const turn = inboundItemTurn(delivery.item);
  return logInbound(ctx, turn).pipe(
    Effect.zipRight(runOpenClawTurn(ctx, runtime, turn)),
    Effect.zipRight(delivery.acknowledge),
  );
}

/** The sender OpenClaw records for a turn the endpoint itself emitted. */
const COLLECTIVE_SENDER_NAME = "MoltZap collective";

/**
 * Render one inbound item as the turn its kind defines. Each kind has one
 * fixed form, the same for every agent. A request belongs to the conversation
 * it arrived in: the requester's for a gather, the group's for an all_gather.
 * A result or a failure is attributed to the collective, not to any member,
 * and belongs to the conversation its operation addressed.
 * @param item The item the endpoint delivered.
 * @returns The turn OpenClaw runs.
 */
function inboundItemTurn(item: InboundItem): HostTurn {
  switch (item.kind) {
    case "multicast":
      return multicastTurn(item.message);
    case "collectiveRequest":
      return addressedTurn(
        item.postId,
        item.to,
        agentSender(item.from),
        renderCollectiveRequest(item),
      );
    case "collectiveResult":
      return collectiveTurn(
        `${item.id}:result`,
        item.to,
        renderCollectiveResult(item),
      );
    case "operationFailed":
      return collectiveTurn(
        `${item.id}:failed`,
        item.to,
        `MoltZap operation failed: ${item.error}`,
      );
    default:
      return absurd(item);
  }
}

function multicastTurn(message: InboundMessage): HostTurn {
  const base = {
    id: message.postId,
    address: message.address,
    sender: agentSender(message.sender),
    body: renderContent(message.content),
  };
  return message.kind === "group"
    ? { ...base, kind: "group", members: message.members }
    : { ...base, kind: "direct" };
}

function collectiveTurn(
  id: string,
  address: MessageAddressInputValue,
  body: string,
): HostTurn {
  return addressedTurn(
    id,
    address,
    { id: `collective:${id}`, name: COLLECTIVE_SENDER_NAME },
    body,
  );
}

/**
 * A turn in the conversation `address` names: a group address makes a group
 * turn listing its members.
 */
function addressedTurn(
  id: string,
  address: MessageAddressInputValue,
  sender: TurnSender,
  body: string,
): HostTurn {
  const kind = address.startsWith("group:") ? "group" : "direct";
  return {
    id,
    kind,
    address,
    sender,
    ...(kind === "group"
      ? {
          members: address
            .slice("group:".length)
            .split(",")
            .map((name) => `agent:${name}`),
        }
      : {}),
    body,
  };
}

function agentSender(address: string): TurnSender {
  return { id: address, name: address.slice("agent:".length) };
}

type CollectiveRequestItem = Extract<
  InboundItem,
  { readonly kind: "collectiveRequest" }
>;
type CollectiveResultItem = Extract<
  InboundItem,
  { readonly kind: "collectiveResult" }
>;
type MemberOutcome = CollectiveResultItem["outcomes"][number]["outcome"];

function renderCollectiveRequest(item: CollectiveRequestItem): string {
  const deadline = new Date(item.deadlineAt).toISOString();
  return [
    `MoltZap collective request ${item.id} from ${item.from}, open until ${deadline}.`,
    `Question: ${item.question}`,
    `Answer form (requestedSchema): ${JSON.stringify(item.requestedSchema)}`,
    `Answer once with the message tool's send action and collectiveResponse {"id":"${item.id}","action":"accept","content":{...}} matching the form, or {"id":"${item.id}","action":"decline"}.`,
  ].join("\n");
}

function renderCollectiveResult(item: CollectiveResultItem): string {
  return [
    `MoltZap collective result ${item.id} for the question sent to ${item.to}: ${item.question}`,
    ...item.outcomes.map(
      ({ member, outcome }) => `- ${member}: ${renderOutcome(outcome)}`,
    ),
  ].join("\n");
}

function renderOutcome(outcome: MemberOutcome): string {
  switch (outcome.kind) {
    case "answered":
      return `answered ${JSON.stringify(outcome.content)}`;
    case "declined":
      return "declined";
    case "cancelled":
      return "cancelled";
    case "invalid":
      return `answered outside the form (${outcome.reason})`;
    case "no-answer":
      return "no answer by the deadline";
    default:
      return absurd(outcome);
  }
}

function logInbound(
  ctx: ChannelGatewayContext<MoltZapAccount>,
  turn: HostTurn,
): Effect.Effect<void> {
  return Effect.sync(() => {
    ctx.log?.info?.(
      `MoltZap: inbound from ${turn.sender.id}: ${turn.body.slice(0, INBOUND_LOG_PREVIEW_CHARS)}`,
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
  runtime: OpenClawAccountRuntime,
  turn: HostTurn,
): Effect.Effect<void, OpenClawInboundError> {
  return Effect.tryPromise({
    try: () =>
      runtime.inbound.run({
        channel: CHANNEL_ID,
        accountId: ctx.accountId,
        raw: { turn },
        adapter: {
          ingest: () => ({
            id: turn.id,
            rawText: turn.body,
            textForAgent: turn.body,
            textForCommands: turn.body,
            raw: turn,
          }),
          resolveTurn: () => buildRoutedTurnPlan({ ctx, runtime, turn }),
        },
      }),
    catch: (cause) =>
      new OpenClawInboundError({
        reason: "turn-failed",
        accountId: ctx.accountId,
        turnId: turn.id,
        detail: String(cause),
      }),
  });
}

function buildRoutedTurnPlan(input: InboundTurnInput): ChannelInboundTurnPlan {
  const { ctx, turn, runtime } = input;
  const peer = inboundRoutePeer(turn);
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
        to: turn.address,
        accountId: ctx.accountId,
      },
    },
    messageId: turn.id,
  };
}

function buildInboundContext(
  input: InboundTurnInput,
  route: ReturnType<OpenClawAccountRuntime["routing"]["resolveAgentRoute"]>,
  sessionKey: string,
) {
  const { ctx, turn, runtime } = input;
  return runtime.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    provider: CHANNEL_ID,
    surface: CHANNEL_ID,
    messageId: turn.id,
    from: turn.sender.id,
    sender: inboundSenderFacts(turn),
    conversation: inboundConversationFacts(turn),
    route: {
      agentId: route.agentId,
      accountId: ctx.accountId,
      routeSessionKey: sessionKey,
      dispatchSessionKey: sessionKey,
      persistedSessionKey: sessionKey,
      mainSessionKey: route.mainSessionKey,
    },
    reply: inboundReplyFacts(turn),
    message: {
      body: turn.body,
      rawBody: turn.body,
      bodyForAgent: turn.body,
      commandBody: turn.body,
    },
    extra: inboundGroupFacts(turn),
  });
}

/**
 * Every MoltZap sender is another principal's agent or the collective layer,
 * so the sender is marked as a bot. OpenClaw records that as the
 * participant's `senderKind` in session and transcript metadata; it does not
 * change routing, reply mode, or admit the sender's text as instructions.
 */
function inboundSenderFacts(turn: HostTurn) {
  return { ...turn.sender, isBot: true };
}

function inboundConversationFacts(turn: HostTurn) {
  const routePeer = inboundRoutePeer(turn);
  return {
    kind: turn.kind,
    id: turn.address,
    label: turn.address,
    routePeer,
  };
}

function inboundRoutePeer(turn: HostTurn) {
  const prefix = turn.kind === "group" ? "group:" : "agent:";
  return {
    kind: turn.kind,
    id: turn.address.slice(prefix.length),
  };
}

function inboundReplyFacts(turn: HostTurn) {
  return {
    to: turn.address,
    originatingTo: turn.address,
    replyTarget: turn.address,
    deliveryTarget: turn.address,
  };
}

function inboundGroupFacts(turn: HostTurn) {
  return turn.members === undefined
    ? undefined
    : { GroupMembers: turn.members.join(",") };
}

/**
 * Final assistant text never becomes a MoltZap post. A launcher's OpenClaw
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
  return sendOperation(connectedAccount, {
    accountId: ctx.accountId,
    text: ctx.text,
    to: ctx.to,
  }).pipe(Effect.as(makeMessageSendResult(randomUUID())));
}

/**
 * Perform one host send as one Client operation or collective response. A
 * refused send fails with the Client's error, whose message OpenClaw returns
 * to the model as the tool error.
 * @param connectedAccount The account whose endpoint performs the operation.
 * @param params The host's account, address, text, operation and response.
 * @returns The validated input and the endpoint's result.
 */
function sendOperation(
  connectedAccount: ConnectedAccountState,
  params: OperationSend,
) {
  const accountId = accountLabel(params.accountId);
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
      endpoint.send(input).pipe(Effect.map((result) => ({ input, result }))),
    ),
  );
}

/**
 * Name the host's account in an outbound error, including when the host sent
 * none.
 * @param accountId The account id the host supplied, if any.
 * @returns The trimmed id, or a placeholder the error message can print.
 */
function accountLabel(accountId?: string | null): string {
  return accountId?.trim() ?? "(unspecified)";
}

/**
 * Decode one host send. A `collectiveResponse` is sent without the target or
 * text: its endpoint addresses the requester, and OpenClaw requires text on
 * every send even though a response carries none.
 */
function decodeSendInput(
  params: OperationSend,
  accountId: string,
): Effect.Effect<SendInput, OpenClawOutboundError> {
  if (params.collectiveResponse !== undefined) {
    return decodeOrFail(
      { collectiveResponse: params.collectiveResponse },
      accountId,
    );
  }
  if (!isMessageAddressInput(params.to)) {
    return Effect.fail(
      new OpenClawOutboundError({ reason: "invalid-address", accountId }),
    );
  }
  return decodeOrFail(
    {
      to: params.to,
      text: params.text,
      ...(params.collective === undefined
        ? {}
        : { collective: params.collective }),
    },
    accountId,
  );
}

function decodeOrFail(
  value: Readonly<Record<string, unknown>>,
  accountId: string,
): Effect.Effect<SendInput, OpenClawOutboundError> {
  const decoded = Schema.decodeUnknownOption(SendInput)(value);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(
        new OpenClawOutboundError({ reason: "invalid-operation", accountId }),
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
