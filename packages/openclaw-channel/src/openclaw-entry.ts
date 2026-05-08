/**
 * OpenClaw plugin entry point for MoltZap.
 *
 * Wraps the existing MoltZapWsClient + mapping modules into the
 * ChannelPlugin shape expected by OpenClaw's api.registerChannel().
 *
 * Installed via: openclaw plugin install @moltzap/openclaw-channel
 * Config:        channels.moltzap.accounts[].{apiKey, serverUrl, agentName}
 *
 * OpenClaw's plugin interface imposes Promise-based contracts at the boundary
 * (`startAccount`, `sendText`, `deliver`, `listPeers`, `listGroups`, etc.) —
 * those shapes are fixed. Internally we use Effect and only pay the
 * `Effect.runPromise` tax at the plugin surface.
 */

import {
  MoltZapChannelCore,
  MoltZapService,
  type WsClientLogger,
} from "@moltzap/client";
import { Config, ConfigProvider, Data, Effect, Option } from "effect";
import { formatCrossConvOpenClaw } from "./format-cross-conv.js";
import { writeOpenClawContextLog } from "./context-log.js";
import {
  extractConversationCreated,
  extractConversationUpdated,
  extractContactRequest,
  extractContactAccepted,
  extractPresenceChanged,
} from "./mapping.js";

import {
  AgentsLookup,
  ContactsList,
  ConversationsList,
} from "@moltzap/protocol";

const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_ID = "moltzap" as const;
const TARGET_PREFIX_AGENT = "agent:";
const TARGET_PREFIX_CONV = "conv:";
const OPENCLAW_STRUCTURED_LOG_MIN_ARGS = 2;
const INBOUND_LOG_PREVIEW_CHARS = 80;
const BODY_FOR_AGENT_LOG_PREVIEW_CHARS = 500;
const OUTBOUND_LOG_PREVIEW_CHARS = 80;

const MOLTZAP_TARGET_RE = /^(agent|conv):.+$/;
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

function adaptOpenClawLogger(
  logMethod: ((...args: unknown[]) => void) | undefined,
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    if (!logMethod) return;
    if (
      args.length >= OPENCLAW_STRUCTURED_LOG_MIN_ARGS &&
      typeof args[0] === "object" &&
      args[0] !== null &&
      typeof args[1] === "string"
    ) {
      logMethod(args[1], args[0]);
      return;
    }
    logMethod(...args);
  };
}

type MoltZapAccount = {
  id: string;
  apiKey: string;
  serverUrl: string;
  agentName: string;
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
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  return (
    accounts.find((a) => a.id === id) ??
    accounts[0] ?? { id, apiKey: "", serverUrl: "", agentName: "" }
  );
}

/**
 * Wait for an AbortSignal to fire, as an Effect. Completes synchronously if
 * the signal is already aborted; otherwise registers a one-shot `abort`
 * listener and resolves when it fires. Replaces the ad-hoc
 * `new Promise((resolve) => signal.addEventListener("abort", resolve))`.
 */
const waitForAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    signal.addEventListener("abort", () => resume(Effect.void), { once: true });
  });

/**
 * Factory: returns a fresh plugin object whose `activeClients` map lives in
 * this closure. `register(api)` calls this so each registration gets its own
 * per-plugin state, eliminating module-level mutable globals.
 */
