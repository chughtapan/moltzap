# @moltzap/protocol

Effect-`Schema` definitions, descriptor-backed RPC/notification
definitions, and decode-time validators for the MoltZap JSON-RPC
protocol. Source of truth for all wire message types. Leaf of the
workspace dependency DAG.

The wire DIALECT is JSON-RPC-2.0 (`{jsonrpc:"2.0", id, method, params}` /
`-32xxx` error codes). The validation ENGINE is Effect `Schema`
(`Schema.Struct` / `Schema.Union` / `Schema.brand`, decoded via
`Schema.decodeUnknownEither`)
— same bytes on the socket, one decode engine shared with the rest of
the runtime.

## Key Files

Five protocol layers, organized DAG-style (transport at the bottom,
app at the top — see `src/index.ts` file-level JSDoc for the diagram):

- `src/transport/` — wire frames, JSON-RPC encode/decode, the typed
  dispatcher, tagged-error registry, per-connection `Originator`.
  Bottom of the DAG.
- `src/identity/` — agents, users, sessions, contact policy.
- `src/network/` — `network/connect`, ping, presence, the
  actor-model identity types (`ConnectionId` brand,
  `AuthenticatedIdentity`).
- `src/task/` — singular `task/*` + `task/conversation/*` namespace:
  `TaskCreate`, `TaskLeave`, `TaskList`, `TaskClose`,
  `TaskAddParticipant`, `TaskRemoveParticipant`, the six
  `TaskConversation*` admin methods, the `Messages*` family
  (`MessagesSend` / `MessagesList` — both require `taskId`),
  dispatch lease wire surface, `AppId` brand, `DEFAULT_APP_ID`
  constant, `ParticipantNotAdmittedError`. Branded `TaskId` /
  `LeaseId` ids live in `src/task/ids.ts`. Family overview lives
  in the header block above the descriptors in `src/task/tasks.ts`.
  Type canary: `src/task/task-conversation-family.types-check.ts`
  (wire-name pins, payload shapes, removed-reason enum, the
  `task/create` callback pin). The outbound-catalog partition
  (`appCallable = agentClient ∪ appCallableTask`) is a RUNTIME test in
  `src/rpc-registry.test.ts`, not a canary — the invariant is a fact
  about array membership that `expect` checks directly.
- `src/app/` — app registration + task-callback RPCs (server-initiated
  calls into the client). Top of the DAG.

Aggregates and entry points:

- `src/index.ts` — public barrel; re-exports the layers in DAG order.
- `src/rpc-registry.ts` — canonical `rpcMethods` +
  `notificationDefinitions` arrays + `appCallbackMethods` group +
  per-kind partitions (`agentClientRpcMethods`,
  `appCallableRpcMethods`, `serverRpcMethods`); exposes
  `decodeServerInbound` / `decodeClientInbound`.
- `src/schema-primitives.ts` — `stringEnum`, `brandedId`,
  `brandedString`, `brandedNumber`, `DateTimeString`.
- `src/version.ts` — `PROTOCOL_VERSION` constant.
- `src/transport/wire-errors.ts` — cross-cutting tagged errors
  (`UnauthorizedError`, `ForbiddenError`, `NotFoundError`,
  `ConflictError`, `InvalidParamsError`, `MalformedFrameError`).
  Domain-specific tagged errors live in the owning layer's file.

Testing and tooling:

- `src/testing/conformance/` — property-based conformance suite
  (consumed by server, client, and external repos like
  moltzap-arena).
- `src/testing/arbitraries/` — fast-check generators for fuzzing.
- `src/testing/models/` — reference state machines used by
  conformance properties.
- `src/testing/toxics/` — Toxiproxy fault-injection adapters for
  adversity-tier conformance properties.
- `scripts/generate-docs.ts` + `scripts/docs/` — Mintlify generator
  for the protocol reference pages under root `docs/protocol/`.

## Commands
- `pnpm build` — `tsc` (MUST build before any other package)
- `pnpm docs:generate` — regenerate root `docs/protocol/**` from protocol descriptors
- `pnpm test` — vitest unit tests

## Documentation pipeline

