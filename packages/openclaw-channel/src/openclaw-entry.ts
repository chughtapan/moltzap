/**
 * OpenClaw plugin entry point for MoltZap.
 *
 * Wraps the existing MoltZapAgentClient + mapping modules into the
 * ChannelPlugin shape expected by OpenClaw's api.registerChannel().
 *
 * Installed via: openclaw plugin install `@moltzap/openclaw-channel`
 * Config:        channels.moltzap.accounts[].{id, agentName}.
 *
 * OpenClaw's plugin interface imposes Promise-based contracts at the boundary
 * (`startAccount`, `sendText`, `deliver`, `listPeers`, `listGroups`, etc.) —
 * those shapes are fixed. Internally we use Effect and only pay the
 * `Effect.runPromise` tax at the plugin surface.
 */

import { harnessClientForProfile } from "@moltzap/client";
import type {
  HarnessClientService,
  HarnessTurn,
} from "@moltzap/client/harness-client";
import {
  formatCrossConv,
  getGroupFields,
  type CrossConvMessage,
  type GroupFields,
} from "@moltzap/client/channel-base";
import {
  Config,
  ConfigProvider,
  Data,
  Deferred,
  Effect,
  JSONSchema,
  Option,
  Schema,
  Stream,
} from "effect";
import {
  writeOpenClawContextLog,
  type OpenClawContextLogInput,
} from "./context-log.js";
import { createHarnessReplyDeliver } from "./harness-turn-delivery.js";
import {
  finishHarnessClient,
  stopActiveGatewayAccount,
  type ActiveHarnessClient,
} from "./openclaw-gateway-lifecycle.js";
import {
  isMoltZapTarget,
  normalizeMoltZapTarget,
  TARGET_HINT,
  TARGET_PREFIX_CONVERSATION,
} from "./openclaw-target.js";

const CHANNEL_ID = "moltzap";
const INBOUND_LOG_PREVIEW_CHARS = 80;
const BODY_FOR_AGENT_LOG_PREVIEW_CHARS = 500;

class DispatchInboundError extends Data.TaggedError("DispatchInboundError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const openClawContextLogDir = Config.option(
  Config.string("MOLTZAP_OPENCLAW_CONTEXT_LOG_DIR"),
);

function readOpenClawContextLogDir(): string | undefined {
  return Option.getOrUndefined(
    Effect.runSync(
      openClawContextLogDir.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ),
  );
}

class MoltZapClientNotConnectedError extends Data.TaggedError(
  "MoltZapClientNotConnectedError",
)<{
  readonly accountId: string;
}> {
  override get message(): string {
    return `MoltZap client not connected for account ${this.accountId}`;
  }
}

class MoltZapConversationTargetUnsupportedError extends Data.TaggedError(
  "MoltZapConversationTargetUnsupportedError",
)<{
  readonly accountId: string;
}> {
  override get message(): string {
    return `MoltZap Harness client for account ${this.accountId} cannot send into an existing conversation`;
  }
}

class MoltZapAccountProfileMissingError extends Data.TaggedError(
  "MoltZapAccountProfileMissingError",
)<Record<never, never>> {
  override get message(): string {
    return "MoltZap OpenClaw account id is required and must name a MoltZap profile";
  }
}

class OpenClawTargetResolved extends Data.TaggedClass(
  "OpenClawTargetResolved",
)<{
  readonly to: string;
}> {
  readonly ok = true;
}

class OpenClawTargetRejected extends Data.TaggedClass(
  "OpenClawTargetRejected",
)<{
  readonly error: Error;
}> {
  readonly ok = false;
}

type OpenClawTargetResolveResult =
  | OpenClawTargetResolved
  | OpenClawTargetRejected;

class OpenClawSendTextSuccess extends Data.TaggedClass(
  "OpenClawSendTextSuccess",
)<Record<never, never>> {
  readonly ok = true;
}

class OpenClawSendTextFailure extends Data.TaggedClass(
  "OpenClawSendTextFailure",
)<{
  readonly error: Error;
}> {
  readonly ok = false;
}

