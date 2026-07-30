import path from "node:path";
import "./channels/index.js";
import {
  resolveUnknownSenderPolicy,
  resolveWiringDefaults,
} from "./channels/channel-defaults.js";
import { DATA_DIR } from "./config.js";
import { createAgentGroup, getAgentGroup } from "./db/agent-groups.js";
import {
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from "./db/container-configs.js";
import { closeDb, initDb } from "./db/connection.js";
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from "./db/messaging-groups.js";
import { runMigrations } from "./db/migrations/index.js";
import { initGroupFilesystem } from "./group-init.js";
import { upsertUser } from "./modules/permissions/db/users.js";
import type { AgentGroup, MessagingGroup } from "./types.js";

const [agentGroupId, agentGroupName, agentGroupFolder] = process.argv.slice(2);
const CLI_CHANNEL = "cli";
const CLI_PLATFORM_ID = "local";
const CLI_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;
const CLI_MESSAGING_GROUP_ID = "mg-moltzap-cli-local";
const CLI_WIRING_ID = "mga-moltzap-cli-local";

if (!agentGroupId || !agentGroupName || !agentGroupFolder) {
  throw new Error("usage: moltzap-eval-provision <id> <name> <folder>");
}

// The runtime database starts empty, so the simulator seeds the stable wiring
// target before the channel can receive a dynamically created conversation.
const database = initDb(path.join(DATA_DIR, "v2.db"));
runMigrations(database);

let agentGroup = getAgentGroup(agentGroupId);
if (agentGroup === undefined) {
  const created: AgentGroup = {
    id: agentGroupId,
    name: agentGroupName,
    folder: agentGroupFolder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  createAgentGroup(created);
  agentGroup = created;
}

// NanoClaw's group initializer owns both workspace scaffolding and the
// companion container-config row required by the first container spawn.
initGroupFilesystem(agentGroup);

// The persistent principal gateway uses NanoClaw's ordinary CLI channel.
// Seed that channel through the same database functions as NanoClaw's own
// setup script, targeting the runtime's already-created agent group.
const now = new Date().toISOString();
upsertUser({
  id: CLI_USER_ID,
  kind: CLI_CHANNEL,
  display_name: agentGroupName,
  created_at: now,
});

let cliGroup: MessagingGroup | undefined = getMessagingGroupByPlatform(
  CLI_CHANNEL,
  CLI_PLATFORM_ID,
);
if (cliGroup === undefined) {
  cliGroup = {
    id: CLI_MESSAGING_GROUP_ID,
    channel_type: CLI_CHANNEL,
    platform_id: CLI_PLATFORM_ID,
    name: "Local CLI",
    is_group: 0,
    unknown_sender_policy: resolveUnknownSenderPolicy(CLI_CHANNEL, false),
    created_at: now,
  };
  createMessagingGroup(cliGroup);
}

if (getMessagingGroupAgentByPair(cliGroup.id, agentGroup.id) === undefined) {
  const engage = resolveWiringDefaults(CLI_CHANNEL, false, agentGroup.name);
  createMessagingGroupAgent({
    id: CLI_WIRING_ID,
    messaging_group_id: cliGroup.id,
    agent_group_id: agentGroup.id,
    engage_mode: engage.engage_mode,
    engage_pattern: engage.engage_pattern,
    sender_scope: "all",
    ignored_message_policy: "drop",
    session_mode: "shared",
    priority: 0,
    created_at: now,
  });
}

// The harness expresses per-agent model and MCP mounts as env pairs on
// this provisioning run; they land on the container-config row here,
// before the first container spawn materializes it into container.json.
const model = process.env["MOLTZAP_AGENT_MODEL"];
if (model !== undefined && model.length > 0) {
  updateContainerConfigScalars(agentGroup.id, { model });
}
const mcpServers = process.env["MOLTZAP_MCP_SERVERS"];
if (mcpServers !== undefined && mcpServers.length > 0) {
  updateContainerConfigJson(
    agentGroup.id,
    "mcp_servers",
    JSON.parse(mcpServers),
  );
}
closeDb();
