# protocol/engine

_`packages/protocol/src/engine`_

## Purpose

Public barrel for the engine layer — the descriptor-aggregate machinery
that sits ABOVE the domains.

Where `transport/` is the wire DAG bottom (frames, the descriptor factory, the
mux) and the domains list their `requires` against the low principal tags
(`transport/principal.ts`), THIS layer owns everything that genuinely couples
to the full catalog + the capability tags: the genuine `Requirement` union +
`CapabilityRequirement` + classifiers (`requirements.ts`, referencing the
task-layer cap tags); the per-requirement `@effect/rpc` middlewares + the
TOTAL `requirementMiddleware` registry (`cap-middlewares.ts`); the server
engine group + the WS engine + the client-callable group projections (all
consuming the aggregated `rpc-registry`); and `CurrentPrincipal` (the request
principal as a service, referencing the identity/task brands).

Surfaced through the package's main barrel (`@moltzap/protocol`), not a
separate subpath: server-core consumes these via the main entry.

## Public surface

### [`AgentCallableGroup`](./client-callable-groups.ts#L135)

_Variable_

```ts
export const AgentCallableGroup: RpcGroup.RpcGroup<
  MembersWhereHead<typeof serverRpcMethods, typeof AgentPrincipal>
> = callableGroup([AgentPrincipal])
```

The outbound group a first-party AGENT client may originate: every
`serverRpcMethods` member whose `requires` head is `AgentPrincipal`, plus the
empty-`requires` methods. A first-party `agentClient.taskClose(...)`
(app-only) does not typecheck.

### [`AppCallableGroup`](./client-callable-groups.ts#L145)

_Variable_

```ts
export const AppCallableGroup: RpcGroup.RpcGroup<
  MembersWhereHead<typeof serverRpcMethods, typeof AppPrincipal>
> = callableGroup([AppPrincipal])
```

The outbound group a first-party APP client may originate: every
`serverRpcMethods` member whose `requires` head is `AppPrincipal`, plus the
empty-`requires` methods. A first-party `appClient.taskRequest(...)`
(agent-only) does not typecheck — the compile-time Principle-1 win.

### [`AppCallbackHandlers`](./handlers.ts#L96)

_TypeAlias_

```ts
export type AppCallbackHandlers<
  Ctx,
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<AppCallbackInboundRpcDefinition, Ctx, Caps>;
```

### [`AppCallbackInboundRpcDefinition`](./handlers.ts#L94)

_TypeAlias_

```ts
export type AppCallbackInboundRpcDefinition = AnyAppCallbackRpcDefinition;

export type AppCallbackHandlers<
  Ctx,
  Caps extends Context.Tag<any, any> = never,
> = HandlerTable<AppCallbackInboundRpcDefinition, Ctx, Caps>;
```

`AppCallbackHandlers` — handler table for an app moderating one or
more tasks. Catalog: `appCallbackMethods` —
`DispatchAuthorize`, `MessagesAuthorize`, `TaskCreate`. All three
REQUIRED (R14b); vacuous-deny moderators must write the handler
explicitly. `TaskCreate` is the server-initiated callback fired
after `task/request` lands the task in `waiting`; the app's typed
verdict drives the lifecycle transition.

### [`callerAgentId`](./current-principal.ts#L66)

_Variable_

```ts
export const callerAgentId: Effect.Effect<AgentId, never, CurrentPrincipal> =
  Effect.gen(function* () {
    const p = yield* CurrentPrincipal;
    // Exhaustive narrow on the tagged union — NOT an `as { agentId }`
    // assertion. The agent arm's `agentId` is reached by discriminant.
    return p._tag === "AgentContext"
      ? p.agentId
      : yield* Effect.die(
          new Error(
            `capability derivePayload reached a non-agent principal: ${p._tag}`,
          ),
        );
  }).pipe(Effect.withSpan("callerAgentId"))
```

