/** @file Idempotently initializes NanoClaw's one image-owned agent group. */
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const AGENT_GROUP_ID = "agent";
const PRINCIPAL_CHANNEL = "cli";
const PRINCIPAL_MESSAGING_GROUP_ID = "moltzap-principal";
const PRINCIPAL_PLATFORM_ID = "local";

function moduleUrl(appRoot, relativePath) {
  return pathToFileURL(`${appRoot}/dist/${relativePath}`).href;
}

function mcpServerRecord(servers) {
  return Object.fromEntries(
    servers.map((server) => [
      server.name,
      "url" in server
        ? { type: "http", url: server.url }
        : {
            command: server.command,
            args: server.args,
            env: server.env,
          },
    ]),
  );
}

async function seedWorkspace(sourceDirectory, targetDirectory) {
  await mkdir(targetDirectory, { recursive: true });
  let entries;
  try {
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    await cp(
      join(sourceDirectory, entry.name),
      join(targetDirectory, entry.name),
      {
        recursive: entry.isDirectory(),
        force: false,
        errorOnExist: false,
      },
    );
  }
}

async function wirePrincipalGateway(messagingGroups, agentGroupId, now) {
  let group = await messagingGroups.getMessagingGroupByPlatform(
    PRINCIPAL_CHANNEL,
    PRINCIPAL_PLATFORM_ID,
    PRINCIPAL_CHANNEL,
  );
  if (group === undefined) {
    group = {
      id: PRINCIPAL_MESSAGING_GROUP_ID,
      channel_type: PRINCIPAL_CHANNEL,
      platform_id: PRINCIPAL_PLATFORM_ID,
      instance: PRINCIPAL_CHANNEL,
      name: "MoltZap principal",
      is_group: 0,
      unknown_sender_policy: "public",
      created_at: now,
    };
    await messagingGroups.createMessagingGroup(group);
  }

  const wiring = await messagingGroups.getMessagingGroupAgentByPair(
    group.id,
    agentGroupId,
  );
  if (wiring === undefined) {
    await messagingGroups.createMessagingGroupAgent({
      id: "moltzap-principal-agent",
      messaging_group_id: group.id,
      agent_group_id: agentGroupId,
      engage_mode: "pattern",
      engage_pattern: ".",
      sender_scope: "all",
      ignored_message_policy: "drop",
      session_mode: "agent-shared",
      priority: 0,
      created_at: now,
    });
  }
}

/**
 * Initialize the native agent group that gives the single host its workspace.
 *
 * The owner-local CLI gateway is wired during provisioning. MoltZap
 * conversations and sessions remain absent until NanoClaw receives traffic
 * and routes it through its normal host lifecycle.
 */
export async function provisionNanoClaw(
  config,
  { appRoot = "/opt/moltzap/nanoclaw/app" } = {},
) {
  // The module barrel contributes the migrations used by the stock host.
  await import(moduleUrl(appRoot, "modules/index.js"));

  const [
    agentGroups,
    connection,
    containerConfigs,
    configModule,
    groupInit,
    messagingGroups,
    migrations,
    upgrade,
  ] = await Promise.all([
    import(moduleUrl(appRoot, "db/agent-groups.js")),
    import(moduleUrl(appRoot, "db/connection.js")),
    import(moduleUrl(appRoot, "db/container-configs.js")),
    import(moduleUrl(appRoot, "config.js")),
    import(moduleUrl(appRoot, "group-init.js")),
    import(moduleUrl(appRoot, "db/messaging-groups.js")),
    import(moduleUrl(appRoot, "db/migrations/index.js")),
    import(moduleUrl(appRoot, "upgrade-state.js")),
  ]);

  const db = await connection.initDb(configModule.CENTRAL_DB_PATH, {
    role: "tool",
  });
  try {
    await migrations.runMigrations(db, undefined, { mode: "auto" });
    const now = new Date().toISOString();
    let agent = await agentGroups.getAgentGroup(AGENT_GROUP_ID);
    if (agent === undefined) {
      agent = {
        id: AGENT_GROUP_ID,
        name: config.agentName,
        folder: AGENT_GROUP_ID,
        agent_provider: null,
        created_at: now,
      };
      await agentGroups.createAgentGroup(agent);
    } else if (agent.name !== config.agentName) {
      await agentGroups.updateAgentGroup(agent.id, { name: config.agentName });
      agent = { ...agent, name: config.agentName };
    }

    await groupInit.initGroupFilesystem(agent, { provider: "claude" });
    await wirePrincipalGateway(messagingGroups, agent.id, now);
    await seedWorkspace(
      config.workspaceDirectory,
      join(config.stateDirectory, "groups", agent.folder),
    );
    await containerConfigs.updateContainerConfigScalars(agent.id, {
      assistant_name: config.agentName,
      ...(config.modelId === undefined ? {} : { model: config.modelId }),
    });
    await containerConfigs.updateContainerConfigJson(
      agent.id,
      "mcp_servers",
      mcpServerRecord(config.mcpServers),
    );

    upgrade.writeUpgradeState({
      via: "moltzap-agent-image",
      projectRoot: config.stateDirectory,
    });
  } finally {
    await connection.closeDb();
  }
}
