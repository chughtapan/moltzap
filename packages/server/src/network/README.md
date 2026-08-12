# network/

Connect handlers, agent-endpoint resolution, and typed reverse-RPC
notification fan-out.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | db, core, socket, identity |
| Imports TO   | conversation, message |

## Files

- `agent-endpoint-resolver.ts` — `AgentId → HashSet<ConnId>` multimap
  kept fresh by `agent/network/connect` success and the disconnect
  finalizer.
- `connect.handlers.ts` — the agent connect RPC handler.
- `network-send.ts` — `NetworkSendService` notification fan-out over the
  resolver and connection manager.

## Handler shape

```ts
export const connectAgent: ServerHandler<typeof agentConnect> = (params) =>
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    // ...
  });
```

No deps argument. Tags are resolved by the socket runtime.
