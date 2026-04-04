import type { AuthService } from "../../src/services/auth.service.js";
import type { ConversationService } from "../../src/services/conversation.service.js";
import type { PresenceService } from "../../src/services/presence.service.js";
import type { RpcMethodRegistry } from "../../src/rpc/context.js";
import type { ConnectionManager } from "../../src/ws/connection.js";
import type { Broadcaster } from "../../src/ws/broadcaster.js";
import type { Db } from "../../src/db/client.js";
export declare function createCoreAuthHandlers(deps: {
  authService: AuthService;
  conversationService: ConversationService;
  presenceService: PresenceService;
  broadcaster: Broadcaster;
  connections: ConnectionManager;
  db: Db;
  getConnId: () => string;
}): RpcMethodRegistry;
//# sourceMappingURL=auth.handlers.d.ts.map
