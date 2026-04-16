/** Idempotent seed system — registers agents via the public HTTP API, checks DB for existence. */

import type { Db } from "./db/client.js";
import type { Logger } from "./logger.js";

interface SeedAgent {
  name: string;
  description?: string;
}

export interface SeedConfig {
  agents?: SeedAgent[];
  onboarding_message?: string;
}

interface SeedOpts {
  config: SeedConfig;
  db: Db;
  baseUrl: string;
  registrationSecret?: string;
  logger: Logger;
}

interface RegisterResponse {
  agentId: string;
  apiKey: string;
}

export async function seedAgents(opts: SeedOpts): Promise<void> {
  const { config, db, baseUrl, registrationSecret, logger } = opts;
  if (!config.agents?.length) return;

  const createdAgents: Array<{
    agentId: string;
    apiKey: string;
    name: string;
  }> = [];

  for (const agentDef of config.agents) {
    // Idempotent: skip agents that already exist
    const existing = await db
      .selectFrom("agents")
      .where("name", "=", agentDef.name)
      .select("id")
      .executeTakeFirst();

    if (existing) {
      logger.info(
        { name: agentDef.name },
        "Seed agent already exists, skipping",
      );
      continue;
    }

    const body: Record<string, string> = { name: agentDef.name };
    if (agentDef.description) body["description"] = agentDef.description;
    if (registrationSecret) body["inviteCode"] = registrationSecret;

    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(
        { name: agentDef.name, status: res.status, body: text },
        "Failed to register seed agent",
      );
      continue;
    }

    const result = (await res.json()) as RegisterResponse;

    createdAgents.push({
      agentId: result.agentId,
      apiKey: result.apiKey,
      name: agentDef.name,
    });

    logger.info(
      { name: agentDef.name, agentId: result.agentId },
      "Seed agent created — API key: %s",
      result.apiKey,
    );
  }

  if (createdAgents.length >= 2 && config.onboarding_message) {
    logger.info(
      { agents: createdAgents.map((a) => a.name) },
      "Seed conversation available — connect agents via WebSocket to start messaging",
    );
  }
}
