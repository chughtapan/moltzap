# transport/

Wire-level dispatch.

- WS connection lifecycle (`connection.ts`).
- JSON-RPC method binding (`context.ts`, `define-layered-method.ts`).
- Per-request `DispatchContext` and the layer-scope tags that gate handler placement.
- Per-layer Tag allowlist hierarchy (`layer-tags.ts`).

## Layer-tag hierarchy

```mermaid
flowchart LR
  T["TransportTags<br>ConnId, Db, Encryption, HttpClient, …"]
  I["IdentityTags<br>+ Auth, ParticipantSvc"]
  N["NetworkTags<br>+ Presence, ResolverSvc, NetworkSend, ContactsSvc"]
  K["TaskTags<br>+ Message, Conv, TaskSvc"]
  A["AppTags<br>+ AppHost, LeaseRegistry"]

  T -->|"subset of"| I -->|"subset of"| N -->|"subset of"| K -->|"subset of"| A
```

A handler bound at the `task` layer can pull `MessageService`,
`ConversationService`, plus everything from network/identity/transport
— but NOT `AppHost`. This matches the protocol layer DAG; an RPC that
is notionally a "task" method cannot pull `AppHost`. The `R` channel
of the handler's `Effect` is the enforcement mechanism —
`Exclude<AppTags, ConnIdTag>` on the dispatcher leaves `ConnIdTag`
unresolved until the per-request `Effect.provide` at handler-invocation
time.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels only (`db`, `crypto`, `runtime`, `runtime-surface`, `config`, `test-utils`) |
| Imports TO   | identity, network, task, app (any protocol layer composes on top) |

Transport is the lowest protocol layer. It does not know about identity, conversations, presence, or app hosts. Handlers live in their layer's `handlers/` directory and are bound via `defineXMethod` from this layer.

## Files

- `connection.ts` — WS connection manager + per-connection RPC client.
- `context.ts` — `defineMethod`, `RpcMethodBinding`, `AuthenticatedContext`, `DispatchContext`. The base wrapper; provides `ConnectionTag` from the per-request `DispatchContext`.
- `define-layered-method.ts` — `defineNetworkMethod`, `defineTaskMethod`, `defineAppMethod`. Layer-specific wrappers that constrain handler R-channel to a per-layer Tag allowlist and provide the matching layer-scope service.
- `layer-scopes.ts` — runtime `Context.Tag`s used as structural layer markers (`NetworkLayerScope`, `TaskLayerScope`, `AppLayerScope`).
- `layer-tags.ts` — type-only allowlist hierarchy (`TransportTags`, `IdentityTags`, `NetworkTags`, `TaskTags`, `AppTags`).
- `layer-boundary.types-check.ts` — compile-time test that exercises the constraint shape.

## Maintenance contract

Adding a new service `Context.Tag` is a TWO-step edit, both landing in the same PR:

1. **Type-side:** add the Tag's symbol to the appropriate alias in `layer-tags.ts`.
2. **Structural-side:** update the matching `architectureOptions.layers` rule in the root `eslint.config.js` so the directory-structure lint and the type-system constraint agree.

Both sources of truth coexist by user authorization. Compatibility:

| Forgot type-side | Forgot lint-side |
|---|---|
| `tsc` rejects handler that yields the new Tag if it's outside the layer's allowlist | `tsc` lets the cross-layer reach through; `eslint` flags the directory boundary at the next CI run |

The two checks fire at different boundaries (yield-site vs import-site) and together produce a sound result. Drift between them is a code smell that PR review catches; codegen between them is rejected (user explicitly accepted the maintenance overhead in 2026-05-09 plan revision).

## Dispatch model

Per-request handler R-channel resolution:

```
RpcMethodBinding.handle  (call site: conn.originator.handle(frame, ctx) per Spec F #617 §6 FRI)
        │
        │ ConnectionTag      ── provided by defineMethod from ctx.connId
        │ NetworkLayerScope, TaskLayerScope, AppLayerScope
        │                ── provided by defineXMethod wrappers, structurally
        │ MessageServiceTag, ConversationServiceTag, ...
        │                ── provided by the dispatcher's ManagedRuntime
        │                   (Layer.mergeAll(NodeHttpServer.layerContext, FullLive))
        ▼
   handler body
```

The wrapper-provided tags are no-ops for handlers that don't yield them; `Effect.provideService(Tag, value)` is `Exclude<R, Tag>` in the type system, so providing a tag the body never reads costs nothing.

## Type-alias scaffold

Three pieces:

1. **Tag hierarchy** in `layer-tags.ts`. Every Tag yielded by a post-DI-migration handler is placed at the lowest layer that yields it.
2. **Wrapper signatures** in `context.ts` and `define-layered-method.ts` widen with `Reqs` generics. `Reqs extends NetworkTags = NetworkTags` (and parallel for Task/App) — defaulted to the upper bound so handlers without per-Tag yields still compile; constrained so a handler that yields a higher-tier Tag is rejected at the call site.
3. **Protocol-side widening** in `@moltzap/protocol/transport/{handlers,dispatch}.ts`: `RpcHandler<Ctx, R = never>` and the per-kind `*Handlers` table types carry the R-channel structurally. The dispatcher's `ManagedRuntime` resolves R at request time.
