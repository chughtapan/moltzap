/** @file OpenClaw host integration over the public semantic HarnessClient. */

import {
  acquireHarnessClient,
  AgentName,
  type Content,
  createConversationId,
  type HarnessClient,
  type HarnessTurn,
  type StartInput,
} from "@moltzap/client";
import {
  Config,
  Data,
  Deferred,
  Effect,
  JSONSchema,
  Schema,
  type Scope,
  Stream,
} from "effect";

const CHANNEL_ID = "moltzap";
const TARGET_PREFIX_AGENT = "agent:";
const TARGET_HINT =
  'Use an agent name or "agent:<name>" to start a conversation';
const INBOUND_LOG_PREVIEW_CHARS = 80;
const OUTBOUND_LOG_PREVIEW_CHARS = 80;

type OpenClawLogValue = string | number | boolean | Error;

interface OpenClawLogger {
  readonly info?: (...values: OpenClawLogValue[]) => void;
  readonly warn?: (...values: OpenClawLogValue[]) => void;
  readonly error?: (...values: OpenClawLogValue[]) => void;
  readonly debug?: (...values: OpenClawLogValue[]) => void;
}

/** The MoltZap account fields understood by this plugin. */
const moltZapAccountSchema = Schema.Struct({
  id: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
});

/** One OpenClaw account bound to the process-local MCP endpoint. */
export type MoltZapAccount = Schema.Schema.Type<typeof moltZapAccountSchema>;

const moltZapChannelConfigSchema = Schema.Struct({
  accounts: Schema.optional(Schema.Array(moltZapAccountSchema)),
});

/** OpenClaw configuration read by the channel plugin. */
export interface OpenClawConfig {
  readonly channels?: {
    readonly moltzap?: {
      readonly accounts?: readonly MoltZapAccount[];
    };
  };
}

/** The OpenClaw callback that receives one projected inbound turn. */
export type OpenClawReplyDispatcher = (params: {
  readonly ctx: Readonly<Record<string, string | undefined>>;
  readonly cfg: OpenClawConfig;
  readonly dispatcherOptions: { readonly deliver: OpenClawDeliver };
}) => PromiseLike<{ readonly queuedFinal: boolean }>;

/** What OpenClaw supplies when starting one configured account. */
export interface OpenClawStartAccountContext {
  readonly cfg: OpenClawConfig;
  readonly accountId: string;
  readonly account: MoltZapAccount;
  readonly abortSignal: AbortSignal;
  readonly log?: OpenClawLogger;
  readonly setStatus: (
    next: Readonly<Record<string, OpenClawLogValue>>,
  ) => void;
  readonly channelRuntime?: {
    readonly reply?: {
      readonly dispatchReplyWithBufferedBlockDispatcher?: OpenClawReplyDispatcher;
    };
  };
}

/** What OpenClaw supplies when stopping one configured account. */
export interface OpenClawStopAccountContext {
  readonly accountId: string;
  readonly log?: Pick<OpenClawLogger, "info">;
}

type OpenClawDeliver = (
  payload: { readonly text?: string; readonly body?: string },
  info?: { readonly kind?: string },
) => PromiseLike<boolean>;

interface OpenClawResolveTargetParams {
  readonly cfg: OpenClawConfig;
  readonly accountId?: string | null;
  readonly input: string;
  readonly normalized: string;
  readonly preferredKind?: "user" | "group" | "channel";
}

interface ResolvedAgentTarget {
  readonly to: string;
  readonly kind: "user";
  readonly display: AgentName;
}

interface ActiveHarnessClient {
  readonly client: HarnessClient;
  readonly stopSignal: Deferred.Deferred<undefined>;
}

/** Test injection point for a structural HarnessClient. */
export interface MoltzapChannelPluginDeps {
  readonly harnessClientForAccount?: (
    accountId: string,
    account: MoltZapAccount,
  ) => HarnessClient | undefined;
}

