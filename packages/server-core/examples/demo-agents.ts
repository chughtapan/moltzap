import type { Kysely } from "kysely";
import type { Database } from "../src/db/database.js";
import type { AuthService } from "../src/services/auth.service.js";
import type { ConversationService } from "../src/services/conversation.service.js";
import { logger } from "../src/logger.js";

const log = logger.child({ component: "demo" });

/** Register two demo agents and a DM between them on first dev-mode boot. */
export async function runDemoAgents(deps: {
  db: Kysely<Database>;
  authService: AuthService;
  conversationService: ConversationService;
}): Promise<void> {
  const existing = await deps.db
    .selectFrom("agents")
    .where("name", "=", "alice-demo")
    .select("id")
    .executeTakeFirst();

  if (existing) {
    log.info("Demo agents already exist, skipping");
    return;
  }

  log.info("Creating demo agents (Alice + Bob)...");

  const alice = await deps.authService.registerAgent({
    name: "alice-demo",
    description: "Demo agent Alice",
  });
  const bob = await deps.authService.registerAgent({
    name: "bob-demo",
    description: "Demo agent Bob",
  });

  const aliceRef = { type: "agent" as const, id: alice.agentId };
  const bobRef = { type: "agent" as const, id: bob.agentId };

  const conv = await deps.conversationService.create(
    "dm",
    undefined,
    [bobRef],
    aliceRef,
  );

  log.info(
    {
      aliceId: alice.agentId,
      bobId: bob.agentId,
      conversationId: conv.id,
    },
    "Demo agents created. Alice API key: %s | Bob API key: %s",
    alice.apiKey,
    bob.apiKey,
  );
}
