# Claude Reply → MoltZap Outbound

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Claude invokes the `reply` MCP tool. The MCP SDK deserializes the
JSON-RPC call and hands it to the registered `CallTool` handler.

```text
Claude Code     MCP SDK (stdio)      server.ts             entry.ts       @moltzap/client
     |                 |                 |                     |                  |
     | tool call JSON  |                 |                     |                  |
     | { name:"reply", |                 |                     |                  |
     |   arguments:{   |                 |                     |                  |
     |     text: "...",|                 |                     |                  |
     |     reply_to?:  |                 |                     |                  |
     |     "msg-id"    |                 |                     |                  |
     |   }             |                 |                     |                  |
     | }               |                 |                     |                  |
     |---------------->|                 |                     |                  |
     |                 | CallToolRequest |                     |                  |
     |                 |---------------->|                     |                  |
     |                 |            handleCallToolRequest      |                  |
     |                 |            (in server.ts)            |                  |
     |                 |                 |                     |                  |
     |                 |            [1] name == "reply"?       |                  |
     |                 |            NO: toolErrorResult("unknown tool: ...")     |
     |                 |                 |                     |                  |
     |                 |            YES: decodeReplyArgs(request.params.arguments)
     |                 |            (in server.ts)            |                  |
     |                 |                 |                     |                  |
     |                 |            arguments not object / text missing or blank |
     |                 |            --> toolErrorResult(ReplyArgsInvalid.reason) |
     |                 |                 |                     |                  |
     |                 |            handleDecodedReplyCall(decoded, deps)        |
     |                 |            (in server.ts)            |                  |
     |                 |                 |                     |                  |
     |                 |            [2] decoded.files non-empty?                 |
     |                 |            YES: filesUnsupportedResult (v1 limitation)  |
     |                 |                 |                     |                  |
     |                 |            [3] routing.resolveTarget(decoded.replyTo)   |
     |                 |            (in routing.ts)           |                  |
     |                 |                 |                     |                  |
     |                 |            NoActiveConversation:      |                  |
     |                 |            toolErrorResult("no active conversation...") |
     |                 |                 |                     |                  |
     |                 |            ReplyToUnknown:            |                  |
     |                 |            toolErrorResult("reply_to does not match...") |
     |                 |                 |                     |                  |
     |                 |            Resolved { conversationId }|                  |
     |                 |                 |                     |                  |
     |                 |            [4] deps.sendReply(conversationId, text)     |
     |                 |                 |-------------------->|                  |
     |                 |                 |                     |                  |
     |                 |                 |              makeSendReply:            |
     |                 |                 |              core.sendReply(conv, text)|
     |                 |                 |                     |----------------->|
     |                 |                 |                     |                  |
     |                 |                 |                     |   MoltZap WS RPC |
     |                 |                 |                     |   messages/send  |
     |                 |                 |                     |   with lease     |
     |                 |                 |                     |                  |
     |                 |                 |                     | [5a] RpcServerError
     |                 |                 |                     | data.reason ==   |
     |                 |                 |                     | "LeaseInvalid"   |
     |                 |                 |                     | projectLeaseInvalid
     |                 |                 |                     | --> LeaseAlreadyConsumed
     |                 |                 |                     | (in entry.ts)    |
     |                 |                 |                     |                  |
     |                 |                 |                     | [5b] other error |
     |                 |                 |                     | --> SendFailed   |
     |                 |                 |<--------------------|                  |
     |                 |                 |                     |                  |
     |                 |            [6] ReplyError?            |                  |
     |                 |            LeaseAlreadyConsumed:      |                  |
     |                 |            toolErrorResult("LeaseAlreadyConsumed: ...")  |
     |                 |            (in server.ts)            |                  |
     |                 |                 |                     |                  |
     |                 |            SendFailed:                |                  |
     |                 |            toolErrorResult("send failed: <cause>")       |
     |                 |                 |                     |                  |
     |                 |            Success:                   |                  |
     |                 |            toolOkResult("Reply sent to <conversationId>.")|
     |                 |                 |                     |                  |
     |                 | CallToolResult  |                     |                  |
     |                 |<----------------|                     |                  |
     | tool result JSON|                 |                     |                  |
     |<----------------|                 |                     |                  |
     |  { content:[{   |                 |                     |                  |
     |      type:"text"|                 |                     |                  |
     |      text:"..."                   |                     |                  |
     |    }],          |                 |                     |                  |
     |    isError?:true|                 |                     |                  |
     |  }              |                 |                     |                  |

ReplyError union (in errors.ts):
  LeaseAlreadyConsumed — server returned LeaseInvalid for a consumed lease
  SendFailed           — WS RPC call rejected for any other reason
  NoActiveConversation — no inbound observed yet (routing state empty)
  ReplyToUnknown       — reply_to given but not in LRU map
  FilesUnsupported     — files[] non-empty (v1 not implemented)
```

---

See also:
- [Lease State Machine](04-lease-state-machine.md)
- [Inbound Message → Claude Push](02-inbound-message-to-claude-push.md)
- [Boot Sequence](01-boot-sequence.md)
