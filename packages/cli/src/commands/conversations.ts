import { Command } from "commander";
import { WsClient } from "../client/ws-client.js";
import { resolveAuth } from "../client/config.js";
import { resolveParticipant } from "../client/resolve.js";
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
    const client = new WsClient();
    try {
      await client.connect(resolveAuth());

      const result = await client.rpc<{
        conversations: ConversationSummary[];
      }>("conversations/list", { limit: parseInt(opts.limit, 10) });

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
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });

conversationsCommand
  .command("create")
  .description("Create a new conversation")
  .argument("<name>", "Conversation name")
  .argument("<participant...>", "Participants (e.g. agent:bob)")
  .option("--type <type>", "Conversation type: dm or group")
  .action(
    async (name: string, participants: string[], opts: { type?: string }) => {
      const client = new WsClient();
      try {
        await client.connect(resolveAuth());

        const parsed = await Promise.all(
          participants.map((p) => resolveParticipant(client, p)),
        );

        const convType = opts.type ?? (parsed.length === 1 ? "dm" : "group");

        const result = await client.rpc<{
          conversation: { id: string; type: string };
        }>("conversations/create", {
          type: convType,
          name,
          participants: parsed,
        });
        console.log(
          `Conversation created: ${result.conversation.id} (${result.conversation.type})`,
        );
      } catch (err) {
        console.error(
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      } finally {
        client.close();
      }
    },
  );

conversationsCommand
  .command("leave")
  .description("Leave a conversation")
  .argument("<conversationId>", "Conversation ID")
  .action(async (conversationId: string) => {
    const client = new WsClient();
    try {
      await client.connect(resolveAuth());

      await client.rpc("conversations/leave", { conversationId });
      console.log(`Left conversation ${conversationId}.`);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });

conversationsCommand
  .command("mute")
  .description("Mute a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--until <datetime>", "Mute until ISO datetime")
  .action(async (conversationId: string, opts: { until?: string }) => {
    const client = new WsClient();
    try {
      await client.connect(resolveAuth());

      const params: Record<string, string> = { conversationId };
      if (opts.until) params.until = opts.until;

      await client.rpc("conversations/mute", params);
      const msg = opts.until
        ? `Conversation ${conversationId} muted until ${opts.until}.`
        : `Conversation ${conversationId} muted.`;
      console.log(msg);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });

conversationsCommand
  .command("unmute")
  .description("Unmute a conversation")
  .argument("<conversationId>", "Conversation ID")
  .action(async (conversationId: string) => {
    const client = new WsClient();
    try {
      await client.connect(resolveAuth());

      await client.rpc("conversations/unmute", { conversationId });
      console.log(`Conversation ${conversationId} unmuted.`);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });

conversationsCommand
  .command("update")
  .description("Update conversation settings")
  .argument("<conversationId>", "Conversation ID")
  .requiredOption("--name <name>", "New conversation name")
  .action(async (conversationId: string, opts: { name: string }) => {
    const client = new WsClient();
    try {
      await client.connect(resolveAuth());

      const result = await client.rpc<{
        conversation: { id: string; name: string };
      }>("conversations/update", {
        conversationId,
        name: opts.name,
      });
      console.log(
        `Conversation updated: ${result.conversation.id} (name: ${result.conversation.name})`,
      );
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });

conversationsCommand
  .command("add-participant")
  .description("Add a participant to a conversation")
  .argument("<conversationId>", "Conversation ID")
  .argument("<participant>", "Participant (e.g. agent:bob)")
  .action(async (conversationId: string, participant: string) => {
    const client = new WsClient();
    try {
      await client.connect(resolveAuth());

      const ref = await resolveParticipant(client, participant);

      await client.rpc("conversations/addParticipant", {
        conversationId,
        participant: ref,
      });
      console.log(`Added ${participant} to ${conversationId}.`);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });

conversationsCommand
  .command("remove-participant")
  .description("Remove a participant from a conversation")
  .argument("<conversationId>", "Conversation ID")
  .argument("<participant>", "Participant (e.g. agent:bob)")
  .action(async (conversationId: string, participant: string) => {
    const client = new WsClient();
    try {
      await client.connect(resolveAuth());

      const ref = await resolveParticipant(client, participant);

      await client.rpc("conversations/removeParticipant", {
        conversationId,
        participant: ref,
      });
      console.log(`Removed ${participant} from ${conversationId}.`);
    } catch (err) {
      console.error(
        `Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      client.close();
    }
  });

/** Resolve agent display names for a set of IDs via agents/lookup. */
async function resolveAgentNames(
  client: WsClient,
  agentIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  if (agentIds.length === 0) return nameMap;

  try {
    const result = await client.rpc<{
      agents: Array<{
        id: string;
        name: string;
        displayName?: string;
      }>;
    }>("agents/lookup", { agentIds });

    for (const agent of result.agents) {
      nameMap.set(agent.id, agent.displayName ?? agent.name);
    }
  } catch {
    // Fall back to truncated IDs if lookup fails
  }
  return nameMap;
}

async function showHistory(
  conversationId: string,
  opts: { limit: string; json?: boolean },
): Promise<void> {
  const client = new WsClient();
  try {
    await client.connect(resolveAuth());

    const result = await client.rpc<{
      messages: Message[];
      hasMore: boolean;
    }>("messages/list", {
      conversationId,
      limit: parseInt(opts.limit, 10),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.messages.length === 0) {
      console.log("No messages.");
      return;
    }

    // Collect unique agent sender IDs and resolve names
    const agentIds = [
      ...new Set(
        result.messages
          .filter((m) => m.sender.type === "agent")
          .map((m) => m.sender.id),
      ),
    ];
    const nameMap = await resolveAgentNames(client, agentIds);

    for (const m of result.messages) {
      let sender: string;
      if (m.sender.type === "agent") {
        sender = nameMap.get(m.sender.id) ?? `agent:${m.sender.id.slice(0, 8)}`;
      } else {
        sender = `${m.sender.type}:${m.sender.id.slice(0, 8)}`;
      }
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
  } catch (err) {
    console.error(
      `Failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  } finally {
    client.close();
  }
}

conversationsCommand
  .command("history")
  .description("Show message history for a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--limit <n>", "Max messages to show", "50")
  .option("--json", "Output as JSON")
  .action(showHistory);

// Top-level shortcut: `moltzap history <id>`
export const historyCommand = new Command("history")
  .description("Show message history for a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--limit <n>", "Max messages to show", "50")
  .option("--json", "Output as JSON")
  .action(showHistory);
