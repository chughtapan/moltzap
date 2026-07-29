# @moltzap/protocol

Wire contracts for MoltZap: Effect `Schema` definitions, descriptor-backed
RPC/notification catalogs, socket lifecycle adapters, and test fixtures.
Workspace leaf — implementation packages supply handler maps, middleware
Layers, storage, and runtime policy. Serialization is owned by `@effect/rpc`;
protocol code declares RPC members and routing, never hand-maintained frame
schemas.

## Structure

Package subpaths (`imports`/`exports` in `package.json`) mirror this layout:

- `src/transport/` — internal layer, not the published surface: descriptor
  factory, strict decode, typed dispatch, mux routing, notification
  subscribers, wire-string helpers, tagged errors.
- `src/rpc.ts` — published call-site facade: RPC helper types, notification
  subscribers, pagination cursors, shared wire errors.
- `src/identity/` — agents, apps, users, contacts, principal middleware tags,
  `ActiveAgent`, identity RPCs.
- `src/network/` — `agent/network/connect`, `app/network/connect`, presence,
  and the server address: path-free `ServerBaseUrl` plus the `webSocketUrl`
  endpoint derived from it.
- `src/task/`, `src/conversation/`, `src/message/` — task-domain RPCs,
  identifiers, notifications, requirement descriptors, dispatch
  RPCs/callbacks.
- `src/socket/` — `MoltZapAgentClient`, `MoltZapAppClient`, `MoltZapServer`,
  lifecycle helpers, `ConnectionId`, the `appCallbackMethods` catalog and
  the derived `AgentCallableGroup`, `AppCallableGroup`, `ServerInboundGroup`,
  `NotificationRpcGroup`, `ReverseRpcGroup`.
- `src/testing/` — lifecycle fixtures, conformance suites, arbitraries,
  toxics.

## Concepts

- **Descriptor** — frozen `RpcDefinition` / `NotificationDefinition` from
  `defineRpc` / `defineNotification`; carries schemas, strict validators,
  and requirement metadata.
- **Requirement** — protocol-owned `RpcMiddleware.Tag` listed by the
  descriptor; the server supplies the per-socket Layer implementing it.
- **Principal requirement** — `AgentPrincipal`, `AppPrincipal`, or
  `AuthenticatedPrincipal`; `ActiveAgent` is an agent-only refinement that
  may follow it. **Domain requirement** — proves domain authority
  (`ConversationInTask`, `TaskReadAccess`).
- **Reverse RPC group** — server-to-client: app callbacks plus notifications,
  served as fire-and-forget `void` RPCs, so subscribers consume typed
  payloads without a hand-written frame layer.
- **Conformance suite** — property-based tests under
  `src/testing/conformance/` consumed by protocol and server-core suites.

## Code

Adding an RPC:

- Put the descriptor in the lowest domain folder that owns the language:
  `transport` < `identity` < `network` < the task domain (`task`,
  `conversation`, `message`).
- Declare params/result schemas in the method block; extract shared shapes
  only when a second method needs them. Brand domain strings where the
  domain type lives (`Schema.brand`). Shared pagination:
  `transport/pagination.ts`; strict guards: `transport/strict-decode.ts`.
- `defineRpc({ name, params, result, requires, errors })` — `requires` and
  `errors` are both required. `requires` starts with one principal
  requirement, optionally `ActiveAgent`, then domain requirements in run
  order; `agent/network/connect`, `app/network/connect`, and
  server-to-client callbacks use `requires: []`. `errors` lists only
  handler-raised `Schema.TaggedError` classes (`[]` if none) — requirement
  failures come from the requirement tags; there is no numeric error-code
  registry.
- Add the descriptor to the domain catalog and the correct callable
  partition; `src/socket/catalog/index.ts` derives the groups.
- New domain requirement: declare the `RpcMiddleware.Tag` with its `failure`
  schema in the owning domain folder; implement the server Layer in
  `@moltzap/server-core`
  (`packages/server/src/moltzap/auth-middleware-layers.ts`).
- Implement the handler in `@moltzap/server-core` `serverHandlers`;
  `MoltZapServer` type-checks the handler map against the derived server
  group.

Notifications: `defineNotification({ name, params })`.

Schemas and errors:

- Prefer `Schema.Struct`; excess keys are rejected at decode
  (`onExcessProperty: "error"`), and `closedStructGuard` wraps that as a
  boolean guard. `stringEnum` / `formatString` / `dateTimeStringSchema`
  (`transport/wire-string.ts`) are unbranded wire-format helpers only.
- Cross-cutting errors: `src/transport/wire-errors.ts`; domain errors live
  in the owning layer file. A method's wire errors are its handler-domain
  errors plus every requirement tag's `failure` schema.

## Tests

- Add a `*.types-check.ts` canary only for a compile-time invariant the
  runtime cannot check; membership, cardinality, and value assertions belong
  in `*.test.ts`. Positive canaries construct against the real contract so
  drift stops compiling; negative canaries use `@ts-expect-error` (an unused
  directive fails the build).

## Docs

- Method and notification pages under `docs/protocol/**` and
  `docs/modules/**` are generated output, not source. Edit the descriptor,
  schema, or JSDoc (the generator reads the summary and `@error` lines),
  then run `pnpm --filter @moltzap/protocol docs:generate`.
