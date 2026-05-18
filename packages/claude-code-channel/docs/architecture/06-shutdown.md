# Shutdown

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Shutdown is initiated either by `Handle.stop()` (caller-driven) or by
the OS delivering SIGTERM to the CLI process.

```text
Caller / OS                 entry.ts                 server.ts      @moltzap/client
     |                          |                        |                |
     |  Handle.stop()           |                        |                |
     |  (in entry.ts —          |                        |                |
     |   makeHandle)            |                        |                |
     |------------------------->|                        |                |
     |                          |                        |                |
     |                          | [1] core.disconnect()  |                |
     |                          |------------------------------------->   |
     |                          |        WS close / deregister inbound   |
     |                          |        onInbound callback ceases        |
     |                          |<-------------------------------------   |
     |                          |                        |                |
     |                          | [2] serverHandle.stop()|                |
     |                          |----------------------->|                |
     |                          |                   closeMcpServer(server)|
     |                          |                   in server.ts          |
     |                          |                   server.close()        |
     |                          |                   MCP SDK closes stdio  |
     |                          |                   transport             |
     |                          |                        |                |
     |                          |              close failure swallowed:   |
     |                          |              logMcpCloseFailure         |
     |                          |              in server.ts               |
     |                          |              (spec I8: teardown logs,   |
     |                          |               never propagates)         |
     |                          |<-----------------------|                |
     |                          |                        |                |
     |<-------------------------|                        |                |
        Effect<void> (infallible)

Alternate path — boot-time connect failure (in entry.ts):
  connectCore() fails
  --> serverHandle.stop() called immediately via Effect.tapError
  --> BootResult { _tag:"Err" } returned before Handle is issued
  --> no Handle.stop() ever needed

CLI process SIGTERM path (cli.ts — no explicit signal handler):
  Node.js default SIGTERM kills the process. stdio transport
  closes; MCP SDK cleans up on process exit. The MoltZap WS
  connection closes via OS socket teardown. No explicit
  Handle.stop() is called in the CLI binary's v1 — the server
  observes the WS disconnect and expires the agent's session.

Pending notifications at shutdown:
  If stop() is called while state.initialized == false and
  state.pending[] is non-empty, those notifications are
  never flushed. The buffer is an in-process [] with no
  persistence. This is acceptable because the MCP client
  (Claude Code) is closing alongside the server.

Lease state at shutdown:
  The local LRU map (routing.ts) is garbage-collected with
  the process. No persistence. Server-side leases expire
  independently per the MoltZap server's dispatch TTL.
```

---

See also:
- [Boot Sequence](01-boot-sequence.md)
- [Lease State Machine](04-lease-state-machine.md)
