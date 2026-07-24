import path from "node:path";
import { DATA_DIR } from "./config.js";
import { createAgentGroup, getAgentGroup } from "./db/agent-groups.js";
import { closeDb, initDb } from "./db/connection.js";
import { runMigrations } from "./db/migrations/index.js";
import { initGroupFilesystem } from "./group-init.js";
import type { AgentGroup } from "./types.js";

const [agentGroupId, agentGroupName, agentGroupFolder] = process.argv.slice(2);

if (!agentGroupId || !agentGroupName || !agentGroupFolder) {
  throw new Error("usage: moltzap-eval-provision <id> <name> <folder>");
}

// The runtime database starts empty, so the harness seeds the stable wiring
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
closeDb();
