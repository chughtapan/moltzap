# Server-Initiated Callback (the `dispatch/authorize` path)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

When an inbound `messages/send` needs admission, `AppHost.runAuthorizeDispatch`
forks a fiber that calls **out** to the moderator. The reverse direction
uses the same `@moltzap/protocol` runtimes — `JsonRpcClient` on the server
side, `JsonRpcServer` on the moderator's client side:

```text
recipient sends inbound message
       │
       ▼  messages.handlers → MessageService.send → AppHost.runAuthorizeDispatch
       │       (or runMessageAuthorize for #560 path)
       │
       ▼  app/app-host.ts → dispatchAuthorizeHook
       │
       ├──── inProcess hook registered  ────▶  runInProcessHookEffect
       │                                          (handler runs in-process)
       │
       ├──── remote registration found  ────▶  runRemoteHookEffect
       │                                          (dispatch over WS)
       │
       └──── neither                     ────▶  Effect.succeed({decision: "grant"})

         remote path:
              │
              ▼  remote = remoteRegistrations.get(appId)
              ▼  conn = connections.get(remote.connectionId)
              ▼  conn.jsonRpcClient.call(DispatchAuthorize, params)
              │                  ↑
              │                  │  per-connection client minted at
              │                  │  acquireConnectionRpcClient time
              │                  │
              │  ── pending["server-N"] = Deferred ─→ write frame
              │                                          │
              │                                          ▼
              │                                       moderator's wire
              │                                          │
              │                                          ▼
              │                              decodeServerInbound → ServerRequest
              │                              client-side JsonRpcServer.handle
              │                              taskCallbackHandlers["dispatch/authorize"]
              │                              moderator app code → verdict
              │                                          │
              │                                          ▼  response frame
              │
              ▼  conn.jsonRpcClient.resolve(frame) settles the Deferred
              ▼  envelope.admission unpacks {decision: grant|deny|hold}
              │
              ▼  wrapHookEffectWithEnvelope:
              │     - timeout (manifest dispatch_authorize.timeout_ms,
              │                default DEFAULT_APP_HOOK_TIMEOUT_MS)
              │     - on timeout → {decision: "deny", reason: "timeout"}
              │     - on RPC error → {decision: "deny", reason: "dispatch/authorize error"}
              │     ── fail-CLOSED per architect plan §3.4
              │
              ▼  back into AppHost.runAuthorizeDispatch
                 ▼  if deny → leaseRegistry.resolve(leaseId, {deny, reason})
                              ConversationService.removeParticipant
                 ▼  if grant → leaseRegistry.resolve(leaseId, {grant})
                 ▼  emit dispatch/release{verdict} → recipient connection
```

The same shape applies to `runMessageAuthorize` (#560) — it's the second
caller of the unified `wrapHookEffectWithEnvelope` (`app/app-host.ts → runMessageAuthorize`),
keyed by `EndpointAddress` instead of `appId`, with verdicts in the
Forward/Block shape instead of grant/deny/hold.

## See also

- [§05 AppHost hook unification](./05-app-host-hook-unification.md) — `wrapHookEffectWithEnvelope` and the registry shape
- [§06 Lease lifecycle](./06-lease-lifecycle.md) — `leaseRegistry.resolve` state transitions
- [§03 Request → response handling](./03-request-response-handling.md) — `handleResponseFrame` that settles the Deferred
