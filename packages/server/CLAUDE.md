# @moltzap/server

Server package — extends the workspace-root `/home/tapanc/moltzap/CLAUDE.md`
(architecture-doc rules, LSP-first tracing, symbol-name citations,
Mermaid gotchas all inherited).

## Architecture entry points

- **`ARCHITECTURE.md`** — package-level index. §3 Communication Flows
  table links to per-flow detail docs under `docs/architecture/`.
- **`docs/architecture/NN-<topic>.md`** — per-flow detail docs. Update
  the matching detail doc in the same PR that changes the flow.

When you change request routing, dispatcher logic, lifecycle, or a
service's authority surface, the relevant detail doc is the
single-source-of-truth diagram for that flow; the doc is wrong the
moment the code drifts from it.

## R-channel capability tokens (Spec E, #601)

Privileged service methods declare their preconditions in their
type signature via Effect's R channel:

```ts
// task.service.ts
storeMessage(
  /* ... */
): Effect.Effect<void, MessageServiceError, TmAuthority>;

// task/handlers/tasks.handlers.ts
defineTaskMethod(TasksStoreMessage, {
  handler: (params, ctx) =>
    this.tasks.storeMessage(params).pipe(
      Effect.provideServiceEffect(
        TmAuthority,
        obtainTmAuthority(params.taskId, ctx.agentId),
      ),
    ),
});
```

- **`packages/server/src/app/capabilities/README.md`** — capability
  pattern overview, when to add a capability, refine-shape vs
  obtain-shape, composite vs union-of-tags, type-canary discipline.
- **`packages/server/docs/architecture/10-r-channel-capabilities.md`**
  — migration recipe + bug-class explainer.

When you add a new capability tag, mirror the existing files in
`app/capabilities/`: one file per tag (Tag class + value type + obtain
helper), `errors` imported from `@moltzap/protocol`, R channel of the
obtain helper resolves to the source service Tag (per Decision B,
Option A — service `require*` methods are `@internal` exported).
Capability tags belong to the sibling `CapabilityTags` alias in
`transport/layer-tags.ts`; they are DELIBERATELY NOT in `TaskTags`.
The `defineTaskMethod` constraint `Reqs extends TaskTags` rejects
handler bodies that forget to drain via `provideServiceEffect`. The
`capability-r-channel.types-check.ts` Canary 5 enforces this
boundary; do not remove it.

## Layered RPC method wrappers

`src/transport/define-layered-method.ts` exports `defineNetworkMethod`,
`defineTaskMethod`, `defineAppMethod`. Each wrapper enforces a
per-layer Tag allowlist (`NetworkTags` ⊂ `TaskTags` ⊂ `AppTags`) so a
handler at layer L cannot pull a service that only layer L+1 owns.
See `transport/README.md` for the layer hierarchy and
`transport/layer-tags.ts` for the allowlists (capability tags are a
sibling alias, NOT folded in).