Impossible-state defect: a capability `derivePayload` read the principal
and found a NON-agent arm. Every live descriptor cap is agent-originated
(its method's `requires` head is `AgentPrincipal`), so the binding
guarantees an agent caller; an app arm here is a wiring defect, not a
caller-actionable error. Effect.die (not a caller-visible error)
because the principal gate already rejected non-agent callers.

### [`CapabilityRequirement`](./requirements.ts#L43)

_TypeAlias_

```ts
export type CapabilityRequirement =
  | typeof ConversationInTask
  | typeof ConversationSendAccess
  | typeof TaskReadAccess
  | typeof ContactPolicyAllowsReach;

/**
 * One entry in a method's `requires` list: a principal requirement, the
 * agent-only `AgentClaimed` refinement, or a capability requirement. The genuine
 * closed union of the actual requirement tag classes — every classifier below
 * narrows it by tag-class IDENTITY, and every consumer reads `.errors` / `.key`
 * off it directly (no structural cast, no variance-erased `Context.Tag` escape
 * hatch).
 */
export type Requirement =
  | PrincipalRequirement
  | typeof AgentClaimed
  | CapabilityRequirement;

/**
 * The principal requirement that heads a `requires` list, or `undefined` when
 * `requires` is empty (only `network/connect`, dispatched pre-auth). A READ of
 * `requires`, not a separate field — the client groups partition on this head
 * tag and the server gate narrows to it. Matches the head by tag-class identity.
 */
export const principalRequirementOf = (
  requires: ReadonlyArray<Requirement>,
): PrincipalRequirement | undefined => {
  const head = requires[0];
  return head === AgentPrincipal || head === AppPrincipal ? head : undefined;
};
```

A capability requirement: one of the capability tags the server gates with a
cap middleware. Its `.key` is a `MiddlewareRequirementKey` by construction, so
the engine binding's `requirementMiddleware[cap.key]` lookup is total with no
cast — and a descriptor listing a cap with no registered middleware is a
COMPILE error (the cap is not in this union).

### [`capRequirementsOf`](./requirements.ts#L100)

_Function_

```ts
export const capRequirementsOf = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<CapabilityRequirement>
```

The capability requirements in a `requires` list — every entry that is NOT a
principal requirement or the `AgentClaimed` refinement, in declared order. The
type guard narrows `Requirement` → CapabilityRequirement by identity,
so each result's `.key` is a `MiddlewareRequirementKey` (the total-map lookup
needs no cast).

### [`ContactPolicyAllowsReachMw`](./cap-middlewares.ts#L73)

_Class_

```ts
export class ContactPolicyAllowsReachMw extends RpcMiddleware.Tag<ContactPolicyAllowsReachMw>()(
  "@moltzap/protocol/cap/mw/contact-policy-allows-reach",
  {
    provides: ContactPolicyAllowsReach,
    failure: capFailure(ContactPolicyAllowsReach),
  },
) {}
```

### [`ConversationInTaskMw`](./cap-middlewares.ts#L55)

_Class_

```ts
export class ConversationInTaskMw extends RpcMiddleware.Tag<ConversationInTaskMw>()(
  "@moltzap/protocol/cap/mw/conversation-in-task",
  { provides: ConversationInTask, failure: capFailure(ConversationInTask) },
) {}
```

### [`ConversationSendAccessMw`](./cap-middlewares.ts#L60)

_Class_

```ts
export class ConversationSendAccessMw extends RpcMiddleware.Tag<ConversationSendAccessMw>()(
  "@moltzap/protocol/cap/mw/conversation-send-access",
  {
    provides: ConversationSendAccess,
    failure: capFailure(ConversationSendAccess),
  },
) {}
```

### [`CurrentPrincipal`](./current-principal.ts#L54)

_Class_

```ts
export class CurrentPrincipal extends Context.Tag(
  "@moltzap/protocol/CurrentPrincipal",
)<CurrentPrincipal, Principal>() {}
```

Protocol-owned `Context.Tag` carrying the request's authenticated
Principal. The capability middleware's `derivePayload` `yield*`s
it WITHOUT importing the server; the server SATISFIES it by
`provideService(CurrentPrincipal, principalCtx)` at the dispatch site.
Provided ONLY on authenticated/capability-bearing methods — capabilities
never run on the unauth Connect frame — so the unauth arm is never a
concern here.

