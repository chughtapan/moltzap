# Server-Initiated Callback (the `dispatch/authorize` path)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

When an inbound `messages/send` needs admission, `AppHost.runAuthorizeDispatch`
forks a fiber that calls **out** to the moderator. The reverse direction
uses the same `@moltzap/protocol` runtimes — `Originator` on the server
side, the typed `Connection.handle` on the moderator's client side.

Server-to-client request frames are restricted to `taskCallbackMethods`
(the strict subset of `rpcMethods` the server is allowed to call back
into the client — `DispatchAuthorize`, `MessagesAuthorize`). The client's
`decodeServerInbound` rejects any other method as `MalformedFrameError`,
so a misconfigured server can't smuggle a non-callback request through
the client's inbound path. The originator lifecycle that backs the
`conn.originator.call(...)` step here is the same one used by inbound
requests — see [Request → response handling](./request-response-handling.md)
for the pending-map mechanics, id-prefix, and finalizer ordering.

```mermaid
sequenceDiagram
    participant Recv as Recipient (client)
    participant MH as messages.handlers
    participant MS as MessageService
    participant AH as AppHost.runAuthorizeDispatch
    participant Mod as Moderator (client)
    participant LR as LeaseRegistry

    Recv->>MH: inbound message
    MH->>MS: MessageService.send
    MS->>AH: runAuthorizeDispatch<br>(or runMessageAuthorize for the address-keyed authorize path)

    alt inProcess hook registered
        AH->>AH: runInProcessHookEffect<br>(handler runs in-process)
    else remote registration found
        AH->>AH: runRemoteHookEffect<br>(dispatch over WS)
        Note over AH: remote = remoteRegistrations.get(appId)<br>conn = connections.get(remote.connectionId)
        AH->>Mod: conn.originator.call(DispatchAuthorize, params)<br>pending["server-N"] = Deferred → write frame<br>(per-connection client minted at acquireConnectionRpcClient time)
        Note over Mod: decodeServerInbound → ServerRequest<br>client-side TypedDispatcher.handle<br>taskCallbackHandlers["dispatch/authorize"]<br>moderator app code → verdict
        Mod-->>AH: response frame<br>conn.originator.resolve(frame) settles Deferred<br>envelope.admission unpacks {decision: grant|deny|hold}
    else neither
        AH->>AH: Effect.succeed({decision: "grant"})
    end

    Note over AH: wrapHookEffectWithEnvelope (fail-CLOSED):<br>timeout → {decision: "deny", reason: "timeout"}<br>RPC error → {decision: "deny", reason: "dispatch/authorize error"}

    AH->>LR: leaseRegistry.resolve(leaseId, verdict)
    alt deny
        LR-->>AH: DENIED
        AH->>MS: ConversationService.removeParticipant
    else grant
        LR-->>AH: GRANTED
    end
    AH->>Recv: emit dispatch/release{verdict}
```

The same shape applies to `runMessageAuthorize` — second caller of the
unified `wrapHookEffectWithEnvelope` in `app/app-host.ts`, keyed by
`appId` with verdicts in the Forward/Block shape instead of
grant/deny/hold.

## See also

- [Request → response handling](./request-response-handling.md) — wire-side wrapper, dispatcher contract, originator lifecycle
- [AppHost hook unification](./app-host-hook-unification.md) — `wrapHookEffectWithEnvelope` and the registry shape
- [Lease lifecycle](./lease-lifecycle.md) — `leaseRegistry.resolve` state transitions
