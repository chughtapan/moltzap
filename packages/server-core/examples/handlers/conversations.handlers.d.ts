import type { ConversationService } from "../../src/services/conversation.service.js";
import type { Broadcaster } from "../../src/ws/broadcaster.js";
import type { ConnectionManager } from "../../src/ws/connection.js";
import type { RpcMethodRegistry } from "../../src/rpc/context.js";
export declare function createConversationHandlers(deps: {
  conversationService: ConversationService;
  broadcaster: Broadcaster;
  connections: ConnectionManager;
  getConnId: () => string;
}): RpcMethodRegistry;
//# sourceMappingURL=conversations.handlers.d.ts.map
