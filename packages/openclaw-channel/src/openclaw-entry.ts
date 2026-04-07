/**
 * OpenClaw plugin entry point for MoltZap.
 *
 * Wraps the existing MoltZapWsClient + mapping modules into the
 * ChannelPlugin shape expected by OpenClaw's api.registerChannel().
 *
 * Installed via: openclaw plugin install @moltzap/openclaw-channel
 * Config:        channels.moltzap.accounts[].{apiKey, serverUrl, agentName}
 */

import { MoltZapWsClient } from "./ws-client.js";
import {
  extractMessage,
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
import type { EventFrame, Message } from "@moltzap/protocol";

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

const activeClients = new Map<string, MoltZapWsClient>();

/** Cache: accountId → (agentName → conversationId) for auto-created DM conversations. */
export const agentConversationCache = new Map<string, Map<string, string>>();

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
      const client = activeClients.get(params.accountId ?? DEFAULT_ACCOUNT_ID);
      if (!client) return [];
      try {
        const { contacts } = (await client.sendRpc("contacts/list", {
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
        const { agents } = (await client.sendRpc("agents/lookup", {
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
      const client = activeClients.get(params.accountId ?? DEFAULT_ACCOUNT_ID);
      if (!client) return [];
      try {
        const { conversations } = (await client.sendRpc(
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

      const senderNameCache = new Map<string, string>();
      const conversationMetaCache = new Map<
        string,
        { type: string; name?: string; participants: string[] }
      >();

      async function lookupSenderName(
        client: MoltZapWsClient,
        agentId: string,
      ): Promise<string> {
        const cached = senderNameCache.get(agentId);
        if (cached) return cached;
        try {
          const result = (await client.sendRpc("agents/lookup", {
            agentIds: [agentId],
          })) as { agents: Array<{ id: string; name: string }> };
          const agent = result.agents[0];
          if (agent) {
            senderNameCache.set(agentId, agent.name);
            return agent.name;
          }
        } catch {
          log?.warn?.(`MoltZap: agents/lookup failed for ${agentId}`);
        }
        return agentId;
      }

      async function getConversationMeta(
        client: MoltZapWsClient,
        conversationId: string,
      ): Promise<
        { type: string; name?: string; participants: string[] } | undefined
      > {
        const cached = conversationMetaCache.get(conversationId);
        if (cached) return cached;
        try {
          const result = (await client.sendRpc("conversations/get", {
            conversationId,
          })) as {
            conversation: { type: string; name?: string };
            participants: Array<{
              participant: { type: string; id: string };
            }>;
          };
          const meta = {
            type: result.conversation.type,
            name: result.conversation.name,
            participants: result.participants.map(
              (p) => `${p.participant.type}:${p.participant.id}`,
            ),
          };
          conversationMetaCache.set(conversationId, meta);
          return meta;
        } catch {
          log?.warn?.(
            `MoltZap: conversations/get failed for ${conversationId}`,
          );
          return undefined;
        }
      }

      // Serialize dispatches — OpenClaw's workspace-state writer can't handle
      // concurrent writes within the same process.
      let dispatchChain = Promise.resolve();
      let ownAgentId: string | undefined;

      function dispatchMessage(
        message: Message,
        client: MoltZapWsClient,
      ): void {
        // Skip messages sent by this agent (avoid echo loops)
        if (
          ownAgentId &&
          message.sender.type === "agent" &&
          message.sender.id === ownAgentId
        ) {
          return;
        }
        dispatchChain = dispatchChain
          .then(async () => {
            const [senderName, convMeta] = await Promise.all([
              message.sender.type === "agent"
                ? lookupSenderName(client, message.sender.id)
                : Promise.resolve(undefined),
              getConversationMeta(client, message.conversationId),
            ]);

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
                        BodyForAgent: envelope.text,
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
                            await client.sendRpc("messages/send", {
                              conversationId: envelope.conversationId,
                              parts: [{ type: "text", text }],
                            });
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
      }

      async function fetchMissedMessages(
        client: MoltZapWsClient,
        helloOk: unknown,
      ): Promise<void> {
        const hello = helloOk as {
          unreadCounts?: Record<string, number>;
        } | null;
        const unreadCounts = hello?.unreadCounts;
        if (!unreadCounts) return;

        const sorted = Object.entries(unreadCounts)
          .filter(([, count]) => count > 0)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5);

        let totalFetched = 0;
        for (const [conversationId] of sorted) {
          try {
            const result = (await client.sendRpc("messages/list", {
              conversationId,
              limit: 50,
            })) as { messages: Message[] };
            for (const msg of result.messages) {
              dispatchMessage(msg, client);
            }
            totalFetched += result.messages.length;
          } catch {
            log?.warn?.(
              `MoltZap: failed to fetch missed messages for ${conversationId}`,
            );
          }
        }
        if (totalFetched > 0) {
          log?.info?.(
            `MoltZap: fetched ${totalFetched} missed messages from ${sorted.length} conversations`,
          );
        }
      }

      const eventHandlers: Record<string, (event: EventFrame) => void> = {
        "messages/received": (event) => {
          const message = extractMessage(event);
          if (message) dispatchMessage(message, client);
        },
        "messages/read": (event) => {
          const receipt = extractReadReceipt(event);
          if (receipt) {
            log?.debug?.(
              `MoltZap: read receipt from ${receipt.participant.id} in ${receipt.conversationId} up to seq ${receipt.seq}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "messages/delivered": (event) => {
          const delivery = extractDelivery(event);
          if (delivery) {
            log?.debug?.(
              `MoltZap: delivery for ${delivery.messageId} in ${delivery.conversationId}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "messages/reacted": (event) => {
          const reaction = extractReaction(event);
          if (reaction) {
            log?.debug?.(
              `MoltZap: reaction ${reaction.action} ${reaction.emoji} on ${reaction.messageId}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "messages/deleted": (event) => {
          const deletion = extractDeletion(event);
          if (deletion) {
            log?.debug?.(
              `MoltZap: message ${deletion.messageId} deleted in ${deletion.conversationId}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "conversations/created": (event) => {
          const created = extractConversationCreated(event);
          if (created) {
            conversationMetaCache.set(created.conversation.id, {
              type: created.conversation.type,
              name: created.conversation.name,
              participants: [],
            });
            log?.debug?.(
              `MoltZap: conversation created ${created.conversation.id}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "conversations/updated": (event) => {
          const updated = extractConversationUpdated(event);
          if (updated) {
            const existing = conversationMetaCache.get(updated.conversation.id);
            conversationMetaCache.set(updated.conversation.id, {
              type: updated.conversation.type,
              name: updated.conversation.name,
              participants: existing?.participants ?? [],
            });
            log?.debug?.(
              `MoltZap: conversation updated ${updated.conversation.id}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "contact/request": (event) => {
          const contact = extractContactRequest(event);
          if (contact) {
            log?.debug?.(
              `MoltZap: contact request from ${contact.contact.requesterId}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "contact/accepted": (event) => {
          const contact = extractContactAccepted(event);
          if (contact) {
            log?.debug?.(`MoltZap: contact accepted ${contact.contact.id}`);
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "presence/changed": (event) => {
          const presence = extractPresenceChanged(event);
          if (presence) {
            log?.debug?.(
              `MoltZap: ${presence.participant.id} is now ${presence.status}`,
            );
            setStatus({ accountId, lastEventAt: Date.now() });
          }
        },
        "typing/indicator": (event) => {
          const typing = extractTypingIndicator(event);
          if (typing) {
            log?.debug?.(
              `MoltZap: typing in ${typing.conversationId} by ${typing.participant.id}`,
            );
          }
        },
      };

      const client = new MoltZapWsClient({
        serverUrl: account.serverUrl,
        agentKey: account.apiKey,
        logger: log
          ? {
              info: log.info ?? (() => {}),
              warn: log.warn ?? (() => {}),
              error: log.error ?? (() => {}),
            }
          : undefined,
        onEvent: (event: EventFrame) => {
          const handler = eventHandlers[event.event];
          if (handler) {
            handler(event);
          } else {
            log?.debug?.(`MoltZap: unhandled event type: ${event.event}`);
          }
        },
        onDisconnect: () => {
          log?.warn?.("MoltZap: disconnected");
          setStatus({
            accountId,
            connected: false,
            lastDisconnect: { at: Date.now() },
          });
        },
        onReconnect: (helloOk: unknown) => {
          log?.info?.("MoltZap: reconnected");
          setStatus({
            accountId,
            connected: true,
            lastConnectedAt: Date.now(),
          });
          populateConversationCache(helloOk);
          void fetchMissedMessages(client, helloOk);
        },
      });

      function populateConversationCache(helloOk: unknown): void {
        const hello = helloOk as {
          conversations?: Array<{
            id: string;
            type: string;
            name?: string;
            participants?: Array<{ type: string; id: string }>;
          }>;
        } | null;
        if (!hello?.conversations) return;
        for (const conv of hello.conversations) {
          conversationMetaCache.set(conv.id, {
            type: conv.type,
            name: conv.name,
            participants: (conv.participants ?? []).map(
              (p) => `${p.type}:${p.id}`,
            ),
          });
        }
      }

      activeClients.set(accountId, client);

      abortSignal.addEventListener(
        "abort",
        () => {
          client.close();
          activeClients.delete(accountId);
        },
        { once: true },
      );

      try {
        const helloOk = await client.connect();
        ownAgentId = (helloOk as { agentId?: string })?.agentId;
        log?.info?.(
          `MoltZap: connected as ${account.agentName} (${ownAgentId})`,
        );
        setStatus({
          accountId,
          connected: true,
          lastConnectedAt: Date.now(),
        });
        populateConversationCache(helloOk);

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
      const client = activeClients.get(ctx.accountId);
      if (client) {
        ctx.log?.info?.("MoltZap: stopping");
        client.close();
        activeClients.delete(ctx.accountId);
        agentConversationCache.delete(ctx.accountId);
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
      const client = activeClients.get(accountId);
      if (!client) {
        return {
          ok: false as const,
          error: new Error("MoltZap client not connected"),
        };
      }

      try {
        let conversationId: string | undefined;

        if (ctx.to.startsWith(TARGET_PREFIX_AGENT)) {
          const agentName = ctx.to.slice(TARGET_PREFIX_AGENT.length);
          const accountCache =
            agentConversationCache.get(accountId) ?? new Map<string, string>();
          conversationId = accountCache.get(agentName);

          if (!conversationId) {
            const lookupResult = (await client.sendRpc("agents/lookupByName", {
              name: agentName,
            })) as { agent: { id: string } };

            const createResult = (await client.sendRpc("conversations/create", {
              type: "dm",
              participants: [{ type: "agent", id: lookupResult.agent.id }],
            })) as { conversation: { id: string } };

            conversationId = createResult.conversation.id;
            accountCache.set(agentName, conversationId);
            agentConversationCache.set(accountId, accountCache);
          }
        } else if (ctx.to.startsWith(TARGET_PREFIX_CONV)) {
          conversationId = ctx.to.slice(TARGET_PREFIX_CONV.length);
        } else {
          conversationId = ctx.to;
        }

        await client.sendRpc("messages/send", {
          conversationId,
          parts: [{ type: "text", text: ctx.text }],
          ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {}),
        });
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