class DispatchInboundError extends Data.TaggedError("DispatchInboundError")<{
  readonly cause: Error;
}> {}

class MoltZapClientNotConnectedError extends Data.TaggedError(
  "MoltZapClientNotConnectedError",
)<{ readonly accountId: string }> {
  override get message(): string {
    return `MoltZap client not connected for account ${this.accountId}`;
  }
}

class MoltZapTargetMalformedError extends Data.TaggedError(
  "MoltZapTargetMalformedError",
)<{ readonly target: string }> {
  override get message(): string {
    return `MoltZap: invalid target "${this.target}" — ${TARGET_HINT.toLowerCase()}`;
  }
}

class OpenClawTargetResolved extends Data.TaggedClass(
  "OpenClawTargetResolved",
)<{ readonly to: string }> {
  readonly ok = true;
}

class OpenClawTargetRejected extends Data.TaggedClass(
  "OpenClawTargetRejected",
)<{ readonly error: Error }> {
  readonly ok = false;
}

class OpenClawSendTextSuccess extends Data.TaggedClass(
  "OpenClawSendTextSuccess",
)<Record<never, never>> {
  readonly ok = true;
}

class OpenClawSendTextFailure extends Data.TaggedClass(
  "OpenClawSendTextFailure",
)<{ readonly error: Error }> {
  readonly ok = false;
}

const isAgentName = Schema.is(AgentName);

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * Builds the JSON Schema embedded into the OpenClaw manifest.
 * @returns The generated OpenClaw channel configuration schema.
 */
export const makeMoltZapChannelConfigJsonSchema = () =>
  JSONSchema.make(moltZapChannelConfigSchema);

/**
 * Creates one OpenClaw plugin with account-local HarnessClient lifecycles.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Host as OpenClaw
 *   participant Plugin as MoltZap plugin
 *   participant Client as HarnessClient
 *   Host->>Plugin: startAccount
 *   Plugin->>Client: acquire scoped client
 *   Client-->>Plugin: one semantic HarnessTurn
 *   Plugin->>Host: dispatch current turn
 *   Host->>Plugin: deliver final content
 *   Plugin->>Client: invoke captured turn.reply
 * ```
 *
 * @param deps Optional structural Client injection used by tests and embedders.
 * @returns A fresh OpenClaw channel plugin.
 */
export function createMoltzapChannelPlugin(
  deps: MoltzapChannelPluginDeps = {},
) {
  const activeClients = new Map<string, ActiveHarnessClient>();
  return {
    id: CHANNEL_ID,
    meta: createPluginMeta(),
    capabilities: { chatTypes: ["dm" as const, "group" as const] },
    messaging: createMessagingSection(),
    config: createConfigSection(),
    gateway: {
      startAccount: (ctx: OpenClawStartAccountContext) =>
        startGatewayAccount(ctx, activeClients, deps),
      stopAccount: (ctx: OpenClawStopAccountContext) =>
        stopGatewayAccount(ctx, activeClients),
    },
    outbound: createOutboundSection(activeClients),
  };
}

/** The inferred OpenClaw plugin contract. */
export type MoltzapChannelPlugin = ReturnType<
  typeof createMoltzapChannelPlugin
>;

/** Shared plugin instance used by OpenClaw's extension loader. */
export const moltzapChannelPlugin: MoltzapChannelPlugin =
  createMoltzapChannelPlugin();

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
  return cfg.channels?.moltzap?.accounts ?? [];
}

function isCanonicalAgentTarget(raw: string): boolean {
  const target = raw.trim();
  return normalizeAgentTarget(target)?.to === target;
}

function normalizeAgentTarget(raw: string): ResolvedAgentTarget | null {
  const target = raw.trim();
  let name: string | null = target;
  if (target.startsWith(TARGET_PREFIX_AGENT)) {
    name = target.slice(TARGET_PREFIX_AGENT.length);
  } else if (target.includes(":")) {
    name = null;
  }
  return name === null || !isAgentName(name)
    ? null
    : { to: `${TARGET_PREFIX_AGENT}${name}`, kind: "user", display: name };
}