### [`HandlerSlot`](./handlers.ts#L25)

_Interface_

```ts
export interface HandlerSlot<
  D extends RpcDefinition<
    string,
    Schema.Schema.AnyNoContext,
    Schema.Schema.AnyNoContext
  >,
  Ctx,
  Caps extends Context.Tag<any, any>,
> {
  readonly definition: D;
  readonly handle: (
    params: ParamsOf<D>,
    ctx: Ctx,
  ) => Effect.Effect<ResultOf<D>, unknown, Caps>;
}
```

Per-definition handler slot (app-callback authoring shape). `Ctx` is the
per-frame context the client hands every handler. `Caps` is the upper bound
on which `Context.Tag`s the handler's R channel may reference; the
app-callback catalog declares no capabilities, so callers bind `Caps =
never`. The app client's reverse `RpcServer` serves each slot's `handle`.

### [`isUnauthenticatedMethod`](./server-engine-group.ts#L58)

_Function_

```ts
export const isUnauthenticatedMethod = (tag: string): boolean
```

Whether a wire tag is in UNAUTHENTICATED_METHODS — the single
membership check both the engine-group construction (which omits the gate
for these) and the server's `principalKinds` projection (which omits them
from the policy table) share, so the two agree on the partition by
construction.

### [`makeServerProtocolLayer`](./server-engine.ts#L60)

_Function_

```ts
export const makeServerProtocolLayer = (options: {
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
  readonly sinkReady: Deferred.Deferred<ChannelSink>;
}): Layer.Layer<RpcServer.Protocol>
```

Build the `RpcServer.Protocol` layer over one server-side mux
channel. `RpcServer.Protocol.make` hands the engine's inbound `write`
injector to makeServerChannelProtocol's builder, which returns the
protocol impl record (the engine binds to) plus the channel sink (the mux
demux feeds decoded inbound frames into). Only the impl crosses into the
`Protocol` Tag; the built ChannelSink is fulfilled into the
caller-provided `sinkReady` Deferred so the live connection's
`runMuxReader` can route inbound request-family chunks into the engine.

The sink's `inject` closes over the SAME `write` injector the engine handed
the builder, so a chunk routed to the sink enters the engine's dispatch
loop. The Deferred handoff is necessary because the sink is only knowable
after the engine builds the Protocol (the `write` injector does not exist
until then), and `runMuxReader` must register it before the socket reader
forks.

`write` is the raw-write surface of the shared socket (one call writes one
bare frame; the live connection passes `Socket.Socket["writer"]`).
`disconnects` is the Mailbox the live connection offers a client id to on
socket close, so the engine runs per-client teardown.

### [`MiddlewareRequirementKey`](./cap-middlewares.ts#L89)

_TypeAlias_

```ts
export type MiddlewareRequirementKey =
  | typeof AgentPrincipal.key
  | typeof AppPrincipal.key
  | typeof ConversationInTask.key
  | typeof ConversationSendAccess.key
  | typeof TaskReadAccess.key
  | typeof ContactPolicyAllowsReach.key;

/**
 * Requirement key → its `RpcMiddleware.Tag`. The engine binding
 * (`server-engine-group.ts → buildEngineMember`) reads a method's `requires`
 * list and stacks each requirement's middleware in declared order. Both
 * principal requirements (`AgentPrincipal` / `AppPrincipal`) map to the single
 * {@link PrincipalGateMw}; each capability maps to its own cap middleware. The
 * map is TOTAL over {@link MiddlewareRequirementKey} (enforced by `satisfies`),
 * so the lookup never returns `undefined` and the descriptor↔binding
 * correspondence is compile-checked — no boot-time gating walk needed.
 */
export const requirementMiddleware = {
  [AgentPrincipal.key]: PrincipalGateMw,
  [AppPrincipal.key]: PrincipalGateMw,
  [ConversationInTask.key]: ConversationInTaskMw,
  [ConversationSendAccess.key]: ConversationSendAccessMw,
  [TaskReadAccess.key]: TaskReadAccessMw,
  [ContactPolicyAllowsReach.key]: ContactPolicyAllowsReachMw,
} satisfies Record<MiddlewareRequirementKey, RpcMiddleware.TagClassAny>;
```

