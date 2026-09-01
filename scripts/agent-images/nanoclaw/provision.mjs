/** @file Idempotently initializes NanoClaw's one image-owned agent group. */
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const AGENT_GROUP_ID = "agent";

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

/**
 * Initialize the native agent group that gives the single host its workspace.
 *
 * Conversations, sessions, and channel wiring remain absent until NanoClaw
 * receives traffic and routes it through its normal host lifecycle.
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
    migrations,
    upgrade,
  ] = await Promise.all([
    import(moduleUrl(appRoot, "db/agent-groups.js")),
    import(moduleUrl(appRoot, "db/connection.js")),
    import(moduleUrl(appRoot, "db/container-configs.js")),
    import(moduleUrl(appRoot, "config.js")),
    import(moduleUrl(appRoot, "group-init.js")),
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
