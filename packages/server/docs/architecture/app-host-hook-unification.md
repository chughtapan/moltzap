# AppHost Hook Unification

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `Hook<TContext, TResult>` abstraction (`app/hooks.ts`) lets every
"send context, get verdict" S→C interaction use the same registry +
resolution + envelope shape:

```mermaid
flowchart TD
    Hook["Hook&lt;TContext, TResult&gt;<br/>(app/hooks.ts)"]

    Hook --> RegA["appId-keyed registry<br/>hooks: Map&lt;AppId, AppHooks&gt;<br/>AppHooks = { taskAuthorizeDispatch? }<br/>(one slot today; future hook slots<br/>(close, contactPolicy, invalidContacts)<br/>are not implemented — see app/hooks.ts)"]

    Hook --> RegB["EndpointAddress-keyed registry<br/>messageAuthorizeHooks:<br/>Map&lt;EndpointAddress, MessageAuthorizeHook&gt;<br/>seeded at boot for<br/>DEFAULT_DM_TM_ADDRESS,<br/>DEFAULT_GROUP_TM_ADDRESS<br/>via AppHostLive Effect.gen<br/>(app/layers.ts)"]

    RegA --> Remote["remoteRegistrations: Map&lt;AppId, {connectionId}&gt;<br/>(apps/register success → AppHost.registerRemoteApp)"]
    RegB --> Remote

    Remote --> Resolve["Three-step resolution (each hook runner)"]

    Resolve --> Step1{"1. lookup in-process registry<br/>by primary key"}
    Step1 -->|"found"| IP["runInProcessHookEffect(hook, ctx)"]
    Step1 -->|"not found"| Step2{"2. derive remote key (appId),<br/>look up remoteRegistrations"}
    Step2 -->|"found"| RP["runRemoteHookEffect({appId, definition,<br/>connectionId, params})"]
    Step2 -->|"not found"| Step3["3. synthetic default<br/>messageAuthorize: Forward {recipients: participants\\sender}<br/>authorizeDispatch: {decision: 'grant'}"]

    IP --> Envelope["wrapHookEffectWithEnvelope({<br/>raw, timeoutMs, onTimeout, onError, log contexts<br/>})"]
    RP --> Envelope
    Step3 --> Envelope

    Envelope --> FailClosed["ALL paths fail-CLOSED:<br/>timeout / handler throw / RPC failure / decode failure<br/>collapse to onTimeout() / onError()<br/>(e.g. messageAuthorize: Block{reason: 'tm_unreachable'})"]
```

## See also

- [Server-initiated callback](./server-initiated-callback.md) — `dispatchAuthorizeHook` and `runMessageAuthorize` as the two callers of `wrapHookEffectWithEnvelope`
- [Lease lifecycle](./lease-lifecycle.md) — what happens after a verdict is delivered