Every requirement key that carries a middleware: both principal requirements
plus each capability tag. The `AgentClaimed` refinement is EXCLUDED — it
carries no middleware (an active-arm check the principal gate's per-method
impl Layer reads off `requires`). This union makes requirementMiddleware
a TOTAL map: a requirement key added without a middleware entry fails the
`satisfies` below, so the engine binding can never leave a requirement ungated.

### [`MwForRequirement`](./cap-middlewares.ts#L125)

_TypeAlias_

```ts
export type MwForRequirement<Req> = Req extends typeof AgentPrincipal
```

Type-level requirement `Context.Tag` → its `RpcMiddleware.Tag` (the runtime
mirror is requirementMiddleware). Matches by tag IDENTITY so the
engine member's middleware param carries the EXACT mws, keeping each cap's
`provides` type-visible (a handler that `yield*`s a cap Tag has it stripped
from the Layer's residual requirement — the proof-exclusion guarantee). Both
principal requirements map to `PrincipalGateMw`; the `AgentClaimed` refinement
carries no middleware (maps to `never`).

### [`MwStackFor`](./cap-middlewares.ts#L146)

_TypeAlias_

```ts
export type MwStackFor<Requires extends ReadonlyArray<unknown>> =
```

The middleware stack a method's `requires` list maps to: each requirement's
`RpcMiddleware.Tag` (principal → `PrincipalGateMw`, cap → its cap mw,
`AgentClaimed` → `never`). The engine member's `Middleware` param is this
union, so each cap's `provides` is type-visible at the binding. The empty
`requires` (`network/connect`) maps to `never` — no middleware.

### [`NotificationRpcGroup`](./rpc-method-groups.ts#L105)

_Variable_

```ts
export const NotificationRpcGroup = groupFromNotifications(
  notificationDefinitions,
)
```

Server→client reverse notification group. The server fires each notification
as a fire-and-forget `void`-result RPC on a target connection's reverse
channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
each payload into the `SubscriberRegistry`. Reuses the same s2c reverse-RPC
machinery as the moderator callbacks folded into ReverseRpcGroup.

### [`Principal`](./current-principal.ts#L41)

_TypeAlias_

```ts
export type Principal =
  | { readonly _tag: "AgentContext"; readonly agentId: AgentId }
```

The authenticated principal of the in-flight request — the value a
capability middleware `yield*`s to read `agentId` / `appId`. Tagged so a
middleware narrows the app-arm vs agent-arm by discriminant before
reading the field (no `as { agentId }` assertion).

The server's `AgentContext` / `AppContext`
(`@moltzap/server-core` `transport/context.ts`) — `Data.TaggedClass`
instances carrying extra fields (`agentStatus`, `ownerUserId`) —
structurally inhabit this union (`_tag` + `agentId` / `appId` match;
extra fields are fine for a read-only consumer), so the server provides
the live narrowed arm directly. The `appId` of the app arm is sourced
from the live `AppConnection.auth` minted at auth time, NOT hardcoded.

### [`PrincipalGateMw`](./cap-middlewares.ts#L50)

_Class_

```ts
export class PrincipalGateMw extends RpcMiddleware.Tag<PrincipalGateMw>()(
  "@moltzap/protocol/cap/mw/principal-gate",
  { failure: principalGateFailure },
) {}
```

The principal gate: narrows the live connection to the method's principal arm
and fails `Unauthorized` / `Forbidden`. No `provides` — the handler reads the
narrowed arm off `ConnectionTag`. Stacked first on every authenticated method.

### [`principalRequirementOf`](./requirements.ts#L68)

_Function_

```ts
export const principalRequirementOf = (
  requires: ReadonlyArray<Requirement>,
): PrincipalRequirement | undefined
```

The principal requirement that heads a `requires` list, or `undefined` when
`requires` is empty (only `network/connect`, dispatched pre-auth). A READ of
`requires`, not a separate field — the client groups partition on this head
tag and the server gate narrows to it. Matches the head by tag-class identity.

### [`PrincipalRequirementOf`](./requirements.ts#L80)

_TypeAlias_

```ts
export type PrincipalRequirementOf<
  Requires extends ReadonlyArray<Requirement>,
> = Requires extends readonly [infer Head, ...ReadonlyArray<unknown>]
```

The type-level principal requirement that heads a `requires` tuple, or
`undefined` when empty or non-principal-headed. The type mirror of
principalRequirementOf, discriminated on the head tag's identity.

### [`Requirement`](./requirements.ts#L57)

_TypeAlias_

```ts
export type Requirement =
  | PrincipalRequirement
  | typeof AgentClaimed
  | CapabilityRequirement;

/**
 * The principal requirement that heads a `requires` list, or `undefined` when
 * `requires` is empty (only `network/connect`, dispatched pre-auth). A READ of
 * `requires`, not a separate field — the client groups partition on this head
 * tag and the server gate narrows to it. Matches the head by tag-class identity.
 */
export const principalRequirementOf = (
  requires: ReadonlyArray<Requirement>,
): PrincipalRequirement | undefined => {
  const head = requires[0];
  return head === AgentPrincipal || head === AppPrincipal ? head : undefined;
};
```

One entry in a method's `requires` list: a principal requirement, the
agent-only `AgentClaimed` refinement, or a capability requirement. The genuine
closed union of the actual requirement tag classes — every classifier below
narrows it by tag-class IDENTITY, and every consumer reads `.errors` / `.key`
off it directly (no structural cast, no variance-erased `Context.Tag` escape
hatch).

### [`requirementMiddleware`](./cap-middlewares.ts#L107)

_Variable_

```ts
export const requirementMiddleware =
```

Requirement key → its `RpcMiddleware.Tag`. The engine binding
(`server-engine-group.ts → buildEngineMember`) reads a method's `requires`
list and stacks each requirement's middleware in declared order. Both
principal requirements (`AgentPrincipal` / `AppPrincipal`) map to the single
PrincipalGateMw; each capability maps to its own cap middleware. The
map is TOTAL over MiddlewareRequirementKey (enforced by `satisfies`),
so the lookup never returns `undefined` and the descriptor↔binding
correspondence is compile-checked — no boot-time gating walk needed.

### [`requiresClaimed`](./requirements.ts#L89)

_Function_

```ts
export const requiresClaimed = (
  requires: ReadonlyArray<Requirement>,
): boolean
```

Whether a `requires` list carries the agent-only `AgentClaimed` refinement.

### [`ReverseRpcGroup`](./rpc-method-groups.ts#L136)

_Variable_

```ts
export const ReverseRpcGroup: RpcGroup.RpcGroup<ReverseRpcMember> =
  RpcGroup.make(
    // Same homogeneous-map laundering as `groupFromNotifications`: `Array.map`'s
    // element type cannot prove the per-slot tuple, but at runtime each callback
    // maps to a result-bearing `Rpc` and each notification to a `void`-result
    // `Rpc`, in source order — precisely the `ReverseRpcMember` union. Verified
    // by `rpc-method-groups.types-check.ts`.
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- combined-tuple keying proof TS cannot express; verified by rpc-method-groups.types-check.ts
    ...([
      ...appCallbackMethods.map((definition) =>
        Rpc.make(definition.name, {
          payload: definition.paramsSchema,
          success: definition.resultSchema,
          error: definition.errorSchema,
        }),
      ),
      ...notificationDefinitions.map((definition) =>
        Rpc.make(definition.name, {
          payload: definition.paramsSchema,
          success: Schema.Void,
          error: Schema.Never,
        }),
      ),
    ] as unknown as readonly ReverseRpcMember[]), // #ignore-sloppy-code[as-unknown-as]: combined-tuple keying proof TS cannot express; verified by rpc-method-groups.types-check.ts.
  )
```

The full server→client reverse group: the moderator callbacks
(`appCallbackMethods`) ∪ the notifications (NotificationRpcGroup),
built as ONE `RpcGroup` over the combined member tuple (not `merge`). The
server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires callbacks
awaiting a verdict, fires notifications fork-and-forget); the agent + app
clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent client
only ever receives notifications (its handlers for the three callback methods
are never invoked — an agent is not a moderator), but it serves the whole
group so the s2c engine binds one handler map.