Published protocol reference docs live under root `docs/protocol/**`
(Mintlify reads from the repository docs tree). The generated method
and notification pages are output, not source. The source of truth is
the descriptor graph in `src/**/methods.ts`, `src/rpc-registry.ts`,
and per-symbol JSDoc on each `defineRpc` / `defineNotification` call
site. Do not hand-edit generated method or notification MDX; update
the schema/descriptor or JSDoc, then run `pnpm docs:generate` from
the package or repository root. Root CI runs `pnpm docs:check:drift`.

## Adding a new RPC method

The descriptor files are organized **by method**: a small SHARED section
at the top (only the value types 2+ methods reuse), then one contiguous
`// ═══ method/name ═══` block per RPC carrying its inlined unique
params/result, its `defineRpc` descriptor, and the contract JSDoc above
it. Keep a new method self-contained in its own block; promote a schema
to SHARED only when a second method needs it.

The recipe; every new RPC follows it:

1. **Pick the layer.** Per the DAG: `transport` < `identity` <
   `network` < `task` < `app`. A method may reference types from
   layers at-or-below; never above. Put it in the lowest layer that
   covers it.

2. **Declare schemas in the method's block.** Use Effect `Schema`:
   `Schema.Struct({ ... })`. Branded ids via `brandedId("FooId")`;
   enums via `stringEnum(["a", "b"])`; bounded integers via
   `Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(n))`
   (the inline form — NOT `Schema.Int`, which hoists a `$defs`/`$ref`
   the docs walker can't read). `Schema.Struct` STRIPS excess keys by
   default; strict rejection happens at the DECODE boundary, where every
   wire decode passes `{ onExcessProperty: "error" }` (the
   `STRICT_DECODE` const) and `closedStructGuard` wraps it — see the
   `closedStruct` / `STRICT_DECODE` glossary entry. Inline a schema the
   method alone uses; extract to the file's SHARED section only when 2+
   methods share it.

3. **Declare the handler-domain error classes** the handler raises.
   Each extends `Schema.TaggedError<Foo>()("Foo", errorPayloadFields)`
   — the class is BOTH the runtime constructor AND its own wire
   `Schema`; its `_tag` literal is the union discriminant the engine
   decodes against. There is no numeric code and no central registry.
   Cross-cutting errors (`ForbiddenError`, `NotFoundError`,
   `ConflictError`, …) live in `transport/wire-errors.ts`; a
   domain-specific error lives in its owning layer file (e.g.
   `TaskClosedError` in `task/tasks.ts`). Declare ONLY the errors the
   handler itself raises — the principal-gate errors
   (`Unauthorized`/`Forbidden`) and each requirement's declared errors
   are added automatically (see step 8).

4. **Define the descriptor** with `defineRpc({ name, params, result,
   requires, errors })`:
   - `requires`: REQUIRED — the ordered authority list. The FIRST
     element is exactly one principal requirement (`AgentPrincipal` |
     `AppPrincipal`); an optional `AgentClaimed` refinement (agent-only,
     claimed/active arm) follows; the rest are capability tags **in run
     order**. The lone unauthenticated method (`network/connect`) is
     `requires: []`. A server→client reverse callback (the app serves
     it, the server does not gate it) is also `requires: []`. Omitting
     this key fails TS2741. `requires` is the ONE authority axis — the
     client groups partition on its head, the server stacks one
     `RpcMiddleware` per element, and each element folds its `errors`
     into the wire error union. There is no `callablePrincipal` /
     `requiresActive` / `caps` field.
   - `errors`: REQUIRED — the handler-domain error classes from step
     3. `[]` if the handler raises none. Omitting fails TS2741.

5. **Add the contract JSDoc above the `defineRpc` call** for a cold
   reader: what it does, the principal (`AgentPrincipal` /
   `AppPrincipal` head, plus `AgentClaimed` when present), params,
   result, the caps it runs (and their order), and the errors it raises.
   Use `@error ClassName when ...` lines — the Mintlify generator reads
   these, and the JSDoc IS the source of truth for the reference page.

6. **Add the descriptor to the layer's `<layer>RpcMethods` catalog**
   (e.g. `taskRpcMethods` in `task/methods.ts`), and to the
   agent/app-callable partition if the layer splits its outbound
   catalog. The root `rpc-registry.ts` re-aggregates into `rpcMethods`
   automatically — the wire error union, client-group typing, and
   encode/decode all derive from the descriptor with no further wiring.

7. **If the method needs a NEW capability requirement**, add its
   runtime:
   - Declare the cap `Context.Tag` (its value type + a
     `static get errors()` tuple of the wire errors its proof can fail
     with). Task caps live in `task/capabilities/`.
   - Add its `RpcMiddleware.Tag` and register it in BOTH
     `requirementMiddleware` (the runtime map) and
     `MiddlewareRequirementKey` (the key union) in
     `transport/cap-middlewares.ts`, then add `typeof YourCap` to the
     `CapabilityRequirement` union in `transport/requirements.ts`. The
     map is TOTAL over `MiddlewareRequirementKey`, so a cap registered
     without a middleware fails the `satisfies` — and a cap listed in a
     descriptor's `requires` but absent from `CapabilityRequirement`
     fails to COMPILE at the `defineRpc` call (it is not a
     `Requirement`). The `cap-middlewares.types-check.ts` canaries pin
     this; there is no boot-time gating walk.
   - Implement the cap's `obtain`/derive in `@moltzap/server-core`
     (`app/capability-middlewares.ts`) — the per-socket Layer that
     resolves the proof. The protocol declares WHICH proof + WHICH
     errors; the server provides the runtime (one-way protocol→server
     edge).

   Reusing an existing cap (most methods do) skips this entire step —
   just list the tag in `requires`.

8. **Implement the handler** in `@moltzap/server-core` and add it to
   the exhaustive handler map (`app/native-handlers.ts`,
   `serverNativeHandlers`). Omitting the key fails TS2741 — the
   `native-handlers.types-check.ts` canary pins that the map's keys
   exactly equal the engine group's WS-handled member tags. The handler
   reads each declared cap's proof off Context (`yield* TagName`); the
   per-method middleware provides it, so the proof never leaks as a
   residual requirement on the bound Layer.

9. **Run `pnpm docs:generate`** from the package root. The generator
   produces `docs/protocol/methods/<name>.mdx` from the descriptor +
   JSDoc; CI runs `pnpm docs:check:drift` to verify no hand edits to
   generated files.

10. **Add a canary** only if the method pins a type-level invariant the
    runtime never re-checks (a new wire-name brand, an exhaustive union
    arm, a callable-partition membership). Membership/cardinality
    invariants go in a runtime `*.test.ts` instead — `expect` cannot be
    vacuous (see the type-tests convention below).

**Derives automatically — you do NOT wire these by hand:** the wire
`error` union (principal-gate ∪ each requirement's errors ∪ handler
errors, deduped, `_tag`-discriminated), the client-group typing
(agent/app/server partition off the `requires` head), the
encode/decode/validators, and the `rpcMethods` aggregate.

## Notification methods

Same recipe with `defineNotification({ name, params })` instead of
`defineRpc`. Notifications are fire-and-forget — no `id`, no
response. Server-emitted notifications live in the task / network /
app layer files. Add to the layer's `<layer>Notifications` array.

## Conventions

Schema authoring:
- Use `Schema.Struct({ ... })`. Excess-key rejection is NOT on the
  struct shape (it strips by default); it is enforced at decode via
  `STRICT_DECODE` (`{ onExcessProperty: "error" }`) — see the
  `closedStruct` / `STRICT_DECODE` glossary entry.
- Use `stringEnum(["a", "b"])` instead of
  `Schema.Union(Schema.Literal("a"), Schema.Literal("b"))` — same wire
  shape, simpler schema.
- Use `brandedId("FooId")` for UUID string fields; `formatString`
  for non-branded `uuid`/`uri`/`date-time` fields. Use
  `brandedString` / `brandedNumber` for non-UUID branded primitives.
- Bounded integers: `Schema.Number.pipe(Schema.int(),
  Schema.greaterThanOrEqualTo(n))` — the INLINE form. `Schema.Int`
  hoists a `$defs`/`$ref` in `JSONSchema.make` that the docs walker
  can't dereference.

Wire frames:
- Request / response / notification frames are standard JSON-RPC
  objects. Do not add custom `type`, `direction`, `event`, or
  `data` envelope fields.
- Canonical decode entry points: `decodeServerInbound(json)`
  (client-side; expects responses, server-initiated callbacks, and
  notifications) and `decodeClientInbound(json)` (server-side;
  expects client requests, responses, and notifications). Both
  fail closed with `MalformedFrameError`.
- Encode via per-definition methods on each `RpcDefinition` /
  `NotificationDefinition`: `def.encodeRequest(id, params)`,
  `def.encodeResponse(id, result)`, `def.encode(params)`.
  Method-agnostic error responses go through
  `encodeErrorResponse(id, error)`.

Handlers (consumed from `@moltzap/server-core`):
- Bind a server handler with the `handler(definition, fn)` factory.
  One handler type, one factory — no per-method type parameter.
- Type-only payload accessors: `ParamsOf<D>`, `ResultOf<D>`,
  `NotificationParamsOf<D>` (conditional types over the descriptor).
  There is no runtime `Params` / `Result` property.

Errors:
- Tagged errors carry `static readonly code` + `static readonly
  message` and self-register via `registerErrorClass` at module
  load. The client reconstructs typed errors from wire codes via
  the registry (`Effect.catchTag("Foo", ...)` works).
- Cross-cutting errors (`UnauthorizedError`, `ForbiddenError`,
  `NotFoundError`, `ConflictError`, `InvalidParamsError`,
  `MalformedFrameError`) live in
  `src/transport/wire-errors.ts`. Domain-specific tagged errors
  live in the owning layer's `methods.ts` (e.g.
  `TaskClosedError` in `src/task/tasks.ts`).
