# @moltzap/protocol

Effect `Schema` definitions, descriptor-backed RPC/notification
definitions, lifecycle socket adapters, and test fixtures for the MoltZap
protocol. This package is the workspace leaf: it owns the wire contracts and
the server/client RPC catalogs, while implementation packages provide handler
maps, middleware Layers, storage, and runtime policy.

The socket payload is still bare JSON-RPC, but serialization is owned by
`@effect/rpc`. Protocol code declares RPC members and channel routing; it does
not hand-maintain request/response/notification frame schemas.

## Key Files

The source DAG is reflected in `src/index.ts`:

- `src/transport/` — descriptor factory, strict decode helpers, typed dispatch,
  mux routing, notification subscribers, principal middleware tags, wire string
  brands, and cross-cutting tagged errors.
- `src/identity/` — agents, users, contacts, and identity RPC descriptors.
- `src/network/` — `agent/connect`, `app/connect`, and presence RPCs.
- `src/task/` — task, conversation, message, dispatch lease, and capability
  descriptors. Capability requirements live next to the domain that consumes
  them under `src/task/capabilities/`.
- `src/app/` — app-facing RPCs and server-to-app callback descriptors.
- `src/socket/` — `MoltZapAgentClient`, `MoltZapAppClient`, `MoltZapServer`,
  shared lifecycle helpers, close info, and `ConnectionId`.

Root-level protocol assembly:

- `src/rpc-method-groups.ts` — authored AgentCallable, AppCallable, and
  AppCallback catalogs, plus the derived server-inbound and reverse groups.
- `src/requirements.ts` — the closed requirement union and helpers. A
  requirement is the `@effect/rpc` middleware tag itself.
- `src/credentials.ts` — branded/redacted credential schemas.
- `src/testing/` — lifecycle fixtures, conformance suites, arbitraries, and
  toxics.

## Commands

- `pnpm build` — `tsc -b && tsc-alias -p tsconfig.json`
- `pnpm test` — Vitest unit tests
- `pnpm docs:generate` — regenerate protocol reference docs and module pages

## Documentation Pipeline

Published protocol reference docs live under root `docs/protocol/**` and
`docs/modules/**`. Generated method and notification pages are output, not
source. Update the descriptor, schema, or JSDoc, then run
`pnpm --filter @moltzap/protocol docs:generate`.

## Adding An RPC Method

1. Pick the owning layer by dependency order: `transport` < `identity` <
   `network` < `task` < `app`. Put the descriptor in the lowest layer that owns
   the domain language.

2. Declare params/result schemas in the method block with Effect `Schema`.
   Domain branded strings are declared where the domain type lives with
   `Brand.Brand<...>` and `Schema.brand(...)`. Use shared pagination from
   `transport/pagination.ts`, and strict guards from
   `transport/strict-decode.ts`.

3. Declare handler-domain error classes with `Schema.TaggedError`. The class is
   both constructor and wire schema. There is no numeric error-code registry.
   Only list errors the handler raises; requirement failures are added from the
   requirement middleware tags.

4. Define the descriptor with `defineRpc({ name, params, result, requires,
   errors })`.

   `requires` is required. The first element is one principal requirement
   (`AgentPrincipal`, `AppPrincipal`, or `AuthenticatedPrincipal`), optionally
   followed by `AgentClaimed`, then capability requirements in run order.
   `agent/connect`, `app/connect`, and server-to-client callbacks use
   `requires: []`.

   `errors` is required. Use `[]` when the handler has no domain-specific
   failure.

5. Add focused JSDoc above the descriptor. The docs generator reads `@error`
   lines and the method summary.

6. Add the descriptor to the layer catalog and the correct callable partition.
   The root `rpc-method-groups.ts` derives server-inbound and client groups from
   those authored catalogs.

7. For a new capability requirement, declare the protocol tag as an
   `RpcMiddleware.Tag` in the owning domain folder and include its `failure`
   schema. Add it to `CapabilityRequirement` in `src/requirements.ts`, then
   implement the server Layer in
   `@moltzap/server-core/src/transport/auth-middleware-layers.ts`.

8. Implement the server handler in `@moltzap/server-core` and add it to
   `serverHandlers`. The `MoltZapServer` constructor type-checks the handler
   map against the derived server group.

9. Run `pnpm --filter @moltzap/protocol docs:generate` when method docs should
   change.

10. Add a type canary only for a compile-time invariant the runtime cannot
    check. Use a normal `*.test.ts` for membership, cardinality, or runtime
    value assertions.

## Notifications

Use `defineNotification({ name, params })`. Notifications are served on the
reverse RPC group as fire-and-forget `void` RPCs, so subscribers still consume
typed payloads without a hand-written notification frame layer.

## Conventions

Schemas:

- Prefer `Schema.Struct({ ... })`.
- Excess-key rejection happens at decode with
  `{ onExcessProperty: "error" }`; `closedStructGuard` wraps that as a boolean
  type guard.
- Use `Schema.brand(...)` in the owning domain file for branded value types.
  Use `stringEnum`, `formatString`, and `dateTimeStringSchema` from
  `transport/wire-string.ts` only for their unbranded wire-format helpers.
- Keep unique params/result schemas in the method block. Extract only when a
  second method needs the same shape.

Errors:

- Cross-cutting errors live in `src/transport/wire-errors.ts`.
- Domain errors live in the owning layer file.
- Per-method wire errors are the union of handler-domain errors plus every
  requirement tag's `failure` schema.

Type checks:

- `*.types-check.ts` files are compiler-only assertions. Positive canaries use
  `Expect<Equal<A, B>>`; negative canaries use `@ts-expect-error`.
- Delete canaries that merely duplicate runtime tests or hardcode stale
  implementation details.

## Glossary

- **Descriptor** — A frozen `RpcDefinition` or `NotificationDefinition` from
  `defineRpc` / `defineNotification`. Carries schemas, strict validators, and
  requirement metadata.
- **Requirement** — A protocol-owned `RpcMiddleware.Tag`. The descriptor lists
  it; the server supplies a per-socket Layer that implements it.
- **Capability Requirement** — A requirement that proves domain authority, such
  as `ConversationInTask` or `TaskReadAccess`.
- **Principal Requirement** — `AgentPrincipal`, `AppPrincipal`,
  `AuthenticatedPrincipal`, or `AgentClaimed`.
- **Reverse RPC Group** — The server-to-client group containing app callbacks
  and notifications.
- **Conformance Suite** — Property-based tests under `src/testing/conformance/`
  consumed by protocol, server, client, and external implementations.
