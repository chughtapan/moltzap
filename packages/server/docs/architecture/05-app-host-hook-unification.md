# AppHost Hook Unification

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `Hook<TContext, TResult>` abstraction (`app/hooks.ts`) lets every
"send context, get verdict" S→C interaction use the same registry +
resolution + envelope shape:

```text
                  Hook<TContext, TResult>
                        │
   ┌────────────────────┴────────────────────┐
   ▼                                         ▼
appId-keyed registry              EndpointAddress-keyed registry
hooks: Map<AppId, {                messageAuthorizeHooks:
  taskAuthorizeDispatch?,            Map<EndpointAddress, MessageAuthorizeHook>
  onClose?,                                  │
  contactPolicyAllowed?,                    seeded at boot for
  invalidContacts?,                         DEFAULT_DM_TM_ADDRESS,
}>                                          DEFAULT_GROUP_TM_ADDRESS
   │                                      via AppHostLive Effect.gen
   │                                       │ (registers default hooks in `AppHostLive`
   │                                       │  in `app/layers.ts`)
   │  ┌──── remoteRegistrations: Map<AppId, {connectionId}>
   │  │     (apps/register success → AppHost.registerRemoteApp)
   │  │
   │  └────────────┬─────────────────────────┘
                   │
                   ▼ Three-step resolution (each hook runner)
                   │
              1. lookup in-process registry by primary key
                   │  found → runInProcessHookEffect(hook, ctx)
                   │
              2. derive remote key (appId), look up remoteRegistrations
                   │  found → runRemoteHookEffect({appId, definition,
                   │           connectionId, params})
                   │
              3. synthetic default
                   │  messageAuthorize: Forward {recipients: participants\sender}
                   │  authorizeDispatch: {decision: "grant"}
                   │
                   ▼
              wrapHookEffectWithEnvelope({
                raw, timeoutMs, onTimeout, onError, log contexts
              })
                   │
                   └─ ALL paths fail-CLOSED:
                      timeout / handler throw / RPC failure / decode failure
                      collapse to onTimeout()/onError()
                      (e.g. messageAuthorize: Block{reason:"tm_unreachable"})
```

## See also

- [§04 Server-initiated callback](./04-server-initiated-callback.md) — `dispatchAuthorizeHook` and `runMessageAuthorize` as the two callers of `wrapHookEffectWithEnvelope`
- [§06 Lease lifecycle](./06-lease-lifecycle.md) — what happens after a verdict is delivered
