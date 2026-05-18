# Claude Reply → MoltZap Outbound

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Claude invokes the `reply` MCP tool. The MCP SDK deserializes the
JSON-RPC call and hands it to the registered `CallTool` handler.

```mermaid
sequenceDiagram
    participant Claude as Claude Code
    participant mcp as MCP SDK (stdio)
    participant server as server.ts
    participant entry as entry.ts
    participant client as @moltzap/client

    Claude->>mcp: tool call JSON<br/>{ name:"reply", arguments:{ text:"...", reply_to?:"msg-id" } }
    mcp->>server: CallToolRequest — handleCallToolRequest

    alt [1] name != "reply"
        server-->>mcp: toolErrorResult("unknown tool: ...")
    end

    note over server: YES: decodeReplyArgs(request.params.arguments)
    alt arguments not object / text missing or blank
        server-->>mcp: toolErrorResult(ReplyArgsInvalid.reason)
    end

    note over server: handleDecodedReplyCall(decoded, deps)

    alt [2] decoded.files non-empty
        server-->>mcp: filesUnsupportedResult (v1 limitation)
    end

    note over server: [3] routing.resolveTarget(decoded.replyTo) — routing.ts
    alt NoActiveConversation
        server-->>mcp: toolErrorResult("no active conversation...")
    else ReplyToUnknown
        server-->>mcp: toolErrorResult("reply_to does not match...")
    end

    note over server: Resolved { conversationId }

    server->>entry: [4] deps.sendReply(conversationId, text)
    note over entry: makeSendReply: core.sendReply(conv, text)
    entry->>client: MoltZap WS RPC — messages/send with lease

    alt [5a] RpcServerError { data.reason: "LeaseInvalid" }
        note over entry: projectLeaseInvalid → LeaseAlreadyConsumed
        client-->>entry: LeaseAlreadyConsumed
    else [5b] other error
        client-->>entry: SendFailed
    end

    entry-->>server: ReplyError | void

    alt [6] LeaseAlreadyConsumed
        server-->>mcp: toolErrorResult("LeaseAlreadyConsumed: ...")
    else SendFailed
        server-->>mcp: toolErrorResult("send failed: &lt;cause&gt;")
    else Success
        server-->>mcp: toolOkResult("Reply sent to &lt;conversationId&gt;.")
    end

    mcp-->>Claude: CallToolResult — { content:[{ type:"text", text:"..." }], isError?:true }
```

ReplyError union (in errors.ts):
  LeaseAlreadyConsumed — server returned LeaseInvalid for a consumed lease
  SendFailed           — WS RPC call rejected for any other reason
  NoActiveConversation — no inbound observed yet (routing state empty)
  ReplyToUnknown       — reply_to given but not in LRU map
  FilesUnsupported     — files[] non-empty (v1 not implemented)

---

See also:
- [Lease State Machine](04-lease-state-machine.md)
- [Inbound Message → Claude Push](02-inbound-message-to-claude-push.md)
- [Boot Sequence](01-boot-sequence.md)
