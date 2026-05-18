# Service Layer Composition (boot graph)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`createCoreApp` builds the full service graph via Effect Layers, composed
bottom-up. Each tier's outputs feed the next tier's inputs through
`Layer.provideMerge` (which keeps lower-tier Tags visible to the rest of
the graph, vs `Layer.provide` which would consume them):

```text
                          createCoreApp(config)                  app/server.ts → createCoreApp
                                   │
                                   ▼
                   BaseLive = Layer.mergeAll(
                     Layer.succeed(DbTag, db),
                     Layer.succeed(EncryptionTag, envelope),
                     Layer.succeed(SessionValidatorTag, sv),
                     Layer.succeed(WebhookClientTag, http),
                     Layer.succeed(DeliveryWebhookTag, cfg),
                     config.traceCaptureLayer ?? NoopTraceCaptureLive,
                   )                                              app/server.ts → createCoreApp (BaseLive block)
                                   │
   ┌───────────────────────────────┴───────────────────────────────┐
   ▼                                                               │
ServicesLive = Tier6 (provideMerge composition):                   │ app/layers.ts → Tier 1-6 composition
                                                                   │
   Tier1                                                           │
   ├─ ConnectionManagerLive                                        │
   ├─ AuthServiceLive          (needs Db)                          │
   ├─ ParticipantServiceLive   (needs Db)                          │
   └─ ContactsServiceLive      (needs Db)                          │
       │                                                           │
       ▼ provideMerge into                                         │
   Tier2                                                           │
   ├─ PresenceServiceLive          (needs ConnectionManager)       │
   ├─ AgentEndpointResolverLive    (no deps; Ref<HashMap>)         │
   └─ AppTmRegistryLive            (seeds default-DM/group TMs)    │
       │                                                           │
       ▼ provideMerge into                                         │
   Tier2.5                                                         │
   └─ NetworkSendServiceLive       (needs Resolver + Connections   │
                                         + AppTmRegistry)          │
       │                                                           │
       ▼ provideMerge into                                         │
   Tier2.6                                                         │
   └─ LeaseRegistryLive            (needs ConnectionManager)       │
       │                                                           │
       ▼ provideMerge into                                         │
   Tier3                                                           │
   └─ AppHostLive                  (needs Db + Connections +       │
                                       LeaseRegistry)              │
                                    side-effect: registers default │
                                    messageAuthorize hooks for     │
                                    DEFAULT_DM/GROUP_TM_ADDRESS    │
       │                                                           │
       ▼ provideMerge into                                         │
   Tier4                                                           │
   └─ ConversationServiceLive      (needs Db + Participants +      │
                                        Connections + AppHost)     │
                                    (AppHost.contactService        │
                                     captured lazily — post-       │
                                     construction wire via         │
                                     setContactService)            │
       │                                                           │
       ▼ provideMerge into                                         │
   Tier5                                                           │
   └─ MessageServiceLive           (needs every upstream +         │
                                       Encryption + DeliveryWebhook│
                                       + Webhook + TraceCapture    │
                                       + AppHost)                  │
       │                                                           │
       ▼ provideMerge into                                         │
   Tier6                                                           │
   └─ TaskServiceLive              (needs Db + Conversation +      │
                                       Message)                    │
       │                                                           │
       └────────────────────────────────────┐                      │
                                            ▼                      │
                       ServicesWithBase = Layer.provideMerge(  ────┘
                         ServicesLive, BaseLive)               app/server.ts → createCoreApp (ServicesWithBase)

                                   │
                                   ▼
                   WireConvIntoAppHost = Layer.effectDiscard(...)  app/server.ts → createCoreApp (WireConvIntoAppHost)
                   │  post-construction: appHost.setConversationService(conv)
                   │  — required because AppHost has a backref into ConversationService
                   │    for the dispatch-deny path (removeParticipant) but
                   │    ConversationService is built ABOVE AppHost in the tier order.
                   ▼
                   FullLive = Layer.provideMerge(
                     WireConvIntoAppHost, ServicesWithBase)        app/server.ts → createCoreApp (FullLive)

                                   │
                                   ▼
                   dispatchRuntime = ManagedRuntime.make(
                     Layer.mergeAll(NodeHttpServer.layerContext, FullLive)
                   )                                               app/server.ts → createCoreApp (dispatchRuntime)
                                   │
                                   ▼
                   services = dispatchRuntime.runSync(resolveServices)
                               ↑                                   app/server.ts → createCoreApp (resolveServices)
                               │  resolveServices = Effect.all({tag…})
                               │  produces a plain-object view for non-Effect call sites
                               │
                   ┌───────────┴────────────────────────────────────┐
                   │  Returned CoreApp exposes:                     │
                   │    • port                                      │
                   │    • registerRpcMethod  (push onto methods[])  │
                   │    • onConnection / onDisconnection (hooks)    │
                   │    • registerApp / registerRemoteApp           │
                   │    • registerMessageAuthorize / onTaskAuth…    │
                   │    • setContactService                         │
                   │    • networkSendService, traceCapture, leases  │
                   │    • close()                                   │
                   └────────────────────────────────────────────────┘
```

The `Layer.provideMerge` discipline (vs `Layer.provide`) is load-bearing:
every downstream tier sees ALL upstream Tags in its R-channel resolution,
not just the immediately-above tier. That lets RPC handler bodies pull any
service via `yield* XServiceTag` and have it resolved structurally by the
shared `dispatchRuntime` — no per-frame `Effect.provide`.

## See also

- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md)
- [§06 Lease lifecycle](./06-lease-lifecycle.md)
- [§09 Shutdown sequence](./09-shutdown-sequence.md)
