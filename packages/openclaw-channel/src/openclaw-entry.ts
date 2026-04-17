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
import { Effect } from "effect";
import { formatCrossConvOpenClaw } from "./format-cross-conv.js";
import {
  extractDelivery,
  extractConversationCreated,
  extractConversationUpdated,
  extractContactRequest,
  extractContactAccepted,
  extractPresenceChanged,
} from "./mapping.js";
import { EventNames } from "@moltzap/protocol";

const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_ID = "moltzap" as const;
const TARGET_PREFIX_AGENT = "agent:";
const TARGET_PREFIX_CONV = "conv:";

const MOLTZAP_TARGET_RE = /^(agent|conv):.+$/;

function isMoltZapTarget(raw: string): boolean {
  return MOLTZAP_TARGET_RE.test(raw);
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
        // #ignore-sloppy-code-next-line[async-keyword]: OpenClaw targetResolver interface contract
        async resolveTarget(params: {
          cfg: OpenClawConfig;
          accountId?: string | null;
          input: string;
          normalized: string;
          preferredKind?: "user" | "group" | "channel";
          // #ignore-sloppy-code-next-line[promise-type]: OpenClaw targetResolver interface contract
        }): Promise<{
          to: string;
          kind: "user" | "group" | "channel";
          display?: string;
          source?: "normalized" | "directory";
        } | null> {
          const { normalized } = params;
          if (!isMoltZapTarget(normalized)) return null;
          // "user" = DM target (agent:*), "group" = conversation target (conv:*)
          const kind: "user" | "group" = normalized.startsWith(
            TARGET_PREFIX_CONV,
          )
            ? "group"
            : "user";
          return {
            to: normalized,
            kind,
            display: normalized.split(":").slice(1).join(":"),
            source: "normalized",
          };
        },
      },
    },

    directory: {
      listPeers(params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        query?: string | null;
        limit?: number | null;
        // #ignore-sloppy-code-next-line[promise-type]: OpenClaw directory.listPeers interface contract
      }): Promise<Array<{ id: string; name: string; kind: "user" }>> {
        const effect = Effect.gen(function* () {
          const service = activeClients.get(
            params.accountId ?? DEFAULT_ACCOUNT_ID,
          );
          if (!service) return [];
          const { contacts } = (yield* service.sendRpc(
            "contacts/list",
            {},
          )) as {
            contacts: Array<{
              id: string;
              agents?: Array<{ id: string; name: string }>;
            }>;
          };
          const agentIds = contacts.flatMap((c) =>
            (c.agents ?? []).map((a) => a.id),
          );
          if (agentIds.length === 0) return [];
          const { agents } = (yield* service.sendRpc("agents/lookup", {
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
        return Effect.runPromise(effect) as Promise<
          Array<{ id: string; name: string; kind: "user" }>
        >;
      },
      listGroups(params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        query?: string | null;
        limit?: number | null;
        // #ignore-sloppy-code-next-line[promise-type]: OpenClaw directory.listGroups interface contract
      }): Promise<Array<{ id: string; name: string; kind: "group" }>> {
        const effect = Effect.gen(function* () {
          const service = activeClients.get(
            params.accountId ?? DEFAULT_ACCOUNT_ID,
          );
          if (!service) return [];
          const { conversations } = (yield* service.sendRpc(
            "conversations/list",
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
        return Effect.runPromise(effect) as Promise<
          Array<{ id: string; name: string; kind: "group" }>
        >;
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
      // #ignore-sloppy-code-next-line[async-keyword]: OpenClaw gateway startAccount interface contract
      async startAccount(ctx: {
        cfg: OpenClawConfig;
        accountId: string;
        account: MoltZapAccount;
        abortSignal: AbortSignal;
        log?: {
          info?: (...args: unknown[]) => void;
          warn?: (...args: unknown[]) => void;
          error?: (...args: unknown[]) => void;
          debug?: (...args: unknown[]) => void;
        };
        setStatus: (next: Record<string, unknown>) => void;
        channelRuntime?: {
          reply?: {
            dispatchReplyWithBufferedBlockDispatcher?: (params: {
              ctx: Record<string, string | undefined>;
              cfg: OpenClawConfig;
              dispatcherOptions: {
                deliver: (
                  payload: { text?: string; body?: string },
                  info?: { kind?: string },
                ) => Promise<boolean>;
              };
            }) => Promise<{ queuedFinal: boolean }>;
          };
        };
      }) {
        const { accountId, account, abortSignal, log, setStatus } = ctx;

        if (!account.apiKey || !account.serverUrl) {
          log?.error?.("MoltZap: missing apiKey or serverUrl");
          return;
        }

        log?.info?.(
          `MoltZap: connecting as ${account.agentName} to ${account.serverUrl}`,
        );

        const wsLogger: WsClientLogger | undefined = log
          ? {
              info: log.info ?? (() => {}),
              warn: log.warn ?? (() => {}),
              error: log.error ?? (() => {}),
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
              `MoltZap: inbound from ${fromId}: ${enriched.text.slice(0, 80)}`,
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
            const bodyForAgent = crossConvBlock
              ? `${crossConvBlock}\n\n${enriched.text}`
              : enriched.text;

            if (crossConvBlock) {
              log?.info?.(
                `MoltZap: BodyForAgent has cross-conv context (${enriched.contextBlocks.crossConversationMessages?.length ?? 0} msgs) for ${enriched.conversationId}: ${bodyForAgent.slice(0, 500)}`,
              );
            }

            const dispatch =
              ctx.channelRuntime?.reply
                ?.dispatchReplyWithBufferedBlockDispatcher;
            if (!dispatch) {
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
                    deliver: (
                      payload: { text?: string; body?: string },
                      info?: { kind?: string },
                    ) => {
                      if (info?.kind !== "final") return Promise.resolve(true);
                      const text = payload.text ?? payload.body;
                      if (!text) return Promise.resolve(true);
                      // core.sendReply is Effect-native; run it at the
                      // OpenClaw boundary which demands a Promise.
                      const deliverEffect = core
                        .sendReply(enriched.conversationId, text)
                        .pipe(
                          Effect.tap(() =>
                            Effect.sync(() =>
                              log?.info?.(
                                `MoltZap: outbound reply to ${enriched.conversationId}: ${text.slice(0, 80)}`,
                              ),
                            ),
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
                    },
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
            if (result && !result.queuedFinal) {
              log?.debug?.(
                `MoltZap: dispatch completed without final reply for ${enriched.conversationId}`,
              );
            }
          }),
        );

        // Forward non-message events for status/logging.
        // Sync dispatcher — no async work, just log + setStatus. // #ignore-sloppy-code[async-keyword]: comment prose only, not code
        service.on("rawEvent", (event) => {
          switch (event.event) {
            case EventNames.MessageDelivered: {
              const delivery = extractDelivery(event);
              if (delivery) {
                log?.debug?.(
                  `MoltZap: delivery for ${delivery.messageId} in ${delivery.conversationId}`,
                );
                setStatus({ accountId, lastEventAt: Date.now() });
              }
              break;
            }
            case EventNames.ConversationCreated: {
              const created = extractConversationCreated(event);
              if (created) {
                log?.debug?.(
                  `MoltZap: conversation created ${created.conversation.id}`,
                );
                setStatus({ accountId, lastEventAt: Date.now() });
              }
              break;
            }
            case EventNames.ConversationUpdated: {
              const updated = extractConversationUpdated(event);
              if (updated) {
                log?.debug?.(
                  `MoltZap: conversation updated ${updated.conversation.id}`,
                );
                setStatus({ accountId, lastEventAt: Date.now() });
              }
              break;
            }
            case EventNames.ContactRequest: {
              const contact = extractContactRequest(event);
              if (contact) {
                log?.debug?.(
                  `MoltZap: contact request from ${contact.contact.contactUserId}`,
                );
                setStatus({ accountId, lastEventAt: Date.now() });
              }
              break;
            }
            case EventNames.ContactAccepted: {
              const contact = extractContactAccepted(event);
              if (contact) {
                log?.debug?.(`MoltZap: contact accepted ${contact.contact.id}`);
                setStatus({ accountId, lastEventAt: Date.now() });
              }
              break;
            }
            case EventNames.PresenceChanged: {
              const presence = extractPresenceChanged(event);
              if (presence) {
                log?.debug?.(
                  `MoltZap: ${presence.agentId} is now ${presence.status}`,
                );
                setStatus({ accountId, lastEventAt: Date.now() });
              }
              break;
            }
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
          await Effect.runPromise(core.disconnect());
          activeClients.delete(accountId);
          return;
        }

        abortSignal.addEventListener(
          "abort",
          () => {
            void Effect.runPromise(core.disconnect());
            activeClients.delete(accountId);
          },
          { once: true },
        );

        try {
          await Effect.runPromise(core.connect());
          service.startSocketServer();
          log?.info?.(
            `MoltZap: connected as ${account.agentName} (${service.ownAgentId})`,
          );
          setStatus({
            accountId,
            connected: true,
            lastConnectedAt: Date.now(),
          });

          // Keep the gateway task alive until abort — expressed as Effect.
          await Effect.runPromise(waitForAbort(abortSignal));
        } catch (err) {
          log?.error?.(`MoltZap: connection failed: ${err}`);
          throw err;
        }
      },

      // #ignore-sloppy-code-next-line[async-keyword]: OpenClaw gateway stopAccount interface contract
      async stopAccount(ctx: {
        accountId: string;
        log?: { info?: (...args: unknown[]) => void };
      }) {
        const service = activeClients.get(ctx.accountId);
        if (service) {
          ctx.log?.info?.("MoltZap: stopping");
          service.close();
          activeClients.delete(ctx.accountId);
        }
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
        // #ignore-sloppy-code-next-line[promise-type]: OpenClaw outbound.sendText interface contract
      }): Promise<{ ok: true } | { ok: false; error: Error }> {
        const effect = Effect.gen(function* () {
          const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
          const service = activeClients.get(accountId);
          if (!service) {
            return yield* Effect.fail(
              new Error("MoltZap client not connected"),
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
