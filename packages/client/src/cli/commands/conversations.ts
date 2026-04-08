import { Command } from "commander";
import { withService } from "../with-service.js";
import { resolveParticipant } from "../resolve.js";
import type { MoltZapService } from "../../service.js";
import type { ConversationSummary, Message } from "@moltzap/protocol";

export const conversationsCommand = new Command("conversations").description(
  "Manage conversations",
);

conversationsCommand
  .command("list")
  .description("List conversations with unread counts")
  .option("--limit <n>", "Max conversations to list", "20")
  .option("--json", "Output as JSON")
  .action(async (opts: { limit: string; json?: boolean }) => {
    await withService(async (service) => {
      const result = (await service.sendRpc("conversations/list", {
        limit: parseInt(opts.limit, 10),
      })) as { conversations: ConversationSummary[] };

      if (opts.json) {
        console.log(JSON.stringify(result.conversations, null, 2));
        return;
      }
      if (result.conversations.length === 0) {
        console.log("No conversations.");
        return;
      }
      for (const c of result.conversations) {
        const unread = c.unreadCount > 0 ? ` (${c.unreadCount} unread)` : "";
        const name = c.name ?? c.type;
        console.log(`  ${c.id}  ${name}${unread}`);
        if (c.lastMessagePreview) {
          console.log(`    Last: ${c.lastMessagePreview}`);
        }
      }
    });
  });

conversationsCommand
  .command("create")
  .description("Create a new conversation")
  .argument("<name>", "Conversation name")
  .argument("<participant...>", "Participants (e.g. agent:bob)")
  .option("--type <type>", "Conversation type: dm or group")
  .action(
    async (name: string, participants: string[], opts: { type?: string }) => {
      await withService(async (service) => {
        const parsed = await Promise.all(
          participants.map((p) => resolveParticipant(service, p)),
        );
        const convType = opts.type ?? (parsed.length === 1 ? "dm" : "group");
        const result = (await service.sendRpc("conversations/create", {
          type: convType,
          name,
          participants: parsed,
        })) as { conversation: { id: string; type: string } };
        console.log(
          `Conversation created: ${result.conversation.id} (${result.conversation.type})`,
        );
      });
    },
  );

conversationsCommand
  .command("leave")
  .description("Leave a conversation")
  .argument("<conversationId>", "Conversation ID")
  .action(async (conversationId: string) => {
    await withService(async (service) => {
      await service.sendRpc("conversations/leave", { conversationId });
      console.log(`Left conversation ${conversationId}.`);
    });
  });

conversationsCommand
  .command("mute")
  .description("Mute a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--until <datetime>", "Mute until ISO datetime")
  .action(async (conversationId: string, opts: { until?: string }) => {
    await withService(async (service) => {
      const params: Record<string, string> = { conversationId };
      if (opts.until) params.until = opts.until;
      await service.sendRpc("conversations/mute", params);
      console.log(
        opts.until
          ? `Conversation ${conversationId} muted until ${opts.until}.`
          : `Conversation ${conversationId} muted.`,
      );
    });
  });

conversationsCommand
  .command("unmute")
  .description("Unmute a conversation")
  .argument("<conversationId>", "Conversation ID")
  .action(async (conversationId: string) => {
    await withService(async (service) => {
      await service.sendRpc("conversations/unmute", { conversationId });
      console.log(`Conversation ${conversationId} unmuted.`);
    });
  });

conversationsCommand
  .command("update")
  .description("Update conversation settings")
  .argument("<conversationId>", "Conversation ID")
  .requiredOption("--name <name>", "New conversation name")
  .action(async (conversationId: string, opts: { name: string }) => {
    await withService(async (service) => {
      const result = (await service.sendRpc("conversations/update", {
        conversationId,
        name: opts.name,
      })) as { conversation: { id: string; name: string } };
      console.log(
        `Conversation updated: ${result.conversation.id} (name: ${result.conversation.name})`,
      );
    });
  });

conversationsCommand
  .command("add-participant")
  .description("Add a participant to a conversation")
  .argument("<conversationId>", "Conversation ID")
  .argument("<participant>", "Participant (e.g. agent:bob)")
  .action(async (conversationId: string, participant: string) => {
    await withService(async (service) => {
      const ref = await resolveParticipant(service, participant);
      await service.sendRpc("conversations/addParticipant", {
        conversationId,
        participant: ref,
      });
      console.log(`Added ${participant} to ${conversationId}.`);
    });
  });

conversationsCommand
  .command("remove-participant")
  .description("Remove a participant from a conversation")
  .argument("<conversationId>", "Conversation ID")
  .argument("<participant>", "Participant (e.g. agent:bob)")
  .action(async (conversationId: string, participant: string) => {
    await withService(async (service) => {
      const ref = await resolveParticipant(service, participant);
      await service.sendRpc("conversations/removeParticipant", {
        conversationId,
        participant: ref,
      });
      console.log(`Removed ${participant} from ${conversationId}.`);
    });
  });

async function resolveAgentNames(
  service: MoltZapService,
  agentIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  if (agentIds.length === 0) return nameMap;
  try {
    const result = (await service.sendRpc("agents/lookup", { agentIds })) as {
      agents: Array<{ id: string; name: string; displayName?: string }>;
    };
    for (const agent of result.agents) {
      nameMap.set(agent.id, agent.displayName ?? agent.name);
    }
  } catch {
    // Fall back to truncated IDs
  }
  return nameMap;
}

async function showHistory(
  conversationId: string,
  opts: { limit: string; json?: boolean },
): Promise<void> {
  await withService(async (service) => {
    const result = (await service.sendRpc("messages/list", {
      conversationId,
      limit: parseInt(opts.limit, 10),
    })) as { messages: Message[]; hasMore: boolean };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.messages.length === 0) {
      console.log("No messages.");
      return;
    }

    const agentIds = [
      ...new Set(
        result.messages
          .filter((m) => m.sender.type === "agent")
          .map((m) => m.sender.id),
      ),
    ];
    const nameMap = await resolveAgentNames(service, agentIds);

    for (const m of result.messages) {
      const sender =
        m.sender.type === "agent"
          ? (nameMap.get(m.sender.id) ?? `agent:${m.sender.id.slice(0, 8)}`)
          : `${m.sender.type}:${m.sender.id.slice(0, 8)}`;
      const text = m.parts
        .map((p) => {
          if (p.type === "text") return p.text;
          if (p.type === "image")
            return `[image${p.altText ? `: ${p.altText}` : ""}]`;
          if (p.type === "file") return `[file: ${p.name}]`;
          return "[unknown]";
        })
        .join(" ");
      const deleted = m.isDeleted ? " [deleted]" : "";
      console.log(`  [${m.createdAt}] ${sender}: ${text}${deleted}`);
    }

    if (result.hasMore) {
      console.log("  ... more messages available");
    }
  });
}

conversationsCommand
  .command("history")
  .description("Show message history for a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--limit <n>", "Max messages to show", "50")
  .option("--json", "Output as JSON")
  .action(showHistory);

export const historyCommand = new Command("history")
  .description("Show message history for a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--limit <n>", "Max messages to show", "50")
  .option("--json", "Output as JSON")
  .action(showHistory);