- `JSON_RPC_RESERVED_CODES` covers the five JSON-RPC 2.0 reserved
  codes (-32700, -32600, -32601, -32602, -32603) only. Every
  other code lives in the runtime registry; there is no central
  `ErrorCodes` table.

Type-tests (`*.types-check.ts` canaries):
- These files are never executed; they exist so the COMPILER enforces an
  invariant the runtime never re-checks (a brand seal, an exhaustive
  union, a not-exported symbol, a handler R-channel bound). `tsc --build`
  IS the test runner. They sit in `src/**` (not `*.test.ts`) so the
  package's standard `tsc` pass compiles them.
- Two assertion shapes. POSITIVE: `type _X = Expect<Equal<A, B>>` where
  `Expect<T extends true> = T` — if `A` and `B` diverge, `Equal` resolves
  to `false`, `false` violates `extends true`, and tsc fails with TS2344.
  (A bare `type _X = Equal<A, B>` with NO `Expect` wrapper pins NOTHING —
  it just names a `true | false` type. That vacuous shape is why
  `task-d3-cutover.types-check.ts` was deleted.) NEGATIVE: an
  `@ts-expect-error` on a line that MUST fail to compile (an illegal
  import, an out-of-bound assignment); if the line ever starts compiling,
  the directive goes unused and tsc fails with TS2578.
