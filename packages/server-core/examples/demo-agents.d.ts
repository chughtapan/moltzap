import type { Kysely } from "kysely";
import type { Database } from "../src/db/database.js";
import type { AuthService } from "../src/services/auth.service.js";
import type { ConversationService } from "../src/services/conversation.service.js";
/** Register two demo agents and a DM between them on first dev-mode boot. */
export declare function runDemoAgents(deps: {
  db: Kysely<Database>;
  authService: AuthService;
  conversationService: ConversationService;
}): Promise<void>;
//# sourceMappingURL=demo-agents.d.ts.map
