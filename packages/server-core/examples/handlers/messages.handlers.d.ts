import type { MessageService } from "../../src/services/message.service.js";
import type { ConversationService } from "../../src/services/conversation.service.js";
import type { ConnectionManager } from "../../src/ws/connection.js";
import type { Db } from "../../src/db/client.js";
import type { RpcMethodRegistry } from "../../src/rpc/context.js";
export type ParsedTo = {
  type: "agent";
  identifier: string;
};
export declare function parseTo(to: string): ParsedTo;
export declare function createMessageHandlers(deps: {
  messageService: MessageService;
  conversationService: ConversationService;
  connections: ConnectionManager;
  db: Db;
  getConnId: () => string;
}): RpcMethodRegistry;
//# sourceMappingURL=messages.handlers.d.ts.map