- Each file header names the invariant + WHY it is compile-time-only +
  how to read its positive/negative controls. When the live type moves,
  update the canary's assertion deliberately — a green canary after a
  shape change means the canary stopped guarding.
- When the invariant is array MEMBERSHIP or a runtime value (cardinality,
  disjointness, a literal constant), prefer a runtime `*.test.ts` over a
  canary: `expect` cannot be vacuous, a type alias can.

## Dependencies
- None on other workspace packages (this is the leaf dependency)

## Client-side conformance wrapper template (AC22)

External consumers (e.g. `moltzap-arena`) that want to run the
client-side conformance suite against their real MoltZap WS client
drop a ~20-line wrapper matching this shape. The only package-specific
line is the factory import.

```ts
// packages/<your-pkg>/src/__tests__/conformance/suite.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Exit } from "effect";
import { clientConformance } from "@moltzap/protocol/testing";
// In-repo consumers: @moltzap/client/test-utils
// or @moltzap/openclaw-channel/test-support
// or @moltzap/nanoclaw-channel/test-support
import { createMoltZapRealClientFactory } from "@moltzap/client/test-utils";

describe("my-package client-side conformance", () => {
  it("passes", async () => {
    const factory = createMoltZapRealClientFactory({
      agentKey: "test-key",
      agentId: "test-id",
    });
    const exit = await Effect.runPromiseExit(
      clientConformance.runClientConformanceSuite({
        realClient: factory,
        toxiproxyUrl: process.env.TOXIPROXY_URL ?? null,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit) && exit.value.failed.length > 0) {
      throw new Error(`${exit.value.failed.length} properties failed`);
    }
  }, 600_000);
});
```

