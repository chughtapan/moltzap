import path from "node:path";
import { DATA_DIR } from "./config.js";
import { createAgentGroup, getAgentGroup } from "./db/agent-groups.js";
import {
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from "./db/container-configs.js";
import { closeDb, initDb } from "./db/connection.js";
import { runMigrations } from "./db/migrations/index.js";
import { initGroupFilesystem } from "./group-init.js";
import type { AgentGroup } from "./types.js";

const [agentGroupId, agentGroupName, agentGroupFolder] = process.argv.slice(2);

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
