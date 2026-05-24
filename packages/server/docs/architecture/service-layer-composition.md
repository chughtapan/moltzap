# Service Layer Composition (boot graph)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`createCoreApp` builds the full service graph via Effect Layers, composed
bottom-up. Each tier's outputs feed the next tier's inputs through
`Layer.provideMerge` (which keeps lower-tier Tags visible to the rest of
the graph, vs `Layer.provide` which would consume them):

```mermaid
flowchart TD
    createCoreApp["createCoreApp(config)<br/><i>app/server.ts</i>"]

    subgraph BaseLive["BaseLive = Layer.mergeAll(…)"]
        B1["DbTag"]
        B2["EncryptionTag"]
        B3["SessionValidatorTag"]
        B4["WebhookClientTag"]
        B5["DeliveryWebhookTag"]
        B6["TraceCaptureLayer"]
    end

    subgraph ServicesLive["ServicesLive — Tier 1-6 (provideMerge chain) · app/layers.ts"]
        subgraph Tier1["Tier 1"]
            T1A["ConnectionManagerLive"]
            T1B["AuthServiceLive<br/>(needs Db)"]
            T1D["ContactsServiceLive<br/>(needs Db)"]
        end

        subgraph Tier2["Tier 2"]
            T2A["PresenceServiceLive<br/>(needs ConnectionManager)"]
            T2B["AgentEndpointResolverLive<br/>(no deps; Ref&lt;HashMap&gt;)"]
            T2C["AppTmRegistryLive<br/>(seeds default-DM/group TMs)"]
        end

        subgraph Tier25["Tier 2.5"]
            T25["NetworkSendServiceLive<br/>(needs Resolver + Connections + AppTmRegistry)"]
        end

        subgraph Tier26["Tier 2.6"]
            T26["LeaseRegistryLive<br/>(needs ConnectionManager)"]
        end

        subgraph Tier3["Tier 3"]
            T3["AppHostLive<br/>(needs Db + Connections + LeaseRegistry)<br/>side-effect: registers default messageAuthorize hooks<br/>for DEFAULT_DM/GROUP_TM_ADDRESS"]
        end

        subgraph Tier4["Tier 4"]
            T4["ConversationServiceLive<br/>(needs Db + Connections + AppHost)<br/>AppHost.contactService captured lazily —<br/>post-construction wire via setContactService"]
        end

        subgraph Tier5["Tier 5"]
            T5["MessageServiceLive<br/>(needs every upstream +<br/>Encryption + DeliveryWebhook + Webhook + TraceCapture + AppHost)"]
        end

        subgraph Tier6["Tier 6"]
            T6["TaskServiceLive<br/>(needs Db + Conversation + Message)"]
        end

        Tier1 -->|"provideMerge into"| Tier2
        Tier2 -->|"provideMerge into"| Tier25
        Tier25 -->|"provideMerge into"| Tier26
        Tier26 -->|"provideMerge into"| Tier3
        Tier3 -->|"provideMerge into"| Tier4
        Tier4 -->|"provideMerge into"| Tier5
        Tier5 -->|"provideMerge into"| Tier6
    end

    ServicesWithBase["ServicesWithBase =<br/>Layer.provideMerge(ServicesLive, BaseLive)<br/><i>app/server.ts</i>"]

    WireConv["WireConvIntoAppHost = Layer.effectDiscard(…)<br/>post-construction: appHost.setConversationService(conv)<br/>— AppHost has a backref into ConversationService<br/>for dispatch-deny path (removeParticipant)<br/>but ConversationService is built ABOVE AppHost<br/><i>app/server.ts</i>"]

    FullLive["FullLive = Layer.provideMerge(<br/>WireConvIntoAppHost, ServicesWithBase)<br/><i>app/server.ts</i>"]

    dispatchRuntime["dispatchRuntime = ManagedRuntime.make(<br/>Layer.mergeAll(NodeHttpServer.layerContext, FullLive))<br/><i>app/server.ts</i>"]

    resolveServices["services = dispatchRuntime.runSync(resolveServices)<br/>resolveServices = Effect.all({tag…})<br/>produces a plain-object view for non-Effect call sites<br/><i>app/server.ts</i>"]

    CoreApp["Returned CoreApp exposes:<br/>port · onConnection / onDisconnection<br/>registerApp / registerRemoteApp<br/>registerMessageAuthorize / onTaskAuth…<br/>setContactService<br/>networkSendService · traceCapture · leases<br/>close()<br/>(RPC handler table baked at construction;<br/>no post-construction method registration)"]

    createCoreApp --> BaseLive
    createCoreApp --> ServicesLive
    BaseLive --> ServicesWithBase
    ServicesLive --> ServicesWithBase
    ServicesWithBase --> WireConv
    WireConv --> FullLive
    FullLive --> dispatchRuntime
    dispatchRuntime --> resolveServices
    resolveServices --> CoreApp
```

The `Layer.provideMerge` discipline (vs `Layer.provide`) is load-bearing:
every downstream tier sees ALL upstream Tags in its R-channel resolution,
not just the immediately-above tier. That lets RPC handler bodies pull any
service via `yield* XServiceTag` and have it resolved structurally by the
shared `dispatchRuntime` — no per-frame `Effect.provide`.

## Convention: package-private gate methods (Spec E Decision B / Option A)

Each service class exposes a thin SQL gate per privileged operation
— `loadOpenTask`, `loadTaskWithReadAccess`,
`assertConversationInTask`, `assertConversationParticipant`, etc. These
are **NOT** part of the service's exported public surface. They are
`@internal` exported methods (the TS `private` modifier was dropped per
Architect Decision B / Option A — `private` would block the obtain
logic in `app/capability-providers.ts` (and the composite helpers in
`task/services/`) from reaching the underlying check via the service
Tag, regardless of DI path). The JSDoc `@internal` tag is the
package-internal convention; lint enforcement is not currently wired.
See [r-channel-capabilities.md](./r-channel-capabilities.md) for the
capability pattern overview.

Naming convention: gate methods use the `assert*` / `load*` prefix, not
`require*` (Spec E #601 rename — the `require[A-Z]` prefix was reserved
for the deleted pre-Spec-E runtime checks). The audit grep
`packages/server/src/**/*.ts | grep require[A-Z]` returns 0 hits in
services prod code; that gate is the structural invariant Decision B
encodes.

## See also

- [WebSocket connection lifecycle](./ws-connection-lifecycle.md)
- [Lease lifecycle](./lease-lifecycle.md)
- [Shutdown sequence](./shutdown-sequence.md)
- [R-channel capabilities](./r-channel-capabilities.md) — `obtain*` smart constructors that consume the `assert*` / `load*` gates documented above