Arena (v2 per spec amendment #200 N8) copies this template directly.

## Glossary

- **Effect `Schema`** — the runtime schema library (`effect`'s
  `Schema` module) the protocol uses. Schemas are values —
  `Schema.Struct({...})` builds a schema you decode via
  `Schema.decodeUnknownEither(schema)(value, { onExcessProperty:
  "error" })` and read the static type off of via
  `Schema.Schema.Type<typeof Schema>`. Replaced TypeBox + AJV (both
  deleted); the same `Schema` engine decodes wire frames AND the rest
  of the runtime. Branded ids are `Schema.brand` (`brandedId`); the
  three wire string formats (`uuid`/`uri`/`date-time`) are
  `Schema.pattern` / `Schema.filter` refinements (`brandedString` /
  `formatString`), replacing AJV's `FormatRegistry`.
- **`closedStruct` / `STRICT_DECODE`** — `Schema.Struct` STRIPS excess
  keys by default (`onExcessProperty:"ignore"`); the former
  `new Ajv({strict:true})` + `additionalProperties:false` REJECTED
  them, and the conformance `extra-property` / `oversized` mutators
  assert frames with an extra key still FAIL. `STRICT_DECODE`
  (`{ onExcessProperty: "error" }`, `schema-primitives.ts`) restores
  that rejection at every wire decode; `closedStructGuard(schema)`
  wraps it as a boolean type guard (the former `ajv.compile` strict
  validators: `validateAgent`, `validateMessage`, …).
- **Descriptor** — A frozen `RpcDefinition` or
  `NotificationDefinition` produced by `defineRpc` /
  `defineNotification`. Carries the Effect `Schema`, decode-time
  validators, encoders, and the `requires` authority list for one wire
  method. Every RPC slot is required; the dispatcher fails closed when
  no handler is bound.
- **Requirement** — One entry in a descriptor's `requires` list: a
  principal requirement (`AgentPrincipal` | `AppPrincipal`), the
  agent-only `AgentClaimed` refinement, or a capability tag. Each is a
  `Context.Tag` carrying a `static get errors()` tuple. `Requirement` is
  the genuine closed union of these tag classes (`transport/requirements.ts`),
  so the engine binding stacks one middleware per entry via the TOTAL
  `requirementMiddleware` map and a descriptor naming an unregistered
  requirement fails to COMPILE.
- **Capability tag** — A `Context.Tag` whose value carries a runtime
  authority proof, listed in a method's `requires` after the principal.
  The server declares each as an `RpcMiddleware.Tag` (its impl Layer in
  `@moltzap/server-core/src/app/capability-middlewares.ts` runs the
  `obtain`/derive), so handler bodies just `yield* TagName` instead of
  hand-piping `Effect.provideServiceEffect`. The middleware `provides`
  the proof, so it never leaks as a residual requirement on the Layer.
- **Originator** — The outbound half of a `Connection`. Owns the
  per-connection pending-request map and the request-id counter for
  outbound `call(...)` invocations. Used in both directions — for
  client → server RPCs and for server → client task-callbacks.
- **Conformance suite** — Property-based tests over the wire
  protocol. Lives in `src/testing/conformance/`; consumed by
  server, client, and external repos. Properties exercise
  invariants any compliant client/server pair must satisfy.
- **Divergence proof** — Executable test that asserts a conformance
  property *would fail* if the implementation intentionally
  regressed. Proves the property has teeth.
- **Arbitrary** — A fast-check generator (`fc.Arbitrary<T>`) that
  produces a stream of random values for property tests. Lives in
  `src/testing/arbitraries/`. Generators here cover frames, params,
  IDs, and structured protocol shapes.
- **Model** — A reference state machine in `src/testing/models/`.
  Conformance properties compare the implementation's observable
  behavior against the model's prediction.
- **Toxics** — Toxiproxy fault-injection adapters in
  `src/testing/toxics/`. Drive adversity-tier conformance
  properties (latency, slow-close, reset-peer, slicer-framing) by
  shaping the wire between TestClient and TestServer.
- **Task-callback method** — An RPC the *server* calls *into* a
  client. A restricted subset of `rpcMethods` (e.g.
  `dispatch/authorize`, `messages/authorize`); the client's
  `decodeServerInbound` rejects any other method shape as
  `MalformedFrameError`.
- **Registered tagged error** — A `Data.TaggedError` class with a
  `static readonly code` self-registered via `registerErrorClass`
  at module load. Lets the client reconstruct a typed error
  instance from a wire `code` for `Effect.catchTag(...)` use.