function buildInboundDispatchContext(
  accountId: string,
  turn: HarnessTurn,
): Readonly<Record<string, string | undefined>> {
  const body = renderContent(turn.content);
  const chatType = chatTypeFor(turn);
  const groupMembers =
    chatType === "group" ? memberNames(turn).join(",") : undefined;
  return {
    Body: body,
    BodyForAgent: body,
    From: `${TARGET_PREFIX_AGENT}${turn.author.agentName}`,
    To: accountId,
    SessionKey: `agent:main:moltzap:${chatType === "group" ? "group" : "dm"}:${turn.conversationId}`,
    AccountId: accountId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `conv:${turn.conversationId}`,
    ChatType: chatType,
    ...(groupMembers === undefined ? {} : { GroupMembers: groupMembers }),
    SenderName: turn.author.agentName,
  };
}

function renderContent(content: Content): string {
  return content.map(renderContentPart).join("\n");
}

function renderContentPart(part: Content[number]): string {
  if (part.type === "text") {
    return part.text;
  }
  return JSON.stringify(part.value) ?? "null";
}

function chatTypeFor(turn: HarnessTurn): "direct" | "group" {
  return turn.peers.length === 1 ? "direct" : "group";
}

function memberNames(turn: HarnessTurn): readonly string[] {
  const names = new Set<string>();
  names.add(turn.author.agentName);
  for (const peer of turn.peers) {
    names.add(peer.agentName);
  }
  return [...names].map((name) => `${TARGET_PREFIX_AGENT}${name}`);
}

function logReplyFailure(
  turn: HarnessTurn,
  cause: unknown,
  log?: OpenClawLogger,
): Effect.Effect<boolean> {
  return Effect.sync(() => {
    log?.error?.(
      `MoltZap: failed to send reply to ${turn.conversationId}: ${asError(cause).message}`,
    );
    return false;
  });
}

function sendDeliveredReply(
  turn: HarnessTurn,
  text: string,
  log?: OpenClawLogger,
): Effect.Effect<boolean> {
  return turn.reply(textContent(text)).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        log?.info?.(
          `MoltZap: outbound reply to ${turn.conversationId}: ${text.slice(0, OUTBOUND_LOG_PREVIEW_CHARS)}`,
        );
      }),
    ),
    Effect.as(true),
    Effect.catchAll((cause) => logReplyFailure(turn, cause, log)),
  );
}

function textContent(text: string): Content {
  return [{ type: "text", text }];
}

function createReplyDeliver(
  turn: HarnessTurn,
  log?: OpenClawLogger,
): OpenClawDeliver {
  return (payload, info) => {
    if (info?.kind !== "final") {
      return Promise.resolve(true);
    }
    const text = payload.text ?? payload.body;
    if (text === undefined || text.length === 0) {
      return Promise.resolve(true);
    }
    return Effect.runPromise(sendDeliveredReply(turn, text, log));
  };
}

function handleTurn(
  ctx: OpenClawStartAccountContext,
  turn: HarnessTurn,
): Effect.Effect<void> {
  return Effect.sync(() => {
    const body = renderContent(turn.content);
    ctx.log?.info?.(
      `MoltZap: inbound from agent:${turn.author.agentName}: ${body.slice(0, INBOUND_LOG_PREVIEW_CHARS)}`,
    );
    ctx.setStatus({
      accountId: ctx.accountId,
      lastInboundAt: Date.now(),
      lastEventAt: Date.now(),
    });
  }).pipe(
    Effect.zipRight(dispatchTurn(ctx, turn)),
    Effect.catchAll(() => Effect.void),
    Effect.catchAllDefect((cause) =>
      Effect.sync(() => {
        ctx.log?.error?.(
          `MoltZap: inbound dispatch failed for ${turn.conversationId}: ${asError(cause).message}`,
        );
      }),
    ),
  );
}