// eslint-disable-next-line agent-code-guard/manual-result -- OpenClaw plugin factory returns the channel object shape, not a reusable Result/Either algebra.
export function createMoltzapChannelPlugin() {
  const activeClients = new Map<string, MoltZapService>();

  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "MoltZap",
      selectionLabel: "MoltZap (agent messaging)",
      docsPath: "/channels/moltzap",
      docsLabel: "moltzap",
      blurb: "Agent-to-agent messaging via the MoltZap protocol.",
      detailLabel: "MoltZap",
      aliases: ["mz"],
      order: 200,
    },

    capabilities: {
      chatTypes: ["dm" as const, "group" as const],
    },

    messaging: {
      targetResolver: {
        looksLikeId(raw: string): boolean {
          return isMoltZapTarget(raw);
        },
        hint: 'Use "agent:<name>" for DMs or "conv:<id>" for existing conversations',
        resolveTarget(params: {
          cfg: OpenClawConfig;
          accountId?: string | null;
          input: string;
          normalized: string;
          preferredKind?: "user" | "group" | "channel";
        }) {
          const { normalized } = params;
          if (!isMoltZapTarget(normalized)) return Promise.resolve(null);
          // "user" = DM target (agent:*), "group" = conversation target (conv:*)
          const kind: "user" | "group" = normalized.startsWith(
            TARGET_PREFIX_CONV,
          )
            ? "group"
            : "user";
          return Promise.resolve({
            to: normalized,
            kind,
            display: normalized.split(":").slice(1).join(":"),
            source: "normalized",
          });
        },
      },
    },

    directory: {
      listPeers(params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        query?: string | null;
        limit?: number | null;
      }) {
        const effect = Effect.gen(function* () {
          const service = activeClients.get(
            params.accountId ?? DEFAULT_ACCOUNT_ID,
          );
          if (!service) return [];
          const { contacts } = (yield* service.sendRpc(ContactsList, {})) as {
            contacts: Array<{
              id: string;
              agents?: Array<{ id: string; name: string }>;
            }>;
          };
          const agentIds = contacts.flatMap((c) =>
            (c.agents ?? []).map((a) => a.id),
          );
          if (agentIds.length === 0) return [];
          const { agents } = (yield* service.sendRpc(AgentsLookup, {
            agentIds,
          })) as {
            agents: Array<{ id: string; name: string; displayName?: string }>;
          };
          return agents.map((a) => ({
            id: `agent:${a.name}`,
            name: a.displayName ?? a.name,
            kind: "user" as const,
          }));
        }).pipe(Effect.catchAll(() => Effect.succeed([])));
        return Effect.runPromise(effect);
      },
      listGroups(params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        query?: string | null;
        limit?: number | null;
      }) {
        const effect = Effect.gen(function* () {
          const service = activeClients.get(
            params.accountId ?? DEFAULT_ACCOUNT_ID,
          );
          if (!service) return [];
          const { conversations } = (yield* service.sendRpc(
            ConversationsList,
            {},
          )) as {
            conversations: Array<{ id: string; type: string; name?: string }>;
          };
          return conversations
            .filter((c) => c.type === "group" && c.name)
            .map((c) => ({
              id: `conv:${c.id}`,
              name: c.name!,
              kind: "group" as const,
            }));
        }).pipe(Effect.catchAll(() => Effect.succeed([])));
        return Effect.runPromise(effect);
      },
    },

    config: {
      listAccountIds(cfg: OpenClawConfig): string[] {
        const accounts = resolveAccountList(cfg);
        return accounts.length > 0
          ? accounts.map((a) => a.id || DEFAULT_ACCOUNT_ID)
          : [];
      },

      resolveAccount(
        cfg: OpenClawConfig,
        accountId?: string | null,
      ): MoltZapAccount {
        return resolveAccount(cfg, accountId);
      },

      isConfigured(account: MoltZapAccount): boolean {
        return Boolean(account.apiKey && account.serverUrl);
      },

      unconfiguredReason(): string {
        return "missing apiKey or serverUrl";
      },

      isEnabled(account: MoltZapAccount): boolean {
        return account.enabled !== false;
      },
    },

    gateway: {
      startAccount(ctx: OpenClawStartAccountContext) {
        const { accountId, account, abortSignal, log, setStatus } = ctx;
        const contextLogDir = readOpenClawContextLogDir();

        if (!account.apiKey || !account.serverUrl) {
          log?.error?.("MoltZap: missing apiKey or serverUrl");
          return Promise.resolve();
        }

        log?.info?.(
          `MoltZap: connecting as ${account.agentName} to ${account.serverUrl}`,
        );

        const wsLogger: WsClientLogger | undefined = log
          ? {
              info: adaptOpenClawLogger(log.info),
              warn: adaptOpenClawLogger(log.warn),
              error: adaptOpenClawLogger(log.error),
            }
          : undefined;

        const service = new MoltZapService({
          serverUrl: account.serverUrl,
          agentKey: account.apiKey,
          logger: wsLogger,
        });

        const core = new MoltZapChannelCore({ service, logger: wsLogger });

        core.onInbound((enriched) =>
          Effect.gen(function* () {
            const chatType =
              enriched.conversationMeta?.type === "group" ? "group" : "direct";
            const fromId = `agent:${enriched.sender.id}`;

            log?.info?.(
              `MoltZap: inbound from ${fromId}: ${enriched.text.slice(0, INBOUND_LOG_PREVIEW_CHARS)}`,
            );

            setStatus({
              accountId,
              lastInboundAt: Date.now(),
              lastEventAt: Date.now(),
            });

            const crossConvBlock = formatCrossConvOpenClaw(
              enriched.contextBlocks.crossConversationMessages ?? [],
              { ownAgentId: service.ownAgentId ?? "" },
            );
            const crossConversationMessages =
              enriched.contextBlocks.crossConversationMessages ?? [];
            const bodyForAgent = crossConvBlock
              ? `${crossConvBlock}\n\n${enriched.text}`
              : enriched.text;

            try {
              writeOpenClawContextLog({
                logDir: contextLogDir,
                accountId,
                accountAgentName: account.agentName,
                ownAgentId: service.ownAgentId,
                conversationId: enriched.conversationId,
                conversationName: enriched.conversationMeta?.name,
                conversationType: chatType,
                from: fromId,
                to: account.agentName ?? accountId,
                body: enriched.text,
                bodyForAgent,
                crossConversationMessages,
              });
            } catch (error) {
              log?.warn?.(
                `MoltZap: failed to write OpenClaw context log: ${error instanceof Error ? error.message : String(error)}`,
              );
            }

            if (crossConvBlock) {
              log?.info?.(
                `MoltZap: BodyForAgent has cross-conv context (${crossConversationMessages.length} msgs) for ${enriched.conversationId}: ${bodyForAgent.slice(0, BODY_FOR_AGENT_LOG_PREVIEW_CHARS)}`,
              );
            }

            const dispatch =
              ctx.channelRuntime?.reply
                ?.dispatchReplyWithBufferedBlockDispatcher;
            if (!dispatch) {
              log?.warn?.(
                `MoltZap: no OpenClaw reply dispatcher for ${enriched.conversationId}`,
              );
              return;
            }

            const groupSubject = enriched.conversationMeta?.name;
            const groupMembers =
              enriched.conversationMeta?.type === "group"
                ? enriched.conversationMeta.participants.join(",")
                : undefined;

            // Bridge OpenClaw's Promise-shaped dispatch into Effect, then
            // catchAll back to a logged no-op so a single failed reply doesn't
            // crash the consumer fiber.
            log?.info?.(
              `MoltZap: dispatch start for ${enriched.conversationId} message ${enriched.id}`,
            );
            const result = yield* Effect.tryPromise({
              try: () =>
                dispatch({
                  ctx: {
                    Body: enriched.text,
                    BodyForAgent: bodyForAgent,
                    From: fromId,
                    To: account.agentName ?? accountId,
                    SessionKey: `agent:main:moltzap:${chatType === "group" ? "group" : "dm"}:${enriched.conversationId}`,
                    AccountId: accountId,
                    Provider: CHANNEL_ID,
                    Surface: CHANNEL_ID,
                    OriginatingChannel: CHANNEL_ID,
                    OriginatingTo: enriched.conversationId,
                    ChatType: chatType,
                    ...(groupSubject ? { GroupSubject: groupSubject } : {}),
                    ...(groupMembers ? { GroupMembers: groupMembers } : {}),
                    ...(enriched.conversationMeta?.name
                      ? { ConversationLabel: enriched.conversationMeta.name }
                      : {}),
                    SenderName: enriched.sender.name,
                  },
                  cfg: ctx.cfg,
                  dispatcherOptions: {
                    // Cutover #533 — single-use lease semantics. The
                    // first `final` delivery consumes the dispatch
                    // lease via core.sendReply; any subsequent `final`
                    // delivery is rejected at this adapter boundary
                    // with `OpenclawDuplicateReplyError` and surfaced
                    // to OpenClaw as `false` (delivery failure).
                    // OpenClaw's retry policy under "delivery failed
                    // because lease consumed" is OQ-2 in the architect
                    // plan; the recommended default (SURFACE as false)
                    // is what we ship.
                    deliver: (() => {
                      let consumedLeaseAt: number | null = null;
                      return (
                        payload: { text?: string; body?: string },
                        info?: { kind?: string },
                      ) => {
                        if (info?.kind !== "final")
                          return Promise.resolve(true);
                        const text = payload.text ?? payload.body;
                        if (!text) return Promise.resolve(true);
                        if (consumedLeaseAt !== null) {
                          log?.warn?.(
                            `MoltZap: duplicate-reply rejected for ${enriched.conversationId} (lease already consumed at ts=${consumedLeaseAt.toString()})`,
                          );
                          return Promise.resolve(false);
                        }
                        // core.sendReply is Effect-native; run it at
                        // the OpenClaw boundary which demands a
                        // Promise.
                        const deliverEffect = core
                          .sendReply(enriched.conversationId, text)
                          .pipe(
                            Effect.tap(() =>
                              Effect.sync(() => {
                                consumedLeaseAt = Date.now();
                                log?.info?.(
                                  `MoltZap: outbound reply to ${enriched.conversationId}: ${text.slice(0, OUTBOUND_LOG_PREVIEW_CHARS)}`,
                                );
                              }),
                            ),
                            Effect.map(() => true),
                            Effect.catchAll((err) =>
                              Effect.sync(() => {
                                log?.error?.(
                                  `MoltZap: failed to send reply: ${err}`,
                                );
                                return false;
                              }),
                            ),
                          );
                        return Effect.runPromise(deliverEffect);
                      };
                    })(),
                  },
                }),
              catch: (err: unknown) => err,
            }).pipe(
              Effect.catchAll((err) =>
                Effect.sync(() => {
                  log?.error?.(`MoltZap: dispatch error: ${err}`);
                  return null;
                }),
              ),
            );
            log?.info?.(
              `MoltZap: dispatch finished for ${enriched.conversationId} message ${enriched.id}`,
            );
            if (result && !result.queuedFinal) {
              log?.debug?.(
                `MoltZap: dispatch completed without final reply for ${enriched.conversationId}`,
              );
            }
          }),
        );

        // Forward non-message events for status/logging.
        // Sync dispatcher: log + setStatus only.
        service.on("rawNotification", (event) => {
          const created = extractConversationCreated(event);
          if (created) {
            log?.debug?.(
              `MoltZap: conversation created ${created.conversation.id}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
            return;
          }

          const updated = extractConversationUpdated(event);
          if (updated) {
            log?.debug?.(
              `MoltZap: conversation updated ${updated.conversation.id}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
            return;
          }

          const contactRequest = extractContactRequest(event);
          if (contactRequest) {
            log?.debug?.(
              `MoltZap: contact request from ${contactRequest.contact.contactUserId}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
            return;
          }

          const contactAccepted = extractContactAccepted(event);
          if (contactAccepted) {
            log?.debug?.(
              `MoltZap: contact accepted ${contactAccepted.contact.id}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
            return;
          }

          const presence = extractPresenceChanged(event);
          if (presence) {
            log?.debug?.(
              `MoltZap: ${presence.agentId} is now ${presence.status}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        });

        core.onDisconnect(() => {
          log?.warn?.("MoltZap: disconnected");
          setStatus({
            accountId,
            connected: false,
            lastDisconnect: { at: Date.now() },
          });
        });

        core.onReconnect(() => {
          log?.info?.("MoltZap: reconnected");
          setStatus({
            accountId,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        });

        activeClients.set(accountId, service);

        if (abortSignal.aborted) {
          return Effect.runPromise(
            core
              .disconnect()
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => activeClients.delete(accountId)),
                ),
              ),
          );
        }

        abortSignal.addEventListener(
          "abort",
          () => {
            void Effect.runPromise(core.disconnect());
            activeClients.delete(accountId);
          },
          { once: true },
        );

        return Effect.runPromise(
          core.connect().pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                service.startSocketServer();
                log?.info?.(
                  `MoltZap: connected as ${account.agentName} (${service.ownAgentId})`,
                );
                setStatus({
                  accountId,
                  connected: true,
                  lastConnectedAt: Date.now(),
                });
              }),
            ),
            Effect.zipRight(waitForAbort(abortSignal)),
            Effect.catchAll((err) =>
              Effect.sync(() => {
                log?.error?.(`MoltZap: connection failed: ${err}`);
              }).pipe(Effect.zipRight(Effect.fail(err))),
            ),
          ),
        );
      },

      stopAccount(ctx: OpenClawStopAccountContext) {
        const service = activeClients.get(ctx.accountId);
        if (service) {
          ctx.log?.info?.("MoltZap: stopping");
          service.close();
          activeClients.delete(ctx.accountId);
        }
        return Promise.resolve();
      },
    },

    outbound: {
      deliveryMode: "gateway" as const,

      resolveTarget(params: {
        to?: string;
        cfg?: OpenClawConfig;
        accountId?: string | null;
        mode?: string;
      }): { ok: true; to: string } | { ok: false; error: Error } {
        const to = params.to?.trim();
        if (!to) {
          return {
            ok: false,
            error: new Error("MoltZap: target is required"),
          };
        }
        if (to.includes(":") && !isMoltZapTarget(to)) {
          return {
            ok: false,
            error: new Error(
              `MoltZap: unsupported target format "${to}" — use agent:<name> or conv:<id>`,
            ),
          };
        }
        return { ok: true, to };
      },

      sendText(ctx: {
        cfg: OpenClawConfig;
        to: string;
        text: string;
        accountId?: string | null;
        replyToId?: string;
      }) {
        const effect = Effect.gen(function* () {
          const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
          const service = activeClients.get(accountId);
          if (!service) {
            return yield* Effect.fail(
              new MoltZapClientNotConnectedError({ accountId }),
            );
          }
          if (ctx.to.startsWith(TARGET_PREFIX_AGENT)) {
            const agentName = ctx.to.slice(TARGET_PREFIX_AGENT.length);
            yield* service.sendToAgent(agentName, ctx.text, {
              replyTo: ctx.replyToId,
            });
          } else {
            const conversationId = ctx.to.startsWith(TARGET_PREFIX_CONV)
              ? ctx.to.slice(TARGET_PREFIX_CONV.length)
              : ctx.to;
            yield* service.send(conversationId, ctx.text, {
              replyTo: ctx.replyToId,
            });
          }
          return { ok: true as const };
        }).pipe(
          Effect.match({
            onSuccess: (ok) => ok,
            onFailure: (err) => ({
              ok: false as const,
              error: err instanceof Error ? err : new Error(String(err)),
            }),
          }),
        );
        return Effect.runPromise(effect);
      },
    },
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
