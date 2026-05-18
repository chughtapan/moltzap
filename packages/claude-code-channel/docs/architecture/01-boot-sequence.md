# Boot Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`bootClaudeCodeChannel` is the single public entry point (in `entry.ts`).
In production the CLI binary (`cli.ts`) calls it; in tests `echo.integration.test.ts`
calls it directly with an injected in-memory MCP transport. The
`@moltzap/runtimes` adapter (`runtimes/src/claude-code-process.ts`) writes
an `mcp-config.json` and then Claude Code itself spawns the binary as a
subprocess — that spawning step happens outside this package.

```text
Caller                   entry.ts                   server.ts           @moltzap/client
  |                          |                           |                     |
  |  bootClaudeCodeChannel   |                           |                     |
  |  (opts: BootOptions)     |                           |                     |
  |------------------------->|                           |                     |
  |                          |                           |                     |
  |              [1] validateBootOptions                 |                     |
  |                          |                           |                     |
  |                          | agentKey empty / serverUrl empty                |
  |                          |---> BootResult { _tag:"Err",                   |
  |                          |      error: AgentKeyInvalid }                  |
  |                          |                           |                     |
  |                          | [2] new MoltZapService({serverUrl, agentKey})  |
  |                          |-------------------------------------------->   |
  |                          | [3] new MoltZapChannelCore({ service })         |
  |                          |-------------------------------------------->   |
  |                          |                           |                     |
  |                          | [4] createRoutingState()  |                     |
  |                          | (in routing.ts)           |                     |
  |                          |                           |                     |
  |                          | [5] makeSendReply(core)   |                     |
  |                          | (in entry.ts)             |                     |
  |                          |                           |                     |
  |                          | [6] bootChannelMcpServer  |                     |
  |                          |    (config, deps)         |                     |
  |                          |-------------------------->|                     |
  |                          |                           |                     |
  |                          |              [6a] makeMcpServer(config)        |
  |                          |              in server.ts                      |
  |                          |              capabilities: { tools: {},        |
  |                          |                experimental:                   |
  |                          |                 { "claude/channel": {} } }     |
  |                          |              instructions: <contract default>  |
  |                          |                           |                     |
  |                          |              [6b] registerServerHandlers       |
  |                          |              in server.ts                      |
  |                          |              setRequestHandler(ListTools)      |
  |                          |              setRequestHandler(CallTool)       |
  |                          |                           |                     |
  |                          |              [6b-fail] ToolRegistrationFailed  |
  |                          |              (entry maps to McpTransportFailed)|
  |                          |              --> BootResult { _tag:"Err" }     |
  |                          |                           |                     |
  |                          |              [6c] connectServer(server, deps)  |
  |                          |              in server.ts                      |
  |                          |              transportFactory?                 |
  |                          |              (test seam, in types.ts)         |
  |                          |              : new StdioServerTransport()      |
  |                          |              server.connect(transport)          |
  |                          |                           |                     |
  |                          |              [6c-fail] StdioConnectFailed      |
  |                          |              (entry maps to McpTransportFailed)|
  |                          |              --> BootResult { _tag:"Err" }     |
  |                          |                           |                     |
  |                          |              [6d] server.oninitialized =       |
  |                          |              markServerInitialized             |
  |                          |              in server.ts                      |
  |                          |              (flushes pending[] buffer on      |
  |                          |               MCP handshake completion)        |
  |                          |                           |                     |
  |                          |              [6e] return ServerHandle          |
  |                          |              { push, stop }                    |
  |                          |<--------------------------|                     |
  |                          |                           |                     |
  |                          | [7] core.onInbound(handler)                    |
  |                          | registers handleInboundMessage callback        |
  |                          | in entry.ts                                    |
  |                          |                           |                     |
  |                          | [8] connectCore(core, serverHandle)            |
  |                          | core.connect() — WS auth handshake             |
  |                          |-------------------------------------------->   |
  |                          |                           |                     |
  |                          | [8-fail] ServiceRpcError / connect failure     |
  |                          | serverHandle.stop() is called first            |
  |                          | --> BootResult { _tag:"Err" }                  |
  |                          |                           |                     |
  |                          | [9] makeHandle(core, serverHandle)             |
  |                          | in entry.ts                                    |
  |                          | returns Handle { push, stop }                  |
  |                          |                           |                     |
  |<-------------------------|                           |                     |
     BootResult { _tag:"Ok",
       value: Handle }

BootError union (in errors.ts):
  AgentKeyInvalid     — opts.agentKey or opts.serverUrl blank   (step 1)
  McpTransportFailed  — server init / stdio connect rejected     (step 6)
  ServiceRpcError     — WS connect / auth rejected               (step 8)
  SchemaDecodeFailed  — reserved (not yet reachable in v1)
```

**Foreign-protocol bridge point**: step 6c is where the MCP stdio transport
attaches. From this moment onward the process owns two concurrent channels:
the MCP stdio stream (outbound to Claude) and the MoltZap WS connection
(inbound from server). They meet only inside the inbound handler
([§ Inbound Message → Claude Push](02-inbound-message-to-claude-push.md))
and the reply tool ([§ Claude Reply → MoltZap Outbound](03-claude-reply-to-moltzap-outbound.md)).

---

See also:
- [Inbound Message → Claude Push](02-inbound-message-to-claude-push.md)
- [Claude Reply → MoltZap Outbound](03-claude-reply-to-moltzap-outbound.md)
- [Shutdown](06-shutdown.md)