### [`ServerEngineLayer`](./server-engine.ts#L97)

_Variable_

```ts
export const ServerEngineLayer = RpcServer.layer(WsServerEngineRpcGroup)
```

The server engine layer for WsServerEngineRpcGroup — the WS-dispatched
members, each carrying its per-method `*AuthMw`. Binding a group whose members
lacked the `*AuthMw` gate would run methods with no authorization gate. The
server-wiring guard canary (`server-engine.types-check.ts`) pins that this
layer's requirement channel demands the per-method `*AuthMw`.

`RpcServer.layer(group)` runs the dispatch loop over whatever
`RpcServer.Protocol` is in scope; there is no `RpcServer.toLayer`. Its
requirement channel is
`RpcServer.Protocol | Rpc.ToHandler&lt;WsServerEngineRpcGroup&gt;` plus every
member's `*AuthMw` — the live connection provides the Protocol via
makeServerProtocolLayer, the handler bodies via
`WsServerEngineRpcGroup.toLayer(serverHandlers)`, and each `*AuthMw`
runtime via its per-socket server-supplied `Layer`
(`auth-middleware-layers.ts`).

### [`ServerEngineRpcGroup`](./server-engine-group.ts#L178)

_Variable_

```ts
export const ServerEngineRpcGroup: RpcGroup.RpcGroup<
  EngineMembers<typeof serverRpcMethods>[number]
> = RpcGroup.make(...engineMembers)
```

