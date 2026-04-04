import type { PresenceService } from "../../src/services/presence.service.js";
import type { ConversationService } from "../../src/services/conversation.service.js";
import type { RpcMethodRegistry } from "../../src/rpc/context.js";
import type { Broadcaster } from "../../src/ws/broadcaster.js";
import type { ConnectionManager } from "../../src/ws/connection.js";
export declare function createPresenceHandlers(deps: {
    presenceService: PresenceService;
    conversationService: ConversationService;
    broadcaster: Broadcaster;
    connections: ConnectionManager;
    getConnId: () => string;
}): RpcMethodRegistry;
//# sourceMappingURL=presence.handlers.d.ts.map