function dispatchTurn(
  ctx: OpenClawStartAccountContext,
  turn: HarnessTurn,
): Effect.Effect<void, DispatchInboundError> {
  const dispatch =
    ctx.channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (dispatch === undefined) {
    return Effect.sync(() => {
      ctx.log?.warn?.(
        `MoltZap: no OpenClaw reply dispatcher for ${turn.conversationId}`,
      );
    });
  }
  return Effect.tryPromise({
    try: () =>
      dispatch({
        ctx: buildInboundDispatchContext(ctx.accountId, turn),
        cfg: ctx.cfg,
        dispatcherOptions: { deliver: createReplyDeliver(turn, ctx.log) },
      }),
    catch: (cause) => new DispatchInboundError({ cause: asError(cause) }),
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        ctx.log?.error?.(`MoltZap: dispatch error: ${error.cause.message}`);
      }),
    ),
    Effect.tap((result) =>
      Effect.sync(() => {
        if (!result.queuedFinal) {
          ctx.log?.debug?.(
            `MoltZap: dispatch completed without final reply for ${turn.conversationId}`,
          );
        }
      }),
    ),
    Effect.asVoid,
  );
}

function startGatewayAccount(
  ctx: OpenClawStartAccountContext,
  activeClients: Map<string, ActiveHarnessClient>,
  deps: MoltzapChannelPluginDeps,
) {
  if (ctx.abortSignal.aborted) {
    return Promise.resolve();
  }
  return Effect.runPromise(
    acquireAccountClient(deps, ctx.accountId, ctx.account).pipe(
      Effect.flatMap((client) => runGateway(ctx, client, activeClients)),
      Effect.scoped,
    ),
  );
}

function stopGatewayAccount(
  ctx: OpenClawStopAccountContext,
  activeClients: Map<string, ActiveHarnessClient>,
) {
  if (activeClients.has(ctx.accountId)) {
    ctx.log?.info?.("MoltZap: stopping");
  }
  return Effect.runPromise(
    stopActiveGatewayAccount(activeClients, ctx.accountId),
  );
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
  activeClients: Map<string, ActiveHarnessClient>,
  accountId: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const active = activeClients.get(accountId);
    if (active === undefined) {
      return;
    }
    activeClients.delete(accountId);
    yield* Deferred.succeed(active.stopSignal, undefined);
  });
}

function finishActiveGatewayAccount(
  activeClients: Map<string, ActiveHarnessClient>,
  accountId: string,
  active: ActiveHarnessClient,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (activeClients.get(accountId) === active) {
      activeClients.delete(accountId);
    }
  });
}

function acquireAccountClient(
  deps: MoltzapChannelPluginDeps,
  accountId: string,
  account: MoltZapAccount,
): Effect.Effect<HarnessClient, Error, Scope.Scope> {
  const injected = deps.harnessClientForAccount?.(accountId, account);
  if (injected !== undefined) {
    return Effect.succeed(injected);
  }
  return configuredMcpEndpoint().pipe(
    Effect.flatMap(acquireHarnessClient),
    Effect.mapError(asError),
  );
}

function configuredMcpEndpoint() {
  return Config.url("MOLTZAP_MCP_URL");
}

function reportConnected(
  ctx: OpenClawStartAccountContext,
): Effect.Effect<void> {
  return Effect.sync(() => {
    ctx.log?.info?.(`MoltZap: connected for account ${ctx.accountId}`);
    ctx.setStatus({
      accountId: ctx.accountId,
      connected: true,
      lastConnectedAt: Date.now(),
    });
  });
}