### [`TaskReadAccessMw`](./cap-middlewares.ts#L68)

_Class_

```ts
export class TaskReadAccessMw extends RpcMiddleware.Tag<TaskReadAccessMw>()(
  "@moltzap/protocol/cap/mw/task-read-access",
  { provides: TaskReadAccess, failure: capFailure(TaskReadAccess) },
) {}
```

### [`UNAUTHENTICATED_METHODS`](./server-engine-group.ts#L46)

_Variable_

```ts
export const UNAUTHENTICATED_METHODS = ["network/connect"] as const
```

The ONLY methods callable on an unauthenticated connection. Built WITHOUT any
`*AuthMw` (no principal exists pre-auth); they read the live 3-arm `Connection`
via `ConnectionTag`. EXHAUSTIVE: every other catalog method is
authenticated and carries its `*AuthMw`. Adding a method here is a deliberate,
reviewed security decision — the partition canary
(`server-engine-group.types-check.ts`) FAILS the build if a method is in
neither partition or both.

### [`UnauthenticatedMethod`](./server-engine-group.ts#L49)

_TypeAlias_

```ts
export type UnauthenticatedMethod = (typeof UNAUTHENTICATED_METHODS)[number];
```

A plain (unbranded) member of UNAUTHENTICATED_METHODS.

### [`WsServerEngineRpcGroup`](./server-engine-group.ts#L200)

_Variable_

```ts
export const WsServerEngineRpcGroup: RpcGroup.RpcGroup<WsEngineMember> =
  RpcGroup.make(...engineMembers)
```

The group the live server engine binds: every catalog member, each stacked
with its `requires` middlewares. Its members map one-to-one onto
`serverHandlers`, so `WsServerEngineRpcGroup.toLayer` satisfies `HandlersFrom`.
The descriptor↔binding correspondence is compile-checked:
`server-engine-group.types-check.ts` pins
`RpcGroup.Rpcs&lt;typeof WsServerEngineRpcGroup&gt; ≡ EngineRpcs`, and the TOTAL
requirementMiddleware map makes a requirement with no middleware
unrepresentable — so no boot-time gating walk is needed.

## Files

- `cap-middlewares.ts`
- `client-callable-groups.ts`
- `current-principal.ts`
- `handlers.ts`
- `requirements.ts`
- `rpc-method-groups.ts`
- `server-engine-group.ts`
- `server-engine.ts`
