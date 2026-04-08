import { Command } from "commander";
import { request, action, resolveParticipant } from "../socket-client.js";
import type { ConversationSummary } from "@moltzap/protocol";

export const conversationsCommand = new Command("conversations").description(
  "Manage conversations",
);

conversationsCommand
  .command("list")
  .description("List conversations with unread counts")
  .option("--limit <n>", "Max conversations to list", "20")
  .option("--json", "Output as JSON")
  .action(
    action(async (opts: { limit: string; json?: boolean }) => {
      const result = (await request("conversations/list", {
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
    }),
  );

conversationsCommand
  .command("create")
  .description("Create a new conversation")
  .argument("<name>", "Conversation name")
  .argument("<participant...>", "Participants (e.g. agent:bob)")
  .option("--type <type>", "Conversation type: dm or group")
  .action(
    action(
      async (name: string, participants: string[], opts: { type?: string }) => {
        const parsed = await Promise.all(participants.map(resolveParticipant));
        const convType = opts.type ?? (parsed.length === 1 ? "dm" : "group");
        const result = (await request("conversations/create", {
          type: convType,
          name,
          participants: parsed,
        })) as { conversation: { id: string; type: string } };
        console.log(
          `Conversation created: ${result.conversation.id} (${result.conversation.type})`,
        );
      },
    ),
  );

conversationsCommand
  .command("leave")
  .description("Leave a conversation")
  .argument("<conversationId>", "Conversation ID")
  .action(
    action(async (conversationId: string) => {
      await request("conversations/leave", { conversationId });
      console.log(`Left conversation ${conversationId}.`);
    }),
  );

conversationsCommand
  .command("mute")
  .description("Mute a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--until <datetime>", "Mute until ISO datetime")
  .action(
    action(async (conversationId: string, opts: { until?: string }) => {
      const params: Record<string, string> = { conversationId };
      if (opts.until) params.until = opts.until;
      await request("conversations/mute", params);
      console.log(
        opts.until
          ? `Conversation ${conversationId} muted until ${opts.until}.`
          : `Conversation ${conversationId} muted.`,
      );
    }),
  );

conversationsCommand
  .command("unmute")
  .description("Unmute a conversation")
  .argument("<conversationId>", "Conversation ID")
  .action(
    action(async (conversationId: string) => {
      await request("conversations/unmute", { conversationId });
      console.log(`Conversation ${conversationId} unmuted.`);
    }),
  );

conversationsCommand
  .command("update")
  .description("Update conversation settings")
  .argument("<conversationId>", "Conversation ID")
  .requiredOption("--name <name>", "New conversation name")
  .action(
    action(async (conversationId: string, opts: { name: string }) => {
      const result = (await request("conversations/update", {
        conversationId,
        name: opts.name,
      })) as { conversation: { id: string; name: string } };
      console.log(
        `Conversation updated: ${result.conversation.id} (name: ${result.conversation.name})`,
      );
    }),
  );

conversationsCommand
  .command("add-participant")
  .description("Add a participant to a conversation")
  .argument("<conversationId>", "Conversation ID")
  .argument("<participant>", "Participant (e.g. agent:bob)")
  .action(
    action(async (conversationId: string, participant: string) => {
      const ref = await resolveParticipant(participant);
      await request("conversations/addParticipant", {
        conversationId,
        participant: ref,
      });
      console.log(`Added ${participant} to ${conversationId}.`);
    }),
  );

conversationsCommand
  .command("remove-participant")
  .description("Remove a participant from a conversation")
  .argument("<conversationId>", "Conversation ID")
  .argument("<participant>", "Participant (e.g. agent:bob)")
  .action(
    action(async (conversationId: string, participant: string) => {
      const ref = await resolveParticipant(participant);
      await request("conversations/removeParticipant", {
        conversationId,
        participant: ref,
      });
      console.log(`Removed ${participant} from ${conversationId}.`);
    }),
  );

interface HistoryMessage {
  seq: number;
  senderId: string;
  senderName: string;
  isOwn: boolean;
  text: string;
  createdAt: string;
  isNew: boolean;
}

async function showHistory(
  conversationId: string,
  opts: { limit: string; json?: boolean; sessionKey?: string },
): Promise<void> {
  const result = (await request("history", {
    conversationId,
    limit: parseInt(opts.limit, 10),
    sessionKey: opts.sessionKey,
  })) as {
    messages: HistoryMessage[];
    hasMore: boolean;
    conversationMeta?: { type: string; name?: string };
    newCount: number;
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.messages.length === 0) {
    console.log("No messages.");
    return;
  }

  if (opts.sessionKey && result.conversationMeta) {
    const label = result.conversationMeta.name ?? result.conversationMeta.type;
    console.log(
      `Conversation: ${label} (${conversationId}) | ${result.newCount} new`,
    );
    console.log("");
  }

  for (const m of result.messages) {
    const ago = Math.max(
      0,
      Math.round((Date.now() - new Date(m.createdAt).getTime()) / 60_000),
    );
    const newMarker = m.isNew ? " *" : "";
    console.log(`  [${ago}m ago] ${m.senderName}: ${m.text}${newMarker}`);
  }

  if (result.hasMore) {
    console.log("  ... more messages available");
  }
}

conversationsCommand
  .command("history")
  .description("Show message history for a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--limit <n>", "Max messages to show", "50")
  .option("--json", "Output as JSON")
  .option("--session-key <key>", "Session key for cross-conversation context")
  .action(action(showHistory));

export const historyCommand = new Command("history")
  .description("Show message history for a conversation")
  .argument("<conversationId>", "Conversation ID")
  .option("--limit <n>", "Max messages to show", "50")
  .option("--json", "Output as JSON")
  .option("--session-key <key>", "Session key for cross-conversation context")
  .action(action(showHistory));
