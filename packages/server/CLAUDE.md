# @moltzap/server

Server package — extends the workspace-root `/home/tapanc/moltzap/CLAUDE.md`
(architecture-doc rules, LSP-first tracing, symbol-name citations,
Mermaid gotchas all inherited).

## Architecture entry points

- **`ARCHITECTURE.md`** — package-level index. §3 Communication Flows
  points at the symbols whose JSDoc carries the canonical flow
  diagram (`socket-handler.ts → handleFrame`,
  `lease-registry.ts → LeaseRegistry`, etc.).
- **JSDoc next to the symbol** — when you change request routing,
  dispatcher logic, lifecycle, or a service's authority surface, the
  diagram in the JSDoc above that symbol is the
  single-source-of-truth for that flow. The diagram is wrong the
  moment the code drifts from it.

## R-channel capability tokens

Privileged service methods declare their preconditions in their
type signature via Effect's R channel. The descriptor declares which
capability tags the handler needs; the dispatcher auto-provisions
them per frame from a shared provider table — handlers `yield*` the
tag directly with no hand-piped `Effect.provideServiceEffect` chain
at the call site.

```ts
// protocol/task/tasks.ts — descriptor declares its capabilities
export const TasksStoreMessage = defineRpc({
  name: "tasks/storeMessage",
  params: TasksStoreMessageParams,
  result: TasksStoreMessageResult,
  capabilities: [
    { tag: TmAuthority,        argsOf: (p, ctx) => ({ taskId: p.taskId, callerAgentId: ctx.auth.agentId }) },
    { tag: ConversationInTask, argsOf: (p) => ({ taskId: p.taskId, conversationId: p.conversationId }) },
    { tag: MessageSendPermission, argsOf: (p, ctx) => ({ /* ... */ }) },
  ],
});

// task.service.ts — handler body just yields, no provideServiceEffect
storeMessage(
  /* ... */
): Effect.Effect<void, MessageServiceError, TmAuthority | ConversationInTask | MessageSendPermission>;

// server/src/app/capability-providers.ts — single source of truth for obtain helpers
export const serverCapabilityProviders = {
  [TmAuthority.key]: (args) => obtainTmAuthority(args.taskId, args.callerAgentId),
  /* ... 6 more entries ... */
} as const;
```

The dispatcher reads `definition.capabilities` per frame, looks up
each tag's obtain helper in `serverCapabilityProviders`, and threads
`Effect.provideServiceEffect(tag, providerEffect)` over the handler
before invoking it. The compile-time lockstep gate
(`protocol/transport/typed-dispatcher.types-check.ts` Canary 7)
rejects any handler whose R channel references a tag NOT in its
descriptor's `capabilities` array.

`MessagesSend` is the one structural exception: the wire schema
accepts `(conversationId | to | replyToId)` and the handler must
resolve `conversationId` via DB lookup before `MessageSendPermission`
can be obtained, so it stays hand-piped at the handler call site.
See `protocol/task/messages.ts → MessagesSend` for the rationale.

- **`packages/server/src/app/capabilities/README.md`** — capability
  pattern overview, when to add a capability, refine-shape vs
  obtain-shape, composite vs union-of-tags, type-canary discipline.
- **`packages/server/src/app/capability-providers.ts`** (file-level
  JSDoc) — provider-table walkthrough, two capability shapes,
  composite path, migration recipe.

When you add a new capability tag, the tag class + value type live in
`packages/protocol/src/task/capabilities/<name>.ts` (so descriptors
can reference them without a layering violation), and the obtain
helper + provider-table entry live in
`packages/server/src/app/capabilities/<name>.ts` and
`server/src/app/capability-providers.ts`. Capability tags are
collected by the `CapabilityTags` alias in
`transport/layer-tags.ts`; `defineTaskMethod`'s constraint
`Reqs extends TaskTags | CapabilityTags` accepts them in the handler
R channel.

## Layered RPC method wrappers

`src/transport/define-layered-method.ts` exports `defineNetworkMethod`,
`defineTaskMethod`, `defineAppMethod`. Each wrapper enforces a
per-layer Tag allowlist (`NetworkTags` ⊂ `TaskTags` ⊂ `AppTags`) so a
handler at layer L cannot pull a service that only layer L+1 owns.
See `transport/README.md` for the layer hierarchy and
`transport/layer-tags.ts` for the allowlists (capability tags are a
sibling alias, NOT folded in).
