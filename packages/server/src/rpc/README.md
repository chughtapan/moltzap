# rpc/

JSON-RPC method binding plus the per-layer Tag allowlist.

## Files

- `context.ts` — `defineMethod`, `RpcMethodBinding`, `AuthenticatedContext`, `DispatchContext`. The base wrapper; provides `ConnIdTag` from the per-request `DispatchContext`.
- `define-layered-method.ts` — `defineNetworkMethod`, `defineTaskMethod`, `defineAppMethod`. Layer-specific wrappers that constrain handler R-channel to a per-layer Tag allowlist and provide the matching layer-scope service.
- `layer-scopes.ts` — runtime `Context.Tag`s used as structural layer markers (`NetworkLayerScope`, `TaskLayerScope`, `AppLayerScope`).
- `layer-tags.ts` — type-only allowlist hierarchy (`TransportTags`, `IdentityTags`, `NetworkTags`, `TaskTags`, `AppTags`).
- `layer-boundary.types-check.ts` — compile-time test that exercises the constraint shape.

This folder moves to `transport/` in Phase 2A.2; the contract documented here travels with it.

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
RpcMethodBinding.handle  (call site: jsonRpcServer.handle(frame, ctx))
        │
        │ ConnIdTag      ── provided by defineMethod from ctx.connId
        │ NetworkLayerScope, TaskLayerScope, AppLayerScope
        │                ── provided by defineXMethod wrappers, structurally
        │ MessageServiceTag, ConversationServiceTag, ...
        │                ── provided by the dispatcher's ManagedRuntime
        │                   (Layer.mergeAll(NodeHttpServer.layerContext, LoggerLive, FullLive))
        ▼
   handler body
```

The wrapper-provided tags are no-ops for handlers that don't yield them; `Effect.provideService(Tag, value)` is `Exclude<R, Tag>` in the type system, so providing a tag the body never reads costs nothing.

## Type-alias scaffold (added in Phase 2A r2 architect plan)

The Tag hierarchy in `layer-tags.ts` is a stub at the architect stage. The wrapper signatures in `context.ts` and `define-layered-method.ts` widen with `Reqs` generics that default to the layer's full allowlist; this preserves source-compatibility with the pre-2A.0 factory-deps handler shape while opening the door for the migrated `yield* XServiceTag` shape.

The implementation work to (a) migrate every handler off factories, (b) move `RpcHandler<Ctx>.handle` past the R=never assumption, and (c) thread `FullLive` into the dispatch runtime is part of the Phase 2A single-PR landing.
