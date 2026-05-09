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

## Type-alias scaffold (Phase 2A r2)

Three pieces, all already on this branch as of `architect/phase-2a-r2-server-reshape`:

1. **Tag hierarchy** in `layer-tags.ts`. Every Tag yielded by a post-DI-migration handler is placed at the lowest layer that yields it. See plan §3 "Handler audit matrix" for the per-handler audit.
2. **Wrapper signatures** in `context.ts` and `define-layered-method.ts` widen with `Reqs` generics. `Reqs extends NetworkTags = NetworkTags` (and parallel for Task/App) — defaulted to the upper bound so pre-migration handlers (R=never) still compile, constrained so a migrated handler that yields a higher-tier Tag is rejected at the call site.
3. **Protocol-side widening** in `@moltzap/protocol/transport/json-rpc-server.ts`: `RpcHandler<Ctx, R = never>` and `JsonRpcServer<Ctx, R = never>` carry the R-channel structurally. Removes the architect-stage cast that v3 carried at `defineMethod`'s `handler()` call.
4. **Dispatch runtime** in `app/server.ts`: `ManagedRuntime.make(Layer.mergeAll(NodeHttpServer.layerContext, FullLive))` — the request-fiber runtime carries every service Tag in `AppTags`, so handler-body yields resolve at request time.

The implementation work to migrate every handler off factories is part of the Phase 2A single-PR landing (commit 3 in §6 of the plan). The migration removes `createXHandlers({deps})` factories in favor of top-level `xHandlers: RpcMethodRegistry` whose binding bodies `yield* XServiceTag` — the type-system hierarchy is already in place to enforce layer placement structurally.
