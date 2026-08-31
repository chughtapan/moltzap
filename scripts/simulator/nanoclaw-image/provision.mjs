/** @file Idempotently provisions NanoClaw's native database for one eval agent. */
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EVALUATION_AGENT_GROUP_ID } from "./bootstrap.mjs";

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
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
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

/** Provision the fixed agent and local CLI wiring before the host starts. */
export async function provisionNanoClaw(
  config,
  { appRoot = "/opt/moltzap/nanoclaw/app" } = {},
) {
  // These barrels register optional migrations and the CLI channel defaults.
  await import(moduleUrl(appRoot, "modules/index.js"));
  await import(moduleUrl(appRoot, "channels/index.js"));

  const [
    agentGroups,
    connection,
    containerConfigs,
    configModule,
    groupInit,
    messagingGroups,
    migrations,
    users,
    upgrade,
  ] = await Promise.all([
    import(moduleUrl(appRoot, "db/agent-groups.js")),
    import(moduleUrl(appRoot, "db/connection.js")),
    import(moduleUrl(appRoot, "db/container-configs.js")),
    import(moduleUrl(appRoot, "config.js")),
    import(moduleUrl(appRoot, "group-init.js")),
    import(moduleUrl(appRoot, "db/messaging-groups.js")),
    import(moduleUrl(appRoot, "db/migrations/index.js")),
    import(moduleUrl(appRoot, "modules/permissions/db/users.js")),
    import(moduleUrl(appRoot, "upgrade-state.js")),
  ]);

  const db = await connection.initDb(configModule.CENTRAL_DB_PATH, {
    role: "tool",
  });
  try {
    await migrations.runMigrations(db, undefined, { mode: "auto" });
    const now = new Date().toISOString();
    let agent = await agentGroups.getAgentGroup(EVALUATION_AGENT_GROUP_ID);
    if (agent === undefined) {
      agent = {
        id: EVALUATION_AGENT_GROUP_ID,
        name: config.agentName,
        folder: EVALUATION_AGENT_GROUP_ID,
        agent_provider: null,
        created_at: now,
      };
      await agentGroups.createAgentGroup(agent);
    } else if (agent.name !== config.agentName) {
      await agentGroups.updateAgentGroup(agent.id, { name: config.agentName });
      agent = { ...agent, name: config.agentName };
    }

    await groupInit.initGroupFilesystem(agent, { provider: "claude" });
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

    await users.upsertUser({
      id: "cli:local",
      kind: "cli",
      display_name: "MoltZap simulator",
      created_at: now,
    });
    let cliGroup = await messagingGroups.getMessagingGroupByPlatform(
      "cli",
      "local",
      "cli",
    );
    if (cliGroup === undefined) {
      cliGroup = {
        id: "mg-moltzap-cli-local",
        channel_type: "cli",
        platform_id: "local",
        instance: "cli",
        name: "MoltZap simulator CLI",
        is_group: 0,
        unknown_sender_policy: "public",
        created_at: now,
      };
      await messagingGroups.createMessagingGroup(cliGroup);
    }
    const existing = await messagingGroups.getMessagingGroupAgentByPair(
      cliGroup.id,
      agent.id,
    );
    if (existing === undefined) {
      await messagingGroups.createMessagingGroupAgent({
        id: "mga-moltzap-cli-local",
        messaging_group_id: cliGroup.id,
        agent_group_id: agent.id,
        engage_mode: "pattern",
        engage_pattern: ".",
        sender_scope: "all",
        ignored_message_policy: "drop",
        session_mode: "agent-shared",
        priority: 0,
        created_at: now,
      });
    } else if (existing.session_mode !== "agent-shared") {
      await messagingGroups.updateMessagingGroupAgent(existing.id, {
        session_mode: "agent-shared",
      });
    }

    upgrade.writeUpgradeState({
      via: "moltzap-simulator",
      projectRoot: config.stateDirectory,
    });
  } finally {
    await connection.closeDb();
  }
}
