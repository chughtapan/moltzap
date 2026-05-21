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

## R-channel capability tokens

Privileged service methods declare their preconditions in their
type signature via Effect's R channel. The descriptor declares which
capability tags the handler needs; the dispatcher auto-provisions
them per frame from a shared provider table — handlers `yield*` the
tag directly with no hand-piped `Effect.provideServiceEffect` chain
at the call site.

```ts
// protocol/task/tasks.ts — descriptor declares its capabilities
export const TaskConversationCreate = defineRpc({
  name: "task/conversation/create",
  params: TaskConversationCreateParams,
  result: TaskConversationCreateResult,
  capabilities: [
    { tag: TmAuthority,                    argsOf: (p, ctx) => ({ taskId: p.taskId, callerAgentId: ctx.auth.agentId }) },
    { tag: ConversationCreateAuthorization, argsOf: (p, ctx) => ({ agentIds: [...p.participants], creatorAgentId: ctx.auth.agentId }) },
  ],
});

// service body just yields the tag, no provideServiceEffect at the call site
create(
  /* ... */
): Effect.Effect<Conversation, ConversationServiceError, ConversationCreateAuthorization>;

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
- **`packages/server/docs/architecture/r-channel-capabilities.md`**
  — migration recipe + bug-class explainer.

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