function logContextLogWriteFailure(
  error: unknown,
  log?: OpenClawLogger,
): Effect.Effect<void> {
  return Effect.sync(() => {
    log?.warn?.(
      `MoltZap: failed to write OpenClaw context log: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function writeContextLogOrWarn(
  input: OpenClawContextLogInput,
  log?: OpenClawLogger,
): Effect.Effect<void> {
  return writeOpenClawContextLog(input).pipe(
    Effect.catchAll((error) => logContextLogWriteFailure(error, log)),
  );
}

const moltZapAccountSchema = Schema.Struct({
  id: Schema.String,
  agentName: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
});

type MoltZapAccount = Schema.Schema.Type<typeof moltZapAccountSchema>;

const moltZapChannelConfigSchema = Schema.Struct({
  accounts: Schema.optional(Schema.Array(moltZapAccountSchema)),
});

/**
 * The drift test consumes this projection because OpenClaw reads the manifest
 * from disk.
 * @internal
 * @returns The created molt zap channel config json schema.
 */
export const makeMoltZapChannelConfigJsonSchema = () =>
  JSONSchema.make(moltZapChannelConfigSchema);

/** OpenClaw's config object; the plugin reads only its `channels.moltzap` section. */
export interface OpenClawConfig {
  readonly [key: string]: unknown;
  readonly channels?: {
    readonly moltzap?: {
      readonly accounts?: readonly MoltZapAccount[];
    };
  };
}

interface OpenClawLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

type OpenClawDeliver = (
  payload: { text?: string; body?: string },
  info?: { kind?: string },
) => PromiseLike<boolean>;

type OpenClawReplyDispatcher = (params: {
  ctx: Record<string, string | undefined>;
  cfg: OpenClawConfig;
  dispatcherOptions: { deliver: OpenClawDeliver };
}) => PromiseLike<{ queuedFinal: boolean }>;

/** What OpenClaw hands the plugin when it starts one configured account. */
export interface OpenClawStartAccountContext {
  cfg: OpenClawConfig;
  accountId: string;
  account: MoltZapAccount;
  abortSignal: AbortSignal;
  log?: OpenClawLogger;
  setStatus: (next: Record<string, unknown>) => void;
  channelRuntime?: {
    reply?: {
      dispatchReplyWithBufferedBlockDispatcher?: OpenClawReplyDispatcher;
    };
  };
}

/** What OpenClaw hands the plugin when it stops one configured account. */
export interface OpenClawStopAccountContext {
  accountId: string;
  log?: Pick<OpenClawLogger, "info">;
}

interface InboundDispatchInput {
  readonly accountId: string;
  readonly account: MoltZapAccount;
  readonly cfg: OpenClawConfig;
  readonly chatType: "direct" | "group";
  readonly fromId: string;
  readonly bodyForAgent: string;
  readonly groupMembers?: string;
  readonly groupSubject?: string;
  readonly turn: HarnessTurn;
}

interface MoltzapChannelPluginDeps {
  /**
   * Selects a caller-acquired client for one configured account. The plugin
   * owns only its turn drain and never discovers, acquires, or closes the
   * returned client.
   */
  readonly harnessClientForAccount?: (
    profileName: string,
    account: MoltZapAccount,
  ) => HarnessClientService | undefined;
}

/** One target-resolution request from OpenClaw's targeting layer. */
export interface OpenClawResolveTargetParams {
  readonly cfg: OpenClawConfig;
  readonly accountId?: string | null;
  readonly input: string;
  readonly normalized: string;
  readonly preferredKind?: "user" | "group" | "channel";
}

interface InboundHandlerParams {
  readonly ctx: OpenClawStartAccountContext;
  readonly ownAgentId?: string;
  readonly contextLogDir?: string;
  readonly turn: HarnessTurn;
}

interface InboundRuntimeData {
  readonly chatType: "direct" | "group";
  readonly fromId: string;
  readonly crossConvBlock: string | null;
  readonly crossConversationMessages: readonly CrossConvMessage[];
  readonly bodyForAgent: string;
  readonly groupSubject?: string;
  readonly groupMembers?: string;
}

function resolveAccountList(cfg: OpenClawConfig): readonly MoltZapAccount[] {
  const section = cfg.channels?.moltzap;
  if (!section) {
    return [];
  }
  return section.accounts ?? [];
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): MoltZapAccount {
  const accounts = resolveAccountList(cfg);
  if (accountId === undefined || accountId === null) {
    return { id: "", enabled: false };
  }
  return (
    accounts.find((a) => a.id === accountId) ?? {
      id: accountId,
      enabled: false,
    }
  );
}

/**
 * Wait for an AbortSignal to fire, as an Effect. Completes synchronously if
 * the signal is already aborted; otherwise registers a one-shot `abort`
 * listener and resolves when it fires.
 * @param signal Value supplied to the operation.
 * @returns The log outbound reply result.
 */
const waitForAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.async<undefined>((resume) => {
    if (signal.aborted) {
      resume(Effect.void.pipe(Effect.as(undefined)));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resume(Effect.void.pipe(Effect.as(undefined)));
      },
      { once: true },
    );
  });

/**
 * Render the reply-to target for an inbound message. The conversation is the
 * whole address.
 * @param turn Value supplied to the operation.
 * @returns The originating target string.
 */
function originatingTarget(turn: HarnessTurn): string {
  return `${TARGET_PREFIX_CONVERSATION}${turn.conversationId}`;
}

function buildInboundDispatchContext(
  input: InboundDispatchInput,
): Record<string, string | undefined> {
  return {
    Body: input.turn.text,
    BodyForAgent: input.bodyForAgent,
    From: input.fromId,
    To: input.account.agentName ?? input.accountId,
    SessionKey: `agent:main:moltzap:${input.chatType === "group" ? "group" : "dm"}:${input.turn.conversationId}`,
    AccountId: input.accountId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: originatingTarget(input.turn),
    ChatType: input.chatType,
    ...(input.groupSubject ? { GroupSubject: input.groupSubject } : {}),
    ...(input.groupMembers ? { GroupMembers: input.groupMembers } : {}),
    ...(input.turn.conversationMeta?.name
      ? { ConversationLabel: input.turn.conversationMeta.name }
      : {}),
    SenderName: input.turn.sender.name,
  };
}

function logDispatchError(
  err: unknown,
  log?: OpenClawLogger,
): Effect.Effect<void> {
  return Effect.sync(() => {
    log?.error?.(`MoltZap: dispatch error: ${err}`);
  });
}

function dispatchInboundReply(params: {
  readonly dispatch: OpenClawReplyDispatcher;
  readonly input: InboundDispatchInput;
  readonly log?: OpenClawLogger;
}): Effect.Effect<{ queuedFinal: boolean }, unknown> {
  return Effect.tryPromise({
    try: () =>
      params.dispatch({
        ctx: buildInboundDispatchContext(params.input),
        cfg: params.input.cfg,
        dispatcherOptions: {
          deliver: createHarnessReplyDeliver({
            turn: params.input.turn,
            log: params.log,
          }),
        },
      }),
    catch: (err: unknown) =>
      new DispatchInboundError({
        cause: err,
        message: err instanceof Error ? err.message : String(err),
      }),
  }).pipe(Effect.tapError((err) => logDispatchError(err, params.log)));
}

function createPluginMeta() {
  return {
    id: CHANNEL_ID,
    label: "MoltZap",
    selectionLabel: "MoltZap (agent messaging)",
    docsPath: "/channels/moltzap",
    docsLabel: "moltzap",
    blurb: "Agent-to-agent messaging via the MoltZap protocol.",
    detailLabel: "MoltZap",
    aliases: ["mz"],
    order: 200,
  };
}

function createMessagingSection() {
  return {
    targetResolver: {
      looksLikeId(raw: string): boolean {
        return isMoltZapTarget(raw);
      },
      hint: TARGET_HINT,
      resolveTarget(params: OpenClawResolveTargetParams) {
        const target = normalizeMoltZapTarget(params.normalized);
        if (target === null) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          ...target,
          source: "normalized",
        });
      },
    },
  };
}

function createConfigSection() {
  return {
    listAccountIds(cfg: OpenClawConfig): string[] {
      const accounts = resolveAccountList(cfg);
      return accounts.map((account) => account.id).filter((id) => id !== "");
    },
    resolveAccount(cfg: OpenClawConfig, accountId?: string | null) {
      if (accountId === undefined || accountId === null) {
        return resolveAccount(cfg);
      }
      return resolveAccount(cfg, accountId);
    },
    isConfigured(account: MoltZapAccount): boolean {
      return account.enabled !== false && account.id.trim().length > 0;
    },
    unconfiguredReason(): string {
      return "MoltZap account id must match a configured MoltZap profile";
    },
    isEnabled(account: MoltZapAccount): boolean {
      return account.enabled !== false;
    },
  };
}

function createGatewaySection(
  activeHarnessClients: Map<string, ActiveHarnessClient>,
  deps: MoltzapChannelPluginDeps,
) {
  return {
    startAccount(ctx: OpenClawStartAccountContext) {
      return startGatewayAccount(ctx, activeHarnessClients, deps);
    },
    stopAccount(ctx: OpenClawStopAccountContext) {
      return stopGatewayAccount(ctx, activeHarnessClients);
    },
  };
}

function startGatewayAccount(
  ctx: OpenClawStartAccountContext,
  activeHarnessClients: Map<string, ActiveHarnessClient>,
  deps: MoltzapChannelPluginDeps,
) {
  return Effect.runPromise(
    startGatewayAccountEffect(ctx, activeHarnessClients, deps),
  );
}

function startGatewayAccountEffect(
  ctx: OpenClawStartAccountContext,
  activeHarnessClients: Map<string, ActiveHarnessClient>,
  deps: MoltzapChannelPluginDeps,
): Effect.Effect<void, unknown> {
  const { accountId, account, abortSignal, log } = ctx;
  const profileName = accountId.trim();
  const contextLogDir = readOpenClawContextLogDir();
  log?.info?.(`MoltZap: connecting as ${account.agentName ?? accountId}`);
  return Effect.gen(function* () {
    if (profileName.length === 0) {
      return yield* new MoltZapAccountProfileMissingError();
    }
    if (abortSignal.aborted) {
      return;
    }
    // The OpenClaw account id names the profile slot, so the daemon, its
    // loopback endpoint, and the checkpoint store all follow from it.
    const injected = deps.harnessClientForAccount?.(profileName, account);
    const harnessClient =
      injected ?? (yield* harnessClientForProfile(profileName));
    return yield* runHarnessGateway(ctx, harnessClient, {
      activeHarnessClients,
      contextLogDir,
    });
  }).pipe(Effect.scoped);
}

interface HarnessGatewayRuntime {
  readonly activeHarnessClients: Map<string, ActiveHarnessClient>;
  readonly contextLogDir?: string;
}

function runHarnessGateway(
  ctx: OpenClawStartAccountContext,
  client: HarnessClientService,
  runtime: HarnessGatewayRuntime,
): Effect.Effect<void, unknown> {
  const { activeHarnessClients, contextLogDir } = runtime;
  return Effect.gen(function* () {
    const stopSignal = yield* Deferred.make<undefined>();
    const active = { client, stopSignal };
    yield* stopActiveGatewayAccount(activeHarnessClients, ctx.accountId);
    yield* Effect.sync(() => activeHarnessClients.set(ctx.accountId, active));
    yield* reportHarnessConnected(client, ctx).pipe(
      Effect.zipRight(
        Effect.raceFirst(
          client.turns.pipe(
            Stream.runForEach((turn) =>
              handleInboundMessage({
                ctx,
                ownAgentId: client.agentId,
                contextLogDir,
                turn,
              }).pipe(
                Effect.withSpan("createMoltzapChannelPlugin.inboundDispatch"),
                Effect.catchAll((cause) =>
                  logHarnessTurnFailure(turn, cause, ctx.log),
                ),
                Effect.catchAllDefect((cause) =>
                  logHarnessTurnFailure(turn, cause, ctx.log),
                ),
              ),
            ),
          ),
          Effect.raceFirst(
            waitForAbort(ctx.abortSignal),
            Deferred.await(stopSignal),
          ),
        ),
      ),
      Effect.ensuring(
        finishHarnessClient(activeHarnessClients, ctx.accountId, active),
      ),
    );
  });
}

function logHarnessTurnFailure(
  turn: HarnessTurn,
  cause: unknown,
  log?: OpenClawLogger,
): Effect.Effect<void> {
  return Effect.sync(() => {
    log?.error?.(
      `MoltZap: inbound dispatch failed for ${turn.conversationId}: ${String(cause)}`,
    );
  });
}

function reportHarnessConnected(
  client: HarnessClientService,
  ctx: OpenClawStartAccountContext,
): Effect.Effect<void> {
  return Effect.sync(() => {
    ctx.log?.info?.(
      `MoltZap: connected as ${ctx.account.agentName} (${client.agentId})`,
    );
    ctx.setStatus({
      accountId: ctx.accountId,
      connected: true,
      lastConnectedAt: Date.now(),
    });
  });
}

function handleInboundMessage(params: InboundHandlerParams) {
  return Effect.gen(function* () {
    const data = inboundRuntimeData(params.turn, params.ownAgentId);
    logInboundMessage(params.turn, data.fromId, params.ctx.log);
    touchInboundStatus(params.ctx);
    yield* writeInboundContextLog(params, data);
    logCrossConversationContext(params.turn, data, params.ctx.log);
    const dispatch =
      params.ctx.channelRuntime?.reply
        ?.dispatchReplyWithBufferedBlockDispatcher;
    if (!dispatch) {
      logMissingDispatcher(params.turn.conversationId, params.ctx.log);
      return;
    }
    const result = yield* dispatchInboundReply({
      dispatch,
      input: inboundDispatchInput(params.ctx, params.turn, data),
      log: params.ctx.log,
    });
    logDispatchFinished(params.turn, params.ctx.log);
    logUnqueuedDispatch(params.turn, result, params.ctx.log);
  });
}

function inboundRuntimeData(
  turn: HarnessTurn,
  ownAgentId?: string,
): InboundRuntimeData {
  const groupFields = getGroupFields(turn.conversationMeta);
  const crossConversationMessages = crossConversationMessagesFor(turn);
  const crossConvBlock = formatCrossConv(crossConversationMessages, {
    ownAgentId: ownAgentId ?? "",
    markup: "json-header",
  });
  return {
    chatType: groupFields !== null ? "group" : "direct",
    fromId: `agent:${turn.sender.id}`,
    crossConvBlock,
    crossConversationMessages,
    bodyForAgent: bodyForAgent(turn.text, crossConvBlock),
    groupSubject: groupFields?.name,
    groupMembers: groupMembersFor(groupFields),
  };
}

function crossConversationMessagesFor(
  turn: HarnessTurn,
): readonly CrossConvMessage[] {
  return turn.contextBlocks.crossConversationMessages ?? [];
}

function bodyForAgent(text: string, crossConvBlock: string | null): string {
  return crossConvBlock ? `${crossConvBlock}\n\n${text}` : text;
}

// `groupMembersFor` stays openclaw-local because the comma-joined string
// format is openclaw-specific (the `GroupMembers` dispatch-context field
// shape). Channel-base's `getGroupFields` provides the narrowing; this helper
// does the openclaw-side join.
function groupMembersFor(fields: GroupFields | null): string | undefined {
  if (fields === null) {
    return undefined;
  }
  return fields.participants.join(",");
}

function logInboundMessage(
  turn: HarnessTurn,
  fromId: string,
  log?: OpenClawLogger,
): void {
  log?.info?.(
    `MoltZap: inbound from ${fromId}: ${turn.text.slice(0, INBOUND_LOG_PREVIEW_CHARS)}`,
  );
}

function touchInboundStatus(ctx: OpenClawStartAccountContext): void {
  ctx.setStatus({
    accountId: ctx.accountId,
    lastInboundAt: Date.now(),
    lastEventAt: Date.now(),
  });
}

function writeInboundContextLog(
  params: InboundHandlerParams,
  data: InboundRuntimeData,
) {
  return writeContextLogOrWarn(
    {
      logDir: params.contextLogDir,
      accountId: params.ctx.accountId,
      accountAgentName: params.ctx.account.agentName,
      ownAgentId: params.ownAgentId,
      conversationId: params.turn.conversationId,
      conversationName: params.turn.conversationMeta?.name,
      conversationType: data.chatType,
      from: data.fromId,
      to: params.ctx.account.agentName ?? params.ctx.accountId,
      body: params.turn.text,
      bodyForAgent: data.bodyForAgent,
      crossConversationMessages: data.crossConversationMessages,
    },
    params.ctx.log,
  );
}

function logCrossConversationContext(
  turn: HarnessTurn,
  data: InboundRuntimeData,
  log?: OpenClawLogger,
): void {
  if (!data.crossConvBlock) {
    return;
  }
  log?.info?.(
    `MoltZap: BodyForAgent has cross-conv context (${data.crossConversationMessages.length} msgs) for ${turn.conversationId}: ${data.bodyForAgent.slice(0, BODY_FOR_AGENT_LOG_PREVIEW_CHARS)}`,
  );
}

function logMissingDispatcher(
  conversationId: string,
  log?: OpenClawLogger,
): void {
  log?.warn?.(`MoltZap: no OpenClaw reply dispatcher for ${conversationId}`);
}

function inboundDispatchInput(
  ctx: OpenClawStartAccountContext,
  turn: HarnessTurn,
  data: InboundRuntimeData,
): InboundDispatchInput {
  return {
    accountId: ctx.accountId,
    account: ctx.account,
    cfg: ctx.cfg,
    chatType: data.chatType,
    fromId: data.fromId,
    bodyForAgent: data.bodyForAgent,
    groupMembers: data.groupMembers,
    groupSubject: data.groupSubject,
    turn,
  };
}

function logDispatchFinished(turn: HarnessTurn, log?: OpenClawLogger): void {
  log?.info?.(
    `MoltZap: dispatch finished for ${turn.conversationId} message ${turn.id}`,
  );
}

function logUnqueuedDispatch(
  turn: HarnessTurn,
  result: { readonly queuedFinal: boolean },
  log?: OpenClawLogger,
): void {
  if (result.queuedFinal) {
    return;
  }
  log?.debug?.(
    `MoltZap: dispatch completed without final reply for ${turn.conversationId}`,
  );
}

function stopGatewayAccount(
  ctx: OpenClawStopAccountContext,
  activeHarnessClients: Map<string, ActiveHarnessClient>,
) {
  if (activeHarnessClients.has(ctx.accountId)) {
    ctx.log?.info?.("MoltZap: stopping");
  }
  return Effect.runPromise(
    stopActiveGatewayAccount(activeHarnessClients, ctx.accountId),
  );
}

function createOutboundSection(
  activeHarnessClients: Map<string, ActiveHarnessClient>,
) {
  return {
    deliveryMode: "gateway" as const,
    resolveTarget(params: {
      to?: string;
      cfg?: OpenClawConfig;
      accountId?: string | null;
      mode?: string;
    }): OpenClawTargetResolveResult {
      return resolveOutboundTarget(params.to);
    },
    sendText(ctx: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
    }) {
      return Effect.runPromise(sendTextEffect(activeHarnessClients, ctx));
    },
  };
}

function resolveOutboundTarget(toInput?: string) {
  const to = toInput?.trim();
  if (!to) {
    return new OpenClawTargetRejected({
      error: new Error("MoltZap: target is required"),
    });
  }
  const target = normalizeMoltZapTarget(to);
  if (target === null) {
    return new OpenClawTargetRejected({
      error: new Error(
        `MoltZap: unsupported target "${to}" — ${TARGET_HINT.toLowerCase()}`,
      ),
    });
  }
  return new OpenClawTargetResolved({ to: target.to });
}

class MoltZapTargetMalformedError extends Data.TaggedError(
  "MoltZapTargetMalformedError",
)<{ readonly target: string }> {
  override get message(): string {
    return `MoltZap: invalid target "${this.target}" — ${TARGET_HINT.toLowerCase()}`;
  }
}

interface ActiveHarnessOutbound {
  readonly _tag: "harness";
  readonly accountId: string;
  readonly client: HarnessClientService;
}

type ActiveOutbound = ActiveHarnessOutbound;

function getActiveOutbound(
  activeHarnessClients: Map<string, ActiveHarnessClient>,
  accountId?: string | null,
): ActiveOutbound | undefined {
  const requested = accountId?.trim();
  if (requested) {
    const harness = activeHarnessClients.get(requested);
    return harness === undefined
      ? undefined
      : { _tag: "harness", accountId: requested, client: harness.client };
  }
  if (activeHarnessClients.size !== 1) {
    return undefined;
  }
  const first = activeHarnessClients.entries().next().value;
  return first === undefined
    ? undefined
    : { _tag: "harness", accountId: first[0], client: first[1].client };
}

function dispatchHarnessOutbound(
  client: HarnessClientService,
  accountId: string,
  ctx: {
    readonly to: string;
    readonly text: string;
  },
): Effect.Effect<void, Error> {
  const target = normalizeMoltZapTarget(ctx.to);
  if (target === null) {
    return Effect.fail(new MoltZapTargetMalformedError({ target: ctx.to }));
  }
  if (target.kind === "group") {
    return Effect.fail(
      new MoltZapConversationTargetUnsupportedError({ accountId }),
    );
  }
  return client
    .startConversation([target.display], ctx.text)
    .pipe(Effect.asVoid);
}

function sendTextEffect(
  activeHarnessClients: Map<string, ActiveHarnessClient>,
  ctx: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
  },
) {
  const requestedAccountId = ctx.accountId ?? "(unspecified)";
  return Effect.gen(function* () {
    const active = getActiveOutbound(activeHarnessClients, ctx.accountId);
    if (active === undefined) {
      return yield* new MoltZapClientNotConnectedError({
        accountId: requestedAccountId,
      });
    }
    yield* dispatchHarnessOutbound(active.client, active.accountId, ctx);
    return new OpenClawSendTextSuccess();
  }).pipe(
    Effect.withSpan("createMoltzapChannelPlugin.sendText"),
    Effect.match({
      onSuccess: (ok) => ok,
      onFailure: (err) =>
        new OpenClawSendTextFailure({
          error: err instanceof Error ? err : new Error(String(err)),
        }),
    }),
  );
}

/**
 * Factory: returns a fresh plugin object whose `activeClients` map
 * lives in this closure. `register(api)` calls this so each
 * registration gets its own per-plugin state.
 *
 * The plugin exposes the openclaw lifecycle hooks (`startAccount`,
 * `stopAccount`), the outbound `sendText`, the inbound `onInbound`
 * adapter (registered inside `startAccount`), the `deliver` callback,
 * and `resolveTarget` for openclaw's targeting layer.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant OC as openclaw runtime
 *   participant Plugin as moltzap plugin
 *   participant Harness as HarnessClient
 *   participant Daemon as moltzapd
 *   OC->>Plugin: startAccount(ctx)
 *   Plugin->>Harness: harnessClientForProfile(accountId)
 *   Harness->>Daemon: start the slot child and connect over loopback MCP
 *   Plugin->>Harness: drain turns sequentially
 *   Harness-->>Plugin: HarnessTurn carrying its bound reply
 *   Plugin->>OC: dispatchReplyWithBufferedBlockDispatcher
 *   note over OC: agent pipeline → LLM
 *   OC->>Plugin: deliver(payload, opts) — createHarnessReplyDeliver
 *   Plugin->>Plugin: turn.reply(text)
 *   Harness->>Daemon: reply routed to its originating conversation
 *   OC->>Plugin: stopAccount(ctx)
 *   Plugin->>Plugin: signal the drain to stop
 * ```
 *
 * `deliver` returns `PromiseLike&lt;boolean>` per openclaw contract;
 * false signals a failed send without throwing.
 *
 * `resolveTarget` accepts a plain agent name or `agent:&lt;name>` for a DM and
 * `conv:&lt;conversationId>` for an existing conversation. Plain names normalize
 * to `agent:&lt;name>`. Other colon-prefixed shapes are rejected.
 * @param deps Value supplied to the operation.
 * @returns The created moltzap channel plugin.
 */
export function createMoltzapChannelPlugin(
  deps: MoltzapChannelPluginDeps = {},
) {
  const activeHarnessClients = new Map<string, ActiveHarnessClient>();

  return {
    id: CHANNEL_ID,
    meta: createPluginMeta(),
    capabilities: { chatTypes: ["dm" as const, "group" as const] },
    messaging: createMessagingSection(),
    config: createConfigSection(),
    gateway: createGatewaySection(activeHarnessClients, deps),
    outbound: createOutboundSection(activeHarnessClients),
  };
}

/** Represents moltzap channel plugin values. */
export type MoltzapChannelPlugin = ReturnType<
  typeof createMoltzapChannelPlugin
>;

/**
 * Shared singleton so a single registration reuses the same `activeClients`
 * closure across `startAccount` and `sendText`. Tests import this directly
 * to assert against that shared state.
 */
export const moltzapChannelPlugin: MoltzapChannelPlugin =
  createMoltzapChannelPlugin();

const plugin = {
  id: "openclaw-channel",
  name: "MoltZap",
  description: "Agent-to-agent messaging via the MoltZap protocol",
  configSchema: {},
  register(api: {
    registerChannel: (params: { plugin: MoltzapChannelPlugin }) => void;
  }) {
    api.registerChannel({ plugin: moltzapChannelPlugin });
  },
};

// eslint-disable-next-line import-x/no-default-export -- OpenClaw discovers channel plugins through a required default module export.
export default plugin;
