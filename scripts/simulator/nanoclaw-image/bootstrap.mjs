/** @file NanoClaw-native first-conversation wiring for the simulator channel. */
import { pathToFileURL } from "node:url";

export const EVALUATION_AGENT_GROUP_ID = "eval-agent";

function moduleUrl(appRoot, relativePath) {
  return pathToFileURL(`${appRoot}/dist/${relativePath}`).href;
}

/**
 * Build a channel-card interceptor that wires MoltZap conversations to the
 * pre-provisioned evaluation agent, then replays every triggering event.
 */
export function createMoltZapConversationBootstrap({
  agentGroupId = EVALUATION_AGENT_GROUP_ID,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getSessionsByAgentGroup,
  renameDestination,
  routeInbound,
  updateMessagingGroup,
  updateMessagingGroupAgent,
  writeDestinations,
}) {
  const pending = new Map();

  async function ensureWiring(messagingGroup) {
    await updateMessagingGroup(messagingGroup.id, {
      unknown_sender_policy: "public",
    });
    let wiring = await getMessagingGroupAgentByPair(
      messagingGroup.id,
      agentGroupId,
    );
    if (wiring === undefined) {
      await createMessagingGroupAgent({
        id: `mga-moltzap-${messagingGroup.id}`,
        messaging_group_id: messagingGroup.id,
        agent_group_id: agentGroupId,
        engage_mode: "pattern",
        engage_pattern: ".",
        sender_scope: "all",
        ignored_message_policy: "drop",
        session_mode: "agent-shared",
        priority: 0,
        created_at: new Date().toISOString(),
      });
      wiring = await getMessagingGroupAgentByPair(
        messagingGroup.id,
        agentGroupId,
      );
    } else if (wiring.session_mode !== "agent-shared") {
      await updateMessagingGroupAgent(wiring.id, {
        session_mode: "agent-shared",
      });
    }

    await renameDestination(
      agentGroupId,
      messagingGroup.id,
      messagingGroup.platform_id,
    );
    for (const session of await getSessionsByAgentGroup(agentGroupId)) {
      if (session.status === "active") {
        await writeDestinations(agentGroupId, session.id);
      }
    }
  }

  return async (messagingGroup, event) => {
    let setup = pending.get(messagingGroup.id);
    if (setup === undefined) {
      setup = ensureWiring(messagingGroup).finally(() => {
        pending.delete(messagingGroup.id);
      });
      pending.set(messagingGroup.id, setup);
    }
    await setup;
    await routeInbound(event);
    return "handled";
  };
}

/** Install the bootstrap through NanoClaw's channel-card interceptor seam. */
export async function installMoltZapConversationBootstrap({
  appRoot = "/opt/moltzap/nanoclaw/app",
  agentGroupId = process.env.MOLTZAP_NANOCLAW_AGENT_GROUP_ID ??
    EVALUATION_AGENT_GROUP_ID,
} = {}) {
  const [
    approval,
    connection,
    messagingGroups,
    sessions,
    router,
    destinations,
  ] = await Promise.all([
    import(moduleUrl(appRoot, "modules/permissions/channel-approval.js")),
    import(moduleUrl(appRoot, "db/connection.js")),
    import(moduleUrl(appRoot, "db/messaging-groups.js")),
    import(moduleUrl(appRoot, "db/sessions.js")),
    import(moduleUrl(appRoot, "router.js")),
    import(moduleUrl(appRoot, "modules/agent-to-agent/write-destinations.js")),
  ]);

  const renameDestination = async (sourceAgentGroupId, targetId, localName) => {
    await connection.getDb().run(
      `UPDATE agent_destinations
          SET local_name = ?
        WHERE agent_group_id = ?
          AND target_type = 'channel'
          AND target_id = ?`,
      localName,
      sourceAgentGroupId,
      targetId,
    );
  };

  approval.registerChannelCardInterceptor(
    "moltzap",
    createMoltZapConversationBootstrap({
      agentGroupId,
      createMessagingGroupAgent: messagingGroups.createMessagingGroupAgent,
      getMessagingGroupAgentByPair:
        messagingGroups.getMessagingGroupAgentByPair,
      getSessionsByAgentGroup: sessions.getSessionsByAgentGroup,
      renameDestination,
      routeInbound: router.routeInbound,
      updateMessagingGroup: messagingGroups.updateMessagingGroup,
      updateMessagingGroupAgent: messagingGroups.updateMessagingGroupAgent,
      writeDestinations: destinations.writeDestinations,
    }),
  );
}
