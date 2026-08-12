import { describe, expect, it } from "vitest";

import { conversationSearch } from "#conversation";
import { agentsSearch } from "#identity";
import { messagesRead } from "#message";
import { agentCallableMethods, serverInboundMethods } from "./index.js";

const READ_PLANE_METHODS = [
  agentsSearch,
  conversationSearch,
  messagesRead,
] as const;

describe("read-plane callable catalogs", () => {
  it.each(READ_PLANE_METHODS)(
    "includes $name in both inbound catalogs",
    (rpc) => {
      expect(agentCallableMethods).toContain(rpc);
      expect(serverInboundMethods).toContain(rpc);
    },
  );
});
