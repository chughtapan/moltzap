/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */

/**
 * OpenClaw plugin entry point for MoltZap.
 *
 * Wraps the existing MoltZapAgentClient + mapping modules into the
 * ChannelPlugin shape expected by OpenClaw's api.registerChannel().
 *
 * Installed via: openclaw plugin install `@moltzap/openclaw-channel`
 * Config:        channels.moltzap.accounts[].{id, agentName}
 *
 * OpenClaw's plugin interface imposes Promise-based contracts at the boundary
 * (`startAccount`, `sendText`, `deliver`, `listPeers`, `listGroups`, etc.) —
 * those shapes are fixed. Internally we use Effect and only pay the
 * `Effect.runPromise` tax at the plugin surface.
 */

import {
  MoltZapService,
  drainPaginatedList,
  type CrossConvMessage,
  type SendRpcFn,
  type ServiceRpcError,
} from "@moltzap/client";
import {
  LeaseAlreadyConsumed,
  LeaseGuard,
  MoltZapChannelCore,
  catchLeaseInvalid,
  formatCrossConv,
  getGroupFields,
  type ChannelService,
  type EnrichedInboundMessage,
  type GroupFields,
} from "@moltzap/client/channel-base";
import { Config, ConfigProvider, Data, Effect, Option, Schema } from "effect";
import {
  writeOpenClawContextLog,
  type OpenClawContextLogInput,
} from "./context-log.js";
import { AgentsList } from "@moltzap/protocol/identity";
import { ConversationList } from "@moltzap/protocol/conversation";
import type { AnyAgentCallableRpcDefinition } from "@moltzap/protocol/socket/catalog";
import type { ResultOf } from "@moltzap/protocol/rpc";
import { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import { TaskClosedError, TaskId } from "@moltzap/protocol/task";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";

const CHANNEL_ID = "moltzap" as const;
const TARGET_PREFIX_AGENT = "agent:";
const TARGET_PREFIX_TASK = "task:";
const INBOUND_LOG_PREVIEW_CHARS = 80;
const BODY_FOR_AGENT_LOG_PREVIEW_CHARS = 500;
const OUTBOUND_LOG_PREVIEW_CHARS = 80;

const MOLTZAP_TARGET_RE = /^(agent:.+|task:[^:]+:.+)$/;
const OpenClawContextLogDir = Config.option(
  Config.string("MOLTZAP_OPENCLAW_CONTEXT_LOG_DIR"),
);

function isMoltZapTarget(raw: string): boolean {
  return MOLTZAP_TARGET_RE.test(raw);
}

function readOpenClawContextLogDir(): string | undefined {
  return Option.getOrUndefined(
    Effect.runSync(
      OpenClawContextLogDir.pipe(
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

class MoltZapAgentTargetUnsupportedError extends Data.TaggedError(
  "MoltZapAgentTargetUnsupportedError",
)<{
  readonly accountId: string;
}> {
  override get message(): string {
    return `MoltZap client for account ${this.accountId} cannot resolve agent targets`;
  }
}

class MoltZapAccountProfileMissingError extends Data.TaggedError(
  "MoltZapAccountProfileMissingError",
)<{}> {
  override get message(): string {
    return "MoltZap OpenClaw account id is required and must name a MoltZap profile";
  }
}

class OpenClawTargetResolved extends Data.TaggedClass(
  "OpenClawTargetResolved",
)<{
  readonly to: string;
}> {
  readonly ok = true as const;
}

class OpenClawTargetRejected extends Data.TaggedClass(
  "OpenClawTargetRejected",
)<{
  readonly error: Error;
}> {
  readonly ok = false as const;
}

type OpenClawTargetResolveResult =
  | OpenClawTargetResolved
  | OpenClawTargetRejected;

class OpenClawSendTextSuccess extends Data.TaggedClass(
  "OpenClawSendTextSuccess",
)<{}> {
  readonly ok = true as const;
}

class OpenClawSendTextFailure extends Data.TaggedClass(
  "OpenClawSendTextFailure",
)<{
  readonly error: Error;
}> {
  readonly ok = false as const;
}

function logContextLogWriteFailure(
  log: OpenClawLogger | undefined,
  error: unknown,
): Effect.Effect<void, never> {
  return Effect.sync(() => {
    log?.warn?.(
      `MoltZap: failed to write OpenClaw context log: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function writeContextLogOrWarn(
  log: OpenClawLogger | undefined,
  input: OpenClawContextLogInput,
): Effect.Effect<void, never> {
  return writeOpenClawContextLog(input).pipe(
    Effect.catchAll((error) => logContextLogWriteFailure(log, error)),
  );
}

type MoltZapAccount = {
  id: string;
  agentName?: string;
  enabled?: boolean;
};

type OpenClawConfig = Record<string, unknown> & {
  channels?: {
    moltzap?: {
      accounts?: MoltZapAccount[];
    };
  };
};

type OpenClawLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

type OpenClawDeliver = (
  payload: { text?: string; body?: string },
  info?: { kind?: string },
) => PromiseLike<boolean>;

type OpenClawReplyDispatcher = (params: {
  ctx: Record<string, string | undefined>;
  cfg: OpenClawConfig;
  dispatcherOptions: { deliver: OpenClawDeliver };
}) => PromiseLike<{ queuedFinal: boolean }>;

type OpenClawStartAccountContext = {
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
};

type OpenClawStopAccountContext = {
  accountId: string;
  log?: Pick<OpenClawLogger, "info">;
};

interface InboundDispatchInput {
  readonly accountId: string;
  readonly account: MoltZapAccount;
  readonly cfg: OpenClawConfig;
  readonly chatType: "direct" | "group";
  readonly fromId: string;
  readonly bodyForAgent: string;
  readonly groupMembers: string | undefined;
  readonly groupSubject: string | undefined;
  readonly enriched: EnrichedInboundMessage;
}

interface OpenClawClientService extends ChannelService {
  /**
   * The agent service's descriptor-based call. Optional because the fake
   * channel service used in tests may omit it.
   */
  callDefinition?: MoltZapService["callDefinition"];
  sendToAgent?(
    agentName: string,
    text: string,
    opts?: { replyTo?: string },
  ): Effect.Effect<void, unknown>;
}

interface MoltzapChannelPluginDeps {
  readonly createService?: (
    profileName: string,
    account: MoltZapAccount,
  ) => OpenClawClientService;
  readonly createCore?: (service: ChannelService) => MoltZapChannelCore;

  /**
   * Invoked when the dispatch lease was already consumed (single-use
   * semantics). Deliver still returns `false` per the
   * `OpenClawDeliver: PromiseLike&lt;boolean&gt;` contract; this callback is
   * the side-channel for hosts that want the typed `LeaseAlreadyConsumed`
   * error without violating that contract. Threaded from
   * `createMoltzapChannelPlugin` deps through `createGatewaySection` and
   * `registerInboundHandler` into the `createLeaseConsumingDeliver`
   * closure.
   */
  readonly onLeaseConsumed?: (err: LeaseAlreadyConsumed) => void;
}

interface OpenClawDirectoryParams {
  readonly cfg: OpenClawConfig;
  readonly accountId?: string | null;
  readonly query?: string | null;
  readonly limit?: number | null;
}

interface OpenClawResolveTargetParams {
  readonly cfg: OpenClawConfig;
  readonly accountId?: string | null;
  readonly input: string;
  readonly normalized: string;
  readonly preferredKind?: "user" | "group" | "channel";
}

interface InboundHandlerParams {
  readonly ctx: OpenClawStartAccountContext;
  readonly core: MoltZapChannelCore;
  readonly service: OpenClawClientService;
  readonly contextLogDir: string | undefined;
  readonly enriched: EnrichedInboundMessage;
  readonly onLeaseConsumed: ((err: LeaseAlreadyConsumed) => void) | undefined;
}

interface InboundRuntimeData {
  readonly chatType: "direct" | "group";
  readonly fromId: string;
  readonly crossConvBlock: string | null;
  readonly crossConversationMessages: readonly CrossConvMessage[];
  readonly bodyForAgent: string;
  readonly groupSubject: string | undefined;
  readonly groupMembers: string | undefined;
}

function resolveAccountList(cfg: OpenClawConfig): MoltZapAccount[] {
  const section = cfg.channels?.moltzap;
  if (!section) return [];
  return Array.isArray(section.accounts) ? section.accounts : [];
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
 */
const waitForAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    signal.addEventListener("abort", () => resume(Effect.void), { once: true });
  });

function logOutboundReply(
  log: OpenClawLogger | undefined,
  conversationId: string,
  text: string,
): Effect.Effect<void> {
  return Effect.sync(() => {
    log?.info?.(
      `MoltZap: outbound reply to ${conversationId}: ${text.slice(0, OUTBOUND_LOG_PREVIEW_CHARS)}`,
    );
  });
}

function isTaskClosedRpcError(err: unknown): err is TaskClosedError {
  return err instanceof TaskClosedError;
}

function handleReplyFailure(
  log: OpenClawLogger | undefined,
  conversationId: string,
  err: unknown,
): Effect.Effect<boolean> {
  return Effect.sync(() => {
    if (isTaskClosedRpcError(err)) {
      log?.warn?.(
        {
          conversationId,
          tag: err._tag,
          msg: err.message,
        },
        "MoltZap: send rejected; task closed, dropping without retry",
      );
      return true;
    }
    log?.error?.(`MoltZap: failed to send reply: ${err}`);
    return false;
  });
}

function sendDeliveredReply(params: {
  readonly core: MoltZapChannelCore;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly text: string;
  readonly leaseId: LeaseId | undefined;
  readonly log: OpenClawLogger | undefined;
  readonly onLeaseConsumed: ((err: LeaseAlreadyConsumed) => void) | undefined;
  readonly guard: LeaseGuard;
}): Effect.Effect<boolean> {
  return params.core
    .sendReply(
      params.taskId,
      params.conversationId,
      params.text,
      params.leaseId !== undefined
        ? { dispatchLeaseId: params.leaseId }
        : undefined,
    )
    .pipe(
      catchLeaseInvalid(
        params.leaseId !== undefined ? { leaseId: params.leaseId } : undefined,
      ),
      // Stamp the guard only on a successful `core.sendReply`. Transient send
      // failures fall through to `Effect.catchAll` below WITHOUT stamping, so a
      // retried deliver call still exercises the lease.
      Effect.tap(() => params.guard.consume()),
      Effect.tap(() =>
        logOutboundReply(params.log, params.conversationId, params.text),
      ),
      Effect.map(() => true),
      Effect.catchAll((err) =>
        handleDeliverFailure({
          log: params.log,
          conversationId: params.conversationId,
          onLeaseConsumed: params.onLeaseConsumed,
          err,
        }),
      ),
    );
}

interface HandleDeliverFailureParams {
  readonly log: OpenClawLogger | undefined;
  readonly conversationId: string;
  readonly onLeaseConsumed: ((err: LeaseAlreadyConsumed) => void) | undefined;
  readonly err: unknown;
}

function handleDeliverFailure(
  params: HandleDeliverFailureParams,
): Effect.Effect<boolean> {
  const { log, conversationId, onLeaseConsumed, err } = params;
  if (err instanceof LeaseAlreadyConsumed) {
    return Effect.sync(() => {
      log?.warn?.(
        `MoltZap: lease ${err.leaseId} already consumed for ${conversationId} at ts=${err.consumedAt.toString()}; surfacing via onLeaseConsumed`,
      );
      onLeaseConsumed?.(err);
      // Deliver contract: PromiseLike<boolean>. False signals "not delivered"
      // without violating the type.
      return false;
    });
  }
  return handleReplyFailure(log, conversationId, err);
}

function createLeaseConsumingDeliver(params: {
  readonly core: MoltZapChannelCore;
  readonly enriched: EnrichedInboundMessage;
  readonly log: OpenClawLogger | undefined;
  readonly onLeaseConsumed: ((err: LeaseAlreadyConsumed) => void) | undefined;
}): OpenClawDeliver {
  // One LeaseGuard per inbound message: stamped exactly once, on the FIRST
  // successful `core.sendReply`.
  //
  // Ordering matters: pre-check `guard.consumedAt` BEFORE sending so duplicate
  // delivers are short-circuited; the actual stamp happens inside
  // `sendDeliveredReply` via `Effect.tap(() => guard.consume())` AFTER
  // `core.sendReply` succeeds. A transient send failure therefore leaves the
  // guard unconsumed, and a retried deliver call still exercises the lease.
  const guard = new LeaseGuard();
  return (payload, info) => {
    if (info?.kind !== "final") return Promise.resolve(true);
    const text = payload.text ?? payload.body;
    if (!text) return Promise.resolve(true);
    return Effect.runPromise(
      Effect.gen(function* () {
        const stamped = yield* guard.consumedAt;
        if (Option.isSome(stamped)) {
          params.log?.warn?.(
            `MoltZap: duplicate-reply rejected for ${params.enriched.conversationId} (lease already consumed at ts=${stamped.value.toString()})`,
          );
          return false;
        }
        return yield* sendDeliveredReply({
          core: params.core,
          taskId: params.enriched.taskId,
          conversationId: params.enriched.conversationId,
          text,
          leaseId: params.enriched.dispatchLeaseId,
          log: params.log,
          onLeaseConsumed: params.onLeaseConsumed,
          guard,
        });
      }),
    );
  };
}

function buildInboundDispatchContext(
  input: InboundDispatchInput,
): Record<string, string | undefined> {
  return {
    Body: input.enriched.text,
    BodyForAgent: input.bodyForAgent,
    From: input.fromId,
    To: input.account.agentName ?? input.accountId,
    SessionKey: `agent:main:moltzap:${input.chatType === "group" ? "group" : "dm"}:${input.enriched.conversationId}`,
    AccountId: input.accountId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${TARGET_PREFIX_TASK}${input.enriched.taskId}:${input.enriched.conversationId}`,
    ChatType: input.chatType,
    ...(input.groupSubject ? { GroupSubject: input.groupSubject } : {}),
    ...(input.groupMembers ? { GroupMembers: input.groupMembers } : {}),
    ...(input.enriched.conversationMeta?.name
      ? { ConversationLabel: input.enriched.conversationMeta.name }
      : {}),
    SenderName: input.enriched.sender.name,
  };
}

function logDispatchError(
  log: OpenClawLogger | undefined,
  err: unknown,
): Effect.Effect<null> {
  return Effect.sync(() => {
    log?.error?.(`MoltZap: dispatch error: ${err}`);
    return null;
  });
}

function dispatchInboundReply(params: {
  readonly dispatch: OpenClawReplyDispatcher;
  readonly input: InboundDispatchInput;
  readonly core: MoltZapChannelCore;
  readonly log: OpenClawLogger | undefined;
  readonly onLeaseConsumed: ((err: LeaseAlreadyConsumed) => void) | undefined;
}): Effect.Effect<{ queuedFinal: boolean } | null> {
  return Effect.tryPromise({
    try: () =>
      params.dispatch({
        ctx: buildInboundDispatchContext(params.input),
        cfg: params.input.cfg,
        dispatcherOptions: {
          deliver: createLeaseConsumingDeliver({
            core: params.core,
            enriched: params.input.enriched,
            log: params.log,
            onLeaseConsumed: params.onLeaseConsumed,
          }),
        },
      }),
    catch: (err: unknown) => err,
  }).pipe(Effect.catchAll((err) => logDispatchError(params.log, err)));
}

function disconnectCoreOnAbort(
  core: MoltZapChannelCore,
  activeClients: Map<string, OpenClawClientService>,
  accountId: string,
): void {
  Effect.runFork(
    core
      .disconnect()
      .pipe(
        Effect.ensuring(Effect.sync(() => activeClients.delete(accountId))),
      ),
  );
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
      hint: 'Use "agent:<name>" for DMs or "task:<taskId>:<conversationId>" for existing conversations',
      resolveTarget(params: OpenClawResolveTargetParams) {
        const { normalized } = params;
        if (!isMoltZapTarget(normalized)) return Promise.resolve(null);
        const kind = normalized.startsWith(TARGET_PREFIX_TASK)
          ? ("group" as const)
          : ("user" as const);
        return Promise.resolve({
          to: normalized,
          kind,
          display: normalized.split(":").slice(1).join(":"),
          source: "normalized",
        });
      },
    },
  };
}

function createDirectorySection(
  activeClients: Map<string, OpenClawClientService>,
) {
  return {
    listPeers(params: OpenClawDirectoryParams) {
      return Effect.runPromise(listPeersEffect(activeClients, params));
    },
    listGroups(params: OpenClawDirectoryParams) {
      return Effect.runPromise(listGroupsEffect(activeClients, params));
    },
  };
}

interface ActiveServiceResolution {
  readonly accountId: string;
  readonly service: OpenClawClientService;
}

function getActiveService(
  activeClients: Map<string, OpenClawClientService>,
  accountId?: string | null,
): ActiveServiceResolution | undefined {
  const requested = accountId?.trim();
  if (requested) {
    const service = activeClients.get(requested);
    return service === undefined
      ? undefined
      : { accountId: requested, service };
  }
  if (activeClients.size !== 1) return undefined;
  const first = activeClients.entries().next().value as
    | [string, OpenClawClientService]
    | undefined;
  return first === undefined
    ? undefined
    : { accountId: first[0], service: first[1] };
}

/**
 * Bridge an agent service's descriptor-based `callDefinition` to the
 * `SendRpcFn` the pagination drainer speaks. The descriptor union is the
 * authored agent-callable catalog, so list RPCs stay typed from descriptor
 * through result.
 */
function callAsSendRpc<
  Definition extends AnyAgentCallableRpcDefinition,
>(service: {
  readonly callDefinition: MoltZapService["callDefinition"];
}): SendRpcFn<ServiceRpcError, Definition> {
  return (definition, params) => service.callDefinition(definition, params);
}

function listPeersEffect(
  activeClients: Map<string, OpenClawClientService>,
  params: OpenClawDirectoryParams,
) {
  return Effect.gen(function* () {
    const active = getActiveService(activeClients, params.accountId);
    if (!active?.service.callDefinition) return [];
    // `service.callDefinition` is a prototype method reading `this.client` inside
    // `Effect.suspend`; passed as a bare reference its receiver is stripped,
    // so the suspend thunk dies with a `this`-undefined TypeError that
    // `catchAll` (a failure-channel handler) cannot absorb. Bind once so both
    // drain consumers keep the service receiver.
    const boundCallDefinition = active.service.callDefinition.bind(
      active.service,
    );
    const sendRpc = callAsSendRpc<typeof AgentsList>({
      callDefinition: boundCallDefinition,
    });
    // Drain ALL visible-agent pages so every peer in the directory resolves.
    const agents = yield* drainPaginatedList<
      ServiceRpcError,
      typeof AgentsList,
      ResultOf<typeof AgentsList>["agents"][number],
      NonNullable<ResultOf<typeof AgentsList>["nextCursor"]>
    >({
      sendRpc,
      definition: AgentsList,
      paramsForCursor: (cursor) => (cursor === undefined ? {} : { cursor }),
      rowsForPage: (page) => page.agents,
      nextCursorForPage: (page) => page.nextCursor,
    });
    return agents.map((agent) => ({
      id: `agent:${agent.name}`,
      name: agent.displayName ?? agent.name,
      kind: "user" as const,
    }));
  }).pipe(
    Effect.withSpan("createMoltzapChannelPlugin.listPeers"),
    Effect.catchAll(() => Effect.succeed([])),
  );
}

function listGroupsEffect(
  activeClients: Map<string, OpenClawClientService>,
  params: OpenClawDirectoryParams,
) {
  return Effect.gen(function* () {
    const active = getActiveService(activeClients, params.accountId);
    if (!active?.service.callDefinition) return [];
    const result = yield* active.service.callDefinition(ConversationList, {});
    return result.items
      .filter((item) => isNamedGroup(item.conversation))
      .map((item) => ({
        id: `task:${item.taskId}:${item.conversation.id}`,
        name: item.conversation.name!,
        kind: "group" as const,
      }));
  }).pipe(
    Effect.withSpan("createMoltzapChannelPlugin.listGroups"),
    Effect.catchAll(() => Effect.succeed([])),
  );
}

function isNamedGroup(conversation: {
  readonly name?: string;
}): conversation is { readonly name: string } {
  return typeof conversation.name === "string" && conversation.name.length > 0;
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
  activeClients: Map<string, OpenClawClientService>,
  deps: MoltzapChannelPluginDeps,
) {
  return {
    startAccount(ctx: OpenClawStartAccountContext) {
      return startGatewayAccount(ctx, activeClients, deps);
    },
    stopAccount(ctx: OpenClawStopAccountContext) {
      return stopGatewayAccount(ctx, activeClients);
    },
  };
}

function startGatewayAccount(
  ctx: OpenClawStartAccountContext,
  activeClients: Map<string, OpenClawClientService>,
  deps: MoltzapChannelPluginDeps,
) {
  return Effect.runPromise(startGatewayAccountEffect(ctx, activeClients, deps));
}

function startGatewayAccountEffect(
  ctx: OpenClawStartAccountContext,
  activeClients: Map<string, OpenClawClientService>,
  deps: MoltzapChannelPluginDeps,
): Effect.Effect<void, unknown> {
  const { accountId, account, abortSignal, log, setStatus } = ctx;
  const profileName = accountId.trim();
  const contextLogDir = readOpenClawContextLogDir();
  log?.info?.(`MoltZap: connecting as ${account.agentName ?? accountId}`);
  return Effect.gen(function* () {
    if (profileName.length === 0) {
      return yield* Effect.fail(new MoltZapAccountProfileMissingError());
    }
    const service = yield* createGatewayService(profileName, account, deps);
    const core = createGatewayCore(service, deps);
    registerInboundHandler({
      core,
      ctx,
      service,
      contextLogDir,
      onLeaseConsumed: deps.onLeaseConsumed,
    });
    registerConnectionStatus(core, ctx);
    activeClients.set(accountId, service);
    if (abortSignal.aborted) {
      return yield* disconnectAndRemove(core, activeClients, accountId);
    }
    abortSignal.addEventListener(
      "abort",
      () => disconnectCoreOnAbort(core, activeClients, accountId),
      { once: true },
    );
    yield* connectGatewayCore(core, service, ctx, setStatus);
  });
}

function createGatewayService(
  profileName: string,
  account: MoltZapAccount,
  deps: MoltzapChannelPluginDeps,
): Effect.Effect<OpenClawClientService, unknown> {
  if (deps.createService) {
    return Effect.succeed(deps.createService(profileName, account));
  }
  return MoltZapService.make(profileName);
}

function createGatewayCore(
  service: OpenClawClientService,
  deps: MoltzapChannelPluginDeps,
): MoltZapChannelCore {
  if (deps.createCore) return deps.createCore(service);
  return new MoltZapChannelCore({ service });
}

function disconnectAndRemove(
  core: MoltZapChannelCore,
  activeClients: Map<string, OpenClawClientService>,
  accountId: string,
) {
  return core
    .disconnect()
    .pipe(Effect.tap(() => Effect.sync(() => activeClients.delete(accountId))));
}

interface RegisterInboundHandlerParams {
  readonly core: MoltZapChannelCore;
  readonly ctx: OpenClawStartAccountContext;
  readonly service: OpenClawClientService;
  readonly contextLogDir: string | undefined;
  readonly onLeaseConsumed: ((err: LeaseAlreadyConsumed) => void) | undefined;
}

function registerInboundHandler(params: RegisterInboundHandlerParams): void {
  params.core.onInbound((enriched) =>
    handleInboundMessage({
      ctx: params.ctx,
      core: params.core,
      service: params.service,
      contextLogDir: params.contextLogDir,
      enriched,
      onLeaseConsumed: params.onLeaseConsumed,
    }).pipe(Effect.withSpan("createMoltzapChannelPlugin.inboundDispatch")),
  );
}

function handleInboundMessage(params: InboundHandlerParams) {
  return Effect.gen(function* () {
    const data = inboundRuntimeData(params.enriched, params.service);
    logInboundMessage(params.ctx.log, params.enriched, data.fromId);
    touchInboundStatus(params.ctx);
    yield* writeInboundContextLog(params, data);
    logCrossConversationContext(params.ctx.log, params.enriched, data);
    const dispatch =
      params.ctx.channelRuntime?.reply
        ?.dispatchReplyWithBufferedBlockDispatcher;
    if (!dispatch) {
      logMissingDispatcher(params.ctx.log, params.enriched.conversationId);
      return;
    }
    const result = yield* dispatchInboundReply({
      dispatch,
      input: inboundDispatchInput(params.ctx, params.enriched, data),
      core: params.core,
      log: params.ctx.log,
      onLeaseConsumed: params.onLeaseConsumed,
    });
    logDispatchFinished(params.ctx.log, params.enriched);
    logUnqueuedDispatch(params.ctx.log, params.enriched, result);
  });
}

function inboundRuntimeData(
  enriched: EnrichedInboundMessage,
  service: OpenClawClientService,
): InboundRuntimeData {
  const groupFields = getGroupFields(enriched.conversationMeta);
  const crossConversationMessages = crossConversationMessagesFor(enriched);
  const crossConvBlock = formatCrossConv(crossConversationMessages, {
    ownAgentId: service.ownAgentId ?? "",
    markup: "json-header",
  });
  return {
    chatType: groupFields !== null ? "group" : "direct",
    fromId: `agent:${enriched.sender.id}`,
    crossConvBlock,
    crossConversationMessages,
    bodyForAgent: bodyForAgent(enriched.text, crossConvBlock),
    groupSubject: groupFields?.name,
    groupMembers: groupMembersFor(groupFields),
  };
}

function crossConversationMessagesFor(
  enriched: EnrichedInboundMessage,
): readonly CrossConvMessage[] {
  return enriched.contextBlocks.crossConversationMessages ?? [];
}

function bodyForAgent(text: string, crossConvBlock: string | null): string {
  return crossConvBlock ? `${crossConvBlock}\n\n${text}` : text;
}

// `groupMembersFor` stays openclaw-local because the comma-joined string
// format is openclaw-specific (the `GroupMembers` dispatch-context field
// shape). Channel-base's `getGroupFields` provides the narrowing; this helper
// does the openclaw-side join.
function groupMembersFor(fields: GroupFields | null): string | undefined {
  if (fields === null) return undefined;
  return fields.participants.join(",");
}

function logInboundMessage(
  log: OpenClawLogger | undefined,
  enriched: EnrichedInboundMessage,
  fromId: string,
): void {
  log?.info?.(
    `MoltZap: inbound from ${fromId}: ${enriched.text.slice(0, INBOUND_LOG_PREVIEW_CHARS)}`,
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
  return writeContextLogOrWarn(params.ctx.log, {
    logDir: params.contextLogDir,
    accountId: params.ctx.accountId,
    accountAgentName: params.ctx.account.agentName,
    ownAgentId: params.service.ownAgentId,
    conversationId: params.enriched.conversationId,
    conversationName: params.enriched.conversationMeta?.name,
    conversationType: data.chatType,
    from: data.fromId,
    to: params.ctx.account.agentName ?? params.ctx.accountId,
    body: params.enriched.text,
    bodyForAgent: data.bodyForAgent,
    crossConversationMessages: data.crossConversationMessages,
  });
}

function logCrossConversationContext(
  log: OpenClawLogger | undefined,
  enriched: EnrichedInboundMessage,
  data: InboundRuntimeData,
): void {
  if (!data.crossConvBlock) return;
  log?.info?.(
    `MoltZap: BodyForAgent has cross-conv context (${data.crossConversationMessages.length} msgs) for ${enriched.conversationId}: ${data.bodyForAgent.slice(0, BODY_FOR_AGENT_LOG_PREVIEW_CHARS)}`,
  );
}

function logMissingDispatcher(
  log: OpenClawLogger | undefined,
  conversationId: string,
): void {
  log?.warn?.(`MoltZap: no OpenClaw reply dispatcher for ${conversationId}`);
}

function inboundDispatchInput(
  ctx: OpenClawStartAccountContext,
  enriched: EnrichedInboundMessage,
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
    enriched,
  };
}

function logDispatchFinished(
  log: OpenClawLogger | undefined,
  enriched: EnrichedInboundMessage,
): void {
  log?.info?.(
    `MoltZap: dispatch finished for ${enriched.conversationId} message ${enriched.id}`,
  );
}

function logUnqueuedDispatch(
  log: OpenClawLogger | undefined,
  enriched: EnrichedInboundMessage,
  result: { readonly queuedFinal: boolean } | null,
): void {
  if (!result || result.queuedFinal) return;
  log?.debug?.(
    `MoltZap: dispatch completed without final reply for ${enriched.conversationId}`,
  );
}

function registerConnectionStatus(
  core: MoltZapChannelCore,
  ctx: OpenClawStartAccountContext,
): void {
  core.onDisconnect(() => {
    ctx.log?.warn?.("MoltZap: disconnected");
    ctx.setStatus({
      accountId: ctx.accountId,
      connected: false,
      lastDisconnect: { at: Date.now() },
    });
  });
  core.onReconnect(() => {
    ctx.log?.info?.("MoltZap: reconnected");
    ctx.setStatus({
      accountId: ctx.accountId,
      connected: true,
      lastConnectedAt: Date.now(),
    });
  });
}

function connectGatewayCore(
  core: MoltZapChannelCore,
  service: OpenClawClientService,
  ctx: OpenClawStartAccountContext,
  setStatus: (next: Record<string, unknown>) => void,
) {
  return core.connect().pipe(
    Effect.tap(() => reportConnected(service, ctx, setStatus)),
    Effect.zipRight(waitForAbort(ctx.abortSignal)),
    Effect.catchAll((err) => logConnectionFailure(ctx.log, err)),
  );
}

function reportConnected(
  service: OpenClawClientService,
  ctx: OpenClawStartAccountContext,
  setStatus: (next: Record<string, unknown>) => void,
) {
  return Effect.sync(() => {
    ctx.log?.info?.(
      `MoltZap: connected as ${ctx.account.agentName} (${service.ownAgentId})`,
    );
    setStatus({
      accountId: ctx.accountId,
      connected: true,
      lastConnectedAt: Date.now(),
    });
  });
}

function logConnectionFailure(log: OpenClawLogger | undefined, err: unknown) {
  return Effect.sync(() => {
    log?.error?.(`MoltZap: connection failed: ${err}`);
  }).pipe(Effect.zipRight(Effect.fail(err)));
}

function stopGatewayAccount(
  ctx: OpenClawStopAccountContext,
  activeClients: Map<string, OpenClawClientService>,
) {
  const service = activeClients.get(ctx.accountId);
  if (service) {
    ctx.log?.info?.("MoltZap: stopping");
    service.close();
    activeClients.delete(ctx.accountId);
  }
  return Promise.resolve();
}

function createOutboundSection(
  activeClients: Map<string, OpenClawClientService>,
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
      replyToId?: string;
    }) {
      return Effect.runPromise(sendTextEffect(activeClients, ctx));
    },
  };
}

function resolveOutboundTarget(toInput: string | undefined) {
  const to = toInput?.trim();
  if (!to) {
    return new OpenClawTargetRejected({
      error: new Error("MoltZap: target is required"),
    });
  }
  if (to.includes(":") && !isMoltZapTarget(to)) {
    return new OpenClawTargetRejected({
      error: new Error(
        `MoltZap: unsupported target format "${to}" — use agent:<name> or task:<taskId>:<conversationId>`,
      ),
    });
  }
  return new OpenClawTargetResolved({ to });
}

class MoltZapTargetMalformedError extends Data.TaggedError(
  "MoltZapTargetMalformedError",
)<{ readonly target: string }> {
  override get message(): string {
    return `MoltZap: invalid target "${this.target}" — expected task:<taskId>:<conversationId>`;
  }
}

function parseTaskTarget(
  to: string,
): Effect.Effect<
  { readonly taskId: TaskId; readonly conversationId: ConversationId },
  MoltZapTargetMalformedError
> {
  const body = to.startsWith(TARGET_PREFIX_TASK)
    ? to.slice(TARGET_PREFIX_TASK.length)
    : to;
  const sep = body.indexOf(":");
  if (sep <= 0 || sep === body.length - 1) {
    return Effect.fail(new MoltZapTargetMalformedError({ target: to }));
  }
  return Effect.try({
    try: () => ({
      taskId: Schema.decodeUnknownSync(TaskId)(body.slice(0, sep)),
      conversationId: Schema.decodeUnknownSync(ConversationId)(
        body.slice(sep + 1),
      ),
    }),
    catch: () => new MoltZapTargetMalformedError({ target: to }),
  });
}

function dispatchOutbound(
  service: OpenClawClientService,
  accountId: string,
  ctx: {
    to: string;
    text: string;
    replyToId?: string;
  },
) {
  return Effect.gen(function* () {
    if (ctx.to.startsWith(TARGET_PREFIX_AGENT)) {
      if (!service.sendToAgent) {
        return yield* Effect.fail(
          new MoltZapAgentTargetUnsupportedError({ accountId }),
        );
      }
      return yield* service.sendToAgent(
        ctx.to.slice(TARGET_PREFIX_AGENT.length),
        ctx.text,
        { replyTo: ctx.replyToId },
      );
    }
    const parsed = yield* parseTaskTarget(ctx.to);
    return yield* service.send(
      parsed.taskId,
      parsed.conversationId,
      ctx.text,
      ctx.replyToId !== undefined
        ? { replyTo: Schema.decodeUnknownSync(MessageId)(ctx.replyToId) }
        : {},
    );
  });
}

function sendTextEffect(
  activeClients: Map<string, OpenClawClientService>,
  ctx: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    replyToId?: string;
  },
) {
  const requestedAccountId = ctx.accountId ?? "(unspecified)";
  return Effect.gen(function* () {
    const active = getActiveService(activeClients, ctx.accountId);
    if (active === undefined) {
      return yield* Effect.fail(
        new MoltZapClientNotConnectedError({ accountId: requestedAccountId }),
      );
    }
    yield* dispatchOutbound(active.service, active.accountId, ctx);
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
 *   participant Core as MoltZapChannelCore
 *   participant Server as MoltZap server
 *   OC->>Plugin: startAccount(ctx)
 *   Plugin->>Core: new MoltZapAgentClient → MoltZapChannelCore
 *   Plugin->>Core: core.connect() — WS auth
 *   Plugin->>Core: core.onInbound(handler) — register dispatch
 *   Core->>Plugin: enriched message arrives
 *   Plugin->>OC: dispatchReplyWithBufferedBlockDispatcher
 *   note over OC: agent pipeline → LLM
 *   OC->>Plugin: deliver(payload, opts) — createLeaseConsumingDeliver
 *   Plugin->>Server: core.sendReply(conversationId, text)
 *   alt LeaseInvalid wire error
 *     Server-->>Plugin: RpcServerError reason=LeaseInvalid
 *     Plugin->>Plugin: catchLeaseInvalid → LeaseAlreadyConsumed<br>onLeaseConsumed callback, return false
 *   end
 *   OC->>Plugin: stopAccount(ctx)
 *   Plugin->>Core: core.disconnect()
 *   Plugin->>Plugin: activeClients.delete(account)
 * ```
 *
 * `deliver` returns `PromiseLike&lt;boolean>` per openclaw contract;
 * false signals "not delivered" without throwing. The lease-guard
 * is single-shot per inbound message: a retried `deliver` exercises
 * the lease again, surfacing `LeaseAlreadyConsumed` as a typed
 * callback (`MoltzapChannelPluginDeps.onLeaseConsumed`) rather than
 * a throw.
 *
 * `resolveTarget` accepts `agent:&lt;name>` (DM with named agent) and
 * `task:&lt;taskId>:&lt;conversationId>` (existing conversation). A target
 * containing `:` in any other shape is rejected.
 */
export function createMoltzapChannelPlugin(
  deps: MoltzapChannelPluginDeps = {},
) {
  const activeClients = new Map<string, OpenClawClientService>();

  return {
    id: CHANNEL_ID,
    meta: createPluginMeta(),
    capabilities: { chatTypes: ["dm" as const, "group" as const] },
    messaging: createMessagingSection(),
    directory: createDirectorySection(activeClients),
    config: createConfigSection(),
    gateway: createGatewaySection(activeClients, deps),
    outbound: createOutboundSection(activeClients),
  };
}

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

export default plugin;
