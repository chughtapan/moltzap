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
  type HarnessEndpoint,
  type InboundDelivery,
  MessageAddressInput,
  type MessageAddressInput as MessageAddressInputValue,
  type PostId as PostIdValue,
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
} from "effect";
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

const CHANNEL_ID = "moltzap";
const TARGET_HINT =
  'Use an explicit "agent:<name>" or "group:<member>,<member>,..." address';
const INBOUND_LOG_PREVIEW_CHARS = 80;

type OpenClawTargetKind = "user" | "group";
type OpenClawOutboundFailure = "account-not-connected" | "invalid-address";
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

interface InboundMessageTurnInput {
  readonly ctx: ChannelGatewayContext<MoltZapAccount>;
  readonly runtime: OpenClawAccountRuntime;
  readonly endpoint: HarnessEndpoint;
  readonly message: InboundDelivery["message"];
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
 *   Host-->>Plugin: deliver final reply
 *   Plugin->>Client: send to inbound address
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
  const connectedEndpoints = new Map<string, HarnessEndpoint>();
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
        startAccountConnection(ctx, connectedEndpoints, deps),
    },
    message: createMessageSection(connectedEndpoints),
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

function createMessageSection(
  connectedEndpoints: Map<string, HarnessEndpoint>,
) {
  return defineChannelMessageAdapter({
    id: CHANNEL_ID,
    send: {
      text: (ctx) => runHostPromise(sendOpenClawText(connectedEndpoints, ctx)),
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
  connectedEndpoints: Map<string, HarnessEndpoint>,
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
            runAccountConnection(ctx, runtime, endpoint, connectedEndpoints),
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
  connectedEndpoints: Map<string, HarnessEndpoint>,
) {
  return Effect.sync(() => {
    connectedEndpoints.set(ctx.accountId, endpoint);
  }).pipe(
    Effect.zipRight(reportConnected(ctx)),
    Effect.zipRight(consumeInboundMessages(ctx, runtime, endpoint)),
    Effect.ensuring(
      removeConnectedEndpoint(connectedEndpoints, ctx.accountId, endpoint),
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
        handleInboundDelivery(ctx, runtime, endpoint, delivery),
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
  endpoint: HarnessEndpoint,
  delivery: InboundDelivery,
) {
  return logInbound(ctx, delivery.message).pipe(
    Effect.zipRight(runOpenClawTurn(ctx, runtime, endpoint, delivery.message)),
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
  runtime: OpenClawAccountRuntime,
  endpoint: HarnessEndpoint,
  message: InboundDelivery["message"],
): Effect.Effect<void, OpenClawInboundError> {
  const body = renderContent(message.content);
  return Effect.tryPromise({
    try: () =>
      runtime.inbound.run({
        channel: CHANNEL_ID,
        accountId: ctx.accountId,
        raw: { message },
        adapter: {
          ingest: () => ({
            id: message.postId,
            rawText: body,
            textForAgent: body,
            textForCommands: body,
            raw: message,
          }),
          resolveTurn: () =>
            buildRoutedTurnPlan({ ctx, runtime, endpoint, message, body }),
        },
      }),
    catch: (cause) =>
      new OpenClawInboundError({
        reason: "turn-failed",
        accountId: ctx.accountId,
        postId: message.postId,
        detail: String(cause),
      }),
  });
}

function buildRoutedTurnPlan(
  input: InboundMessageTurnInput,
): ChannelInboundTurnPlan {
  const { ctx, endpoint, message, runtime } = input;
  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    peer: { kind: message.kind, id: message.address },
  });
  const ctxPayload = buildInboundContext(input, route);
  return {
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    route: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      ...(route.dmScope === undefined ? {} : { dmScope: route.dmScope }),
    },
    ctxPayload,
    delivery: {
      deliver: (payload: ReplyPayload) =>
        deliverReplyToInboundAddress(endpoint, message.address, payload),
    },
    record: {
      updateLastRoute: {
        sessionKey: route.sessionKey,
        channel: CHANNEL_ID,
        to: message.address,
        accountId: ctx.accountId,
      },
    },
    messageId: message.postId,
  };
}

function buildInboundContext(
  input: InboundMessageTurnInput,
  route: ReturnType<OpenClawAccountRuntime["routing"]["resolveAgentRoute"]>,
) {
  const { body, ctx, message, runtime } = input;
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
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
      persistedSessionKey: route.sessionKey,
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

function deliverReplyToInboundAddress(
  endpoint: HarnessEndpoint,
  to: MessageAddressInputValue,
  payload: ReplyPayload,
) {
  if (payload.text === undefined || payload.text.length === 0) {
    return Promise.resolve({ visibleReplySent: false as const });
  }
  return runHostPromise(
    endpoint
      .send({
        to,
        content: [{ type: "text", text: payload.text }],
      })
      .pipe(Effect.as({ visibleReplySent: true as const })),
  );
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
  connectedEndpoints: Map<string, HarnessEndpoint>,
  accountId: string,
  active: HarnessEndpoint,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (connectedEndpoints.get(accountId) === active) {
      connectedEndpoints.delete(accountId);
    }
  });
}

function sendOpenClawText(
  connectedEndpoints: Map<string, HarnessEndpoint>,
  ctx: ChannelMessageSendTextContext,
) {
  return sendAddressedText(connectedEndpoints, {
    accountId: ctx.accountId,
    messageId: randomUUID(),
    text: ctx.text,
    to: ctx.to,
  });
}

function sendAddressedText(
  connectedEndpoints: Map<string, HarnessEndpoint>,
  params: AddressedTextSend,
) {
  const accountId = params.accountId?.trim() ?? "(unspecified)";
  const endpoint = connectedEndpoint(connectedEndpoints, params.accountId);
  if (endpoint === undefined) {
    return Effect.fail(
      new OpenClawOutboundError({
        reason: "account-not-connected",
        accountId,
      }),
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
  connectedEndpoints: Map<string, HarnessEndpoint>,
  accountId?: string | null,
): HarnessEndpoint | undefined {
  const requested = accountId?.trim();
  if (requested !== undefined && requested.length > 0) {
    return connectedEndpoints.get(requested);
  }
  if (connectedEndpoints.size !== 1) {
    return undefined;
  }
  return connectedEndpoints.values().next().value;
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
