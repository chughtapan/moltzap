# Boot Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`bootClaudeCodeChannel` is the single public entry point (in `entry.ts`).
In production the CLI binary (`cli.ts`) calls it; in tests `echo.integration.test.ts`
calls it directly with an injected in-memory MCP transport. The
`@moltzap/runtimes` adapter (`runtimes/src/claude-code-process.ts`) writes
an `mcp-config.json` and then Claude Code itself spawns the binary as a
subprocess — that spawning step happens outside this package.

```mermaid
sequenceDiagram
    participant Caller
    participant entry as entry.ts
    participant server as server.ts
    participant client as @moltzap/client

    Caller->>entry: bootClaudeCodeChannel(opts: BootOptions)

    note over entry: [1] validateBootOptions
    alt agentKey empty / serverUrl empty
        entry-->>Caller: BootResult { _tag:"Err", error: AgentKeyInvalid }
    end

    entry->>client: [2] new MoltZapService({ serverUrl, agentKey })
    entry->>client: [3] new MoltZapChannelCore({ service })

    note over entry: [4] createRoutingState() — in routing.ts
    note over entry: [5] makeSendReply(core) — in entry.ts

    entry->>server: [6] bootChannelMcpServer(config, deps)

    note over server: [6a] makeMcpServer(config)<br/>capabilities: { tools: {}, experimental: { "claude/channel": {} } }<br/>instructions: &lt;contract default&gt;

    note over server: [6b] registerServerHandlers<br/>setRequestHandler(ListTools)<br/>setRequestHandler(CallTool)
    alt [6b-fail] ToolRegistrationFailed
        server-->>Caller: BootResult { _tag:"Err" } (McpTransportFailed)
    end

    note over server: [6c] connectServer(server, deps)<br/>transportFactory? (test seam, in types.ts)<br/>: new StdioServerTransport()<br/>server.connect(transport)
    alt [6c-fail] StdioConnectFailed
        server-->>Caller: BootResult { _tag:"Err" } (McpTransportFailed)
    end

    note over server: [6d] server.oninitialized = markServerInitialized<br/>(flushes pending[] buffer on MCP handshake completion)

    server-->>entry: [6e] ServerHandle { push, stop }

    note over entry: [7] core.onInbound(handler)<br/>registers handleInboundMessage callback

    entry->>client: [8] connectCore(core, serverHandle)<br/>core.connect() — WS auth handshake
    alt [8-fail] ServiceRpcError / connect failure
        note over entry: serverHandle.stop() called first
        entry-->>Caller: BootResult { _tag:"Err" }
    end

    note over entry: [9] makeHandle(core, serverHandle)<br/>returns Handle { push, stop }
    entry-->>Caller: BootResult { _tag:"Ok", value: Handle }
```

BootError union (in errors.ts):
  AgentKeyInvalid     — opts.agentKey or opts.serverUrl blank   (step 1)
  McpTransportFailed  — server init / stdio connect rejected     (step 6)
  ServiceRpcError     — WS connect / auth rejected               (step 8)
  SchemaDecodeFailed  — reserved (not yet reachable in v1)

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