function runGateway(
  ctx: OpenClawStartAccountContext,
  client: HarnessClient,
  activeClients: Map<string, ActiveHarnessClient>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stopSignal = yield* Deferred.make<undefined>();
    const active = { client, stopSignal };
    yield* stopActiveGatewayAccount(activeClients, ctx.accountId);
    activeClients.set(ctx.accountId, active);
    yield* reportConnected(ctx);
    yield* Effect.raceFirst(
      client.turns.pipe(Stream.runForEach((turn) => handleTurn(ctx, turn))),
      Effect.raceFirst(
        waitForAbort(ctx.abortSignal),
        Deferred.await(stopSignal),
      ),
    );
    yield* finishActiveGatewayAccount(activeClients, ctx.accountId, active);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        ctx.setStatus({ accountId: ctx.accountId, connected: false });
      }),
    ),
    Effect.catchAll((cause) =>
      Effect.sync(() => {
        ctx.log?.error?.(
          `MoltZap: connection failed for ${ctx.accountId}: ${asError(cause).message}`,
        );
      }),
    ),
  );
}

function activeClient(
  activeClients: Map<string, ActiveHarnessClient>,
  accountId?: string | null,
): HarnessClient | undefined {
  const requested = accountId?.trim();
  if (requested !== undefined && requested.length > 0) {
    return activeClients.get(requested)?.client;
  }
  if (activeClients.size !== 1) {
    return undefined;
  }
  return activeClients.values().next().value?.client;
}

function startOutbound(
  client: HarnessClient,
  target: ResolvedAgentTarget,
  text: string,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const conversationId = yield* createConversationId();
    const input: StartInput = {
      conversationId,
      peers: [target.display],
      content: textContent(text),
    };
    yield* client.start(input);
  }).pipe(Effect.mapError(asError));
}

function sendTextEffect(
  activeClients: Map<string, ActiveHarnessClient>,
  ctx: {
    readonly cfg: OpenClawConfig;
    readonly to: string;
    readonly text: string;
    readonly accountId?: string | null;
  },
) {
  return Effect.gen(function* () {
    const client = activeClient(activeClients, ctx.accountId);
    if (client === undefined) {
      return yield* new MoltZapClientNotConnectedError({
        accountId: ctx.accountId ?? "(unspecified)",
      });
    }
    const target = normalizeAgentTarget(ctx.to);
    if (target === null) {
      return yield* new MoltZapTargetMalformedError({ target: ctx.to });
    }
    yield* startOutbound(client, target, ctx.text);
    return new OpenClawSendTextSuccess();
  }).pipe(
    Effect.match({
      onSuccess: (result) => result,
      onFailure: (cause) =>
        new OpenClawSendTextFailure({ error: asError(cause) }),
    }),
  );
}

function createMessagingSection() {
  return {
    targetResolver: {
      looksLikeId: isCanonicalAgentTarget,
      hint: TARGET_HINT,
      resolveTarget(params: OpenClawResolveTargetParams) {
        const target = normalizeAgentTarget(params.normalized);
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

function createOutboundSection(
  activeClients: Map<string, ActiveHarnessClient>,
) {
  return {
    deliveryMode: "gateway" as const,
    resolveTarget(params: { readonly to?: string }) {
      const target =
        params.to === undefined ? null : normalizeAgentTarget(params.to);
      return target === null
        ? new OpenClawTargetRejected({
            error: new MoltZapTargetMalformedError({ target: params.to ?? "" }),
          })
        : new OpenClawTargetResolved({ to: target.to });
    },
    sendText(ctx: {
      readonly cfg: OpenClawConfig;
      readonly to: string;
      readonly text: string;
      readonly accountId?: string | null;
    }) {
      return Effect.runPromise(sendTextEffect(activeClients, ctx));
    },
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

const plugin = {
  id: "openclaw-channel",
  name: "MoltZap",
  description: "Agent-to-agent messaging through the local MoltZap endpoint",
  configSchema: {},
  register(api: {
    readonly registerChannel: (params: {
      readonly plugin: MoltzapChannelPlugin;
    }) => void;
  }) {
    api.registerChannel({ plugin: moltzapChannelPlugin });
  },
};

// eslint-disable-next-line import-x/no-default-export -- OpenClaw discovers plugins through a required default export.
export default plugin;
