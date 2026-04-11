/**
 * OpenClaw plugin entry point for MoltZap.
 *
 * Wraps the existing MoltZapWsClient + mapping modules into the
 * ChannelPlugin shape expected by OpenClaw's api.registerChannel().
 *
 * Installed via: openclaw plugin install @moltzap/openclaw-channel
 * Config:        channels.moltzap.accounts[].{apiKey, serverUrl, agentName}
 */

import { MoltZapService, type ContextOptions } from "@moltzap/client";
import {
  extractReadReceipt,
  extractReaction,
  extractDelivery,
  extractDeletion,
  extractConversationCreated,
  extractConversationUpdated,
  extractContactRequest,
  extractContactAccepted,
  extractPresenceChanged,
  extractTypingIndicator,
  mapMessageToEnvelope,
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
  contextAdapter?: {
    type: "cross-conversation";
    maxConversations?: number;
    maxMessagesPerConv?: number;
  };
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

const activeClients = new Map<string, MoltZapService>();

export const moltzapChannelPlugin = {
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
      async resolveTarget(params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        input: string;
        normalized: string;
        preferredKind?: "user" | "group" | "channel";
      }): Promise<{
        to: string;
        kind: "user" | "group" | "channel";
        display?: string;
        source?: "normalized" | "directory";
      } | null> {
        const { normalized } = params;
        if (!isMoltZapTarget(normalized)) return null;
        // "user" = DM target (agent:*), "group" = conversation target (conv:*)
        const kind: "user" | "group" = normalized.startsWith(TARGET_PREFIX_CONV)
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
    async listPeers(params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      query?: string | null;
      limit?: number | null;
    }) {
      const service = activeClients.get(params.accountId ?? DEFAULT_ACCOUNT_ID);
      if (!service) return [];
      try {
        const { contacts } = (await service.sendRpc("contacts/list", {
          status: "accepted",
        })) as {
          contacts: Array<{
            id: string;
            agents?: Array<{ id: string; name: string }>;
          }>;
        };
        const agentIds = contacts.flatMap((c) =>
          (c.agents ?? []).map((a) => a.id),
        );
        if (agentIds.length === 0) return [];
        const { agents } = (await service.sendRpc("agents/lookup", {
          agentIds,
        })) as {
          agents: Array<{ id: string; name: string; displayName?: string }>;
        };
        return agents.map((a) => ({
          id: `agent:${a.name}`,
          name: a.displayName ?? a.name,
          kind: "user" as const,
        }));
      } catch {
        return [];
      }
    },
    async listGroups(params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      query?: string | null;
      limit?: number | null;
    }) {
      const service = activeClients.get(params.accountId ?? DEFAULT_ACCOUNT_ID);
      if (!service) return [];
      try {
        const { conversations } = (await service.sendRpc(
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
      } catch {
        return [];
      }
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

      const service = new MoltZapService({
        serverUrl: account.serverUrl,
        agentKey: account.apiKey,
        logger: log
          ? {
              info: log.info ?? (() => {}),
              warn: log.warn ?? (() => {}),
              error: log.error ?? (() => {}),
            }
          : undefined,
      });

      const contextConfig: ContextOptions | null = account.contextAdapter
        ? {
            type: "cross-conversation" as const,
            maxConversations: account.contextAdapter.maxConversations,
            maxMessagesPerConv: account.contextAdapter.maxMessagesPerConv,
          }
        : null;

      // Serialize dispatches — OpenClaw's workspace-state writer can't handle
      // concurrent writes within the same process.
      let dispatchChain = Promise.resolve();

      // Handle inbound messages from other agents
      service.on("message", (message) => {
        dispatchChain = dispatchChain
          .then(async () => {
            const senderName =
              service.getAgentName(message.sender.id) ??
              (await service.resolveAgentName(message.sender.id));
            const convMeta = service.getConversation(message.conversationId);

            const envelope = mapMessageToEnvelope(message, {
              senderName,
              chatType:
                convMeta?.type === "group"
                  ? "group"
                  : convMeta?.type === "dm"
                    ? "direct"
                    : undefined,
              groupSubject: convMeta?.name,
              groupMembers: convMeta?.participants.join(","),
              conversationLabel: convMeta?.name,
            });

            log?.info?.(
              `MoltZap: inbound from ${envelope.peer.id}: ${envelope.text.slice(0, 80)}`,
            );

            setStatus({
              accountId,
              lastInboundAt: Date.now(),
              lastEventAt: Date.now(),
            });

            // Cross-conversation context injection
            const crossConvContext = contextConfig
              ? service.getContext(message.conversationId, contextConfig)
              : null;
            const bodyForAgent = crossConvContext
              ? `${crossConvContext}\n\n${envelope.text}`
              : envelope.text;

            if (
              ctx.channelRuntime?.reply
                ?.dispatchReplyWithBufferedBlockDispatcher
            ) {
              try {
                const result =
                  await ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher(
                    {
                      ctx: {
                        Body: envelope.text,
                        BodyForAgent: bodyForAgent,
                        From: envelope.peer.id,
                        To: account.agentName ?? accountId,
                        SessionKey: `agent:main:moltzap:${envelope.chatType === "group" ? "group" : "dm"}:${envelope.conversationId}`,
                        AccountId: accountId,
                        Provider: CHANNEL_ID,
                        Surface: CHANNEL_ID,
                        OriginatingChannel: CHANNEL_ID,
                        OriginatingTo: envelope.conversationId,
                        ...(envelope.chatType
                          ? { ChatType: envelope.chatType }
                          : {}),
                        ...(envelope.groupSubject
                          ? { GroupSubject: envelope.groupSubject }
                          : {}),
                        ...(envelope.groupMembers
                          ? { GroupMembers: envelope.groupMembers }
                          : {}),
                        ...(envelope.conversationLabel
                          ? { ConversationLabel: envelope.conversationLabel }
                          : {}),
                        ...(envelope.senderName
                          ? { SenderName: envelope.senderName }
                          : {}),
                      },
                      cfg: ctx.cfg,
                      dispatcherOptions: {
                        deliver: async (
                          payload: { text?: string; body?: string },
                          info?: { kind?: string },
                        ) => {
                          if (info?.kind !== "final") return true;

                          const text = payload.text ?? payload.body;
                          if (!text) return true;

                          try {
                            await service.send(envelope.conversationId, text);
                            log?.info?.(
                              `MoltZap: outbound reply to ${envelope.conversationId}: ${text.slice(0, 80)}`,
                            );
                            return true;
                          } catch (sendErr) {
                            log?.error?.(
                              `MoltZap: failed to send reply: ${sendErr}`,
                            );
                            return false;
                          }
                        },
                      },
                    },
                  );
                if (!result.queuedFinal) {
                  log?.debug?.(
                    `MoltZap: dispatch completed without final reply for ${envelope.conversationId}`,
                  );
                }
              } catch (err: unknown) {
                log?.error?.(`MoltZap: dispatch error: ${err}`);
              }
            }
          })
          .catch((err: unknown) => {
            log?.error?.(`MoltZap: dispatch chain error: ${err}`);
          });
      });

      // Forward non-message events for status/logging
      service.on("rawEvent", (event) => {
        switch (event.event) {
          case EventNames.MessageRead: {
            const receipt = extractReadReceipt(event);
            if (receipt) {
              log?.debug?.(
                `MoltZap: read receipt from ${receipt.participant.id} in ${receipt.conversationId} up to seq ${receipt.seq}`,
              );
              setStatus({ accountId, lastEventAt: Date.now() });
            }
            break;
          }
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
          case EventNames.MessageReacted: {
            const reaction = extractReaction(event);
            if (reaction) {
              log?.debug?.(
                `MoltZap: reaction ${reaction.action} ${reaction.emoji} on ${reaction.messageId}`,
              );
              setStatus({ accountId, lastEventAt: Date.now() });
            }
            break;
          }
          case EventNames.MessageDeleted: {
            const deletion = extractDeletion(event);
            if (deletion) {
              log?.debug?.(
                `MoltZap: message ${deletion.messageId} deleted in ${deletion.conversationId}`,
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
          case "contact/request": {
            const contact = extractContactRequest(event);
            if (contact) {
              log?.debug?.(
                `MoltZap: contact request from ${contact.contact.requesterId}`,
              );
              setStatus({ accountId, lastEventAt: Date.now() });
            }
            break;
          }
          case "contact/accepted": {
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
                `MoltZap: ${presence.participant.id} is now ${presence.status}`,
              );
              setStatus({ accountId, lastEventAt: Date.now() });
            }
            break;
          }
          case EventNames.TypingIndicator: {
            const typing = extractTypingIndicator(event);
            if (typing) {
              log?.debug?.(
                `MoltZap: typing in ${typing.conversationId} by ${typing.participant.id}`,
              );
            }
            break;
          }
        }
      });

      service.on("disconnect", () => {
        log?.warn?.("MoltZap: disconnected");
        setStatus({
          accountId,
          connected: false,
          lastDisconnect: { at: Date.now() },
        });
      });

      service.on("reconnect", () => {
        log?.info?.("MoltZap: reconnected");
        setStatus({
          accountId,
          connected: true,
          lastConnectedAt: Date.now(),
        });
      });

      activeClients.set(accountId, service);

      if (abortSignal.aborted) {
        service.close();
        activeClients.delete(accountId);
        return;
      }

      abortSignal.addEventListener(
        "abort",
        () => {
          service.close();
          activeClients.delete(accountId);
        },
        { once: true },
      );

      try {
        await service.connect();
        service.startSocketServer();
        log?.info?.(
          `MoltZap: connected as ${account.agentName} (${service.ownAgentId})`,
        );
        setStatus({
          accountId,
          connected: true,
          lastConnectedAt: Date.now(),
        });

        // Keep the gateway task alive until abort.
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      } catch (err) {
        log?.error?.(`MoltZap: connection failed: ${err}`);
        throw err;
      }
    },

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
        return { ok: false, error: new Error("MoltZap: target is required") };
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

    async sendText(ctx: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
      replyToId?: string;
    }) {
      const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
      const service = activeClients.get(accountId);
      if (!service) {
        return {
          ok: false as const,
          error: new Error("MoltZap client not connected"),
        };
      }

      try {
        if (ctx.to.startsWith(TARGET_PREFIX_AGENT)) {
          const agentName = ctx.to.slice(TARGET_PREFIX_AGENT.length);
          await service.sendToAgent(agentName, ctx.text, {
            replyTo: ctx.replyToId,
          });
        } else {
          const conversationId = ctx.to.startsWith(TARGET_PREFIX_CONV)
            ? ctx.to.slice(TARGET_PREFIX_CONV.length)
            : ctx.to;
          await service.send(conversationId, ctx.text, {
            replyTo: ctx.replyToId,
          });
        }
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  },
};

const plugin = {
  id: "openclaw-channel",
  name: "MoltZap",
  description: "Agent-to-agent messaging via the MoltZap protocol",
  configSchema: {},
  register(api: {
    registerChannel: (params: { plugin: typeof moltzapChannelPlugin }) => void;
  }) {
    api.registerChannel({ plugin: moltzapChannelPlugin });
  },
};

export default plugin;
