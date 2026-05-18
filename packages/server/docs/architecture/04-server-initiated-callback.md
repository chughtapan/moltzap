# Server-Initiated Callback (the `dispatch/authorize` path)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

When an inbound `messages/send` needs admission, `AppHost.runAuthorizeDispatch`
forks a fiber that calls **out** to the moderator. The reverse direction
uses the same `@moltzap/protocol` runtimes — `JsonRpcClient` on the server
side, `JsonRpcServer` on the moderator's client side:

```mermaid
sequenceDiagram
    participant Recv as Recipient (client)
    participant MH as messages.handlers
    participant MS as MessageService
    participant AH as AppHost.runAuthorizeDispatch<br/>(app/app-host.ts)
    participant Mod as Moderator (client)
    participant LR as LeaseRegistry

    Recv->>MH: inbound message
    MH->>MS: MessageService.send
    MS->>AH: runAuthorizeDispatch<br/>(or runMessageAuthorize for #560 path)

    alt inProcess hook registered
        AH->>AH: runInProcessHookEffect<br/>(handler runs in-process)
    else remote registration found
        AH->>AH: runRemoteHookEffect<br/>(dispatch over WS)
        Note over AH: remote = remoteRegistrations.get(appId)<br/>conn = connections.get(remote.connectionId)
        AH->>Mod: conn.jsonRpcClient.call(DispatchAuthorize, params)<br/>pending["server-N"] = Deferred → write frame<br/>(per-connection client minted at acquireConnectionRpcClient time)
        Note over Mod: decodeServerInbound → ServerRequest<br/>client-side JsonRpcServer.handle<br/>taskCallbackHandlers["dispatch/authorize"]<br/>moderator app code → verdict
        Mod-->>AH: response frame<br/>conn.jsonRpcClient.resolve(frame) settles Deferred<br/>envelope.admission unpacks {decision: grant|deny|hold}
    else neither
        AH->>AH: Effect.succeed({decision: "grant"})
    end

    Note over AH: wrapHookEffectWithEnvelope (fail-CLOSED per architect plan §3.4):<br/>timeout → {decision: "deny", reason: "timeout"}<br/>RPC error → {decision: "deny", reason: "dispatch/authorize error"}

    AH->>LR: leaseRegistry.resolve(leaseId, verdict)
    alt deny
        LR-->>AH: DENIED
        AH->>MS: ConversationService.removeParticipant
    else grant
        LR-->>AH: GRANTED
    end
    AH->>Recv: emit dispatch/release{verdict}
```

The same shape applies to `runMessageAuthorize` (#560) — it's the second
caller of the unified `wrapHookEffectWithEnvelope` (`app/app-host.ts → runMessageAuthorize`),
keyed by `EndpointAddress` instead of `appId`, with verdicts in the
Forward/Block shape instead of grant/deny/hold.

## See also

- [§05 AppHost hook unification](./05-app-host-hook-unification.md) — `wrapHookEffectWithEnvelope` and the registry shape
- [§06 Lease lifecycle](./06-lease-lifecycle.md) — `leaseRegistry.resolve` state transitions
- [§03 Request → response handling](./03-request-response-handling.md) — `handleResponseFrame` that settles the Deferred
