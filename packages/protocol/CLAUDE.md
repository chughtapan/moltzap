# @moltzap/protocol

Effect-`Schema` definitions, descriptor-backed RPC/notification
definitions, and decode-time validators for the MoltZap JSON-RPC
protocol. Source of truth for all wire message types. Leaf of the
workspace dependency DAG.

The wire DIALECT is unchanged JSON-RPC-2.0 (`{jsonrpc:"2.0", id,
method, params}` / `-32xxx` error codes). #723 migrated the validation
ENGINE off TypeBox + AJV onto Effect `Schema` (`Schema.Struct` /
`Schema.Union` / `Schema.brand`, decoded via `Schema.decodeUnknownEither`)
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
  Type canaries: `src/task/task-conversation-family.types-check.ts`
  + `src/task/task-d3-cutover.types-check.ts`.
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

The recipe; every new RPC follows it:

1. **Pick the layer.** Per the DAG: `transport` < `identity` <
   `network` < `task` < `app`. A method may reference types from
   layers at-or-below; never above. Put it in the lowest layer that
   covers it.
2. **Declare schemas** in the layer's `methods.ts` (or
   `tasks.ts` / `messages.ts` for task subfamilies). Use Effect
   `Schema`: `Schema.Struct({ ... })`. Branded ids via
   `brandedId("FooId")`; enums via `stringEnum(["a", "b"])`; bounded
   integers via `Schema.Number.pipe(Schema.int(),
   Schema.greaterThanOrEqualTo(n))` (the inline form — NOT
   `Schema.Int`, which hoists a `$defs`/`$ref` the docs walker can't
   read). `Schema.Struct` STRIPS excess keys by default; AJV-strict
   parity (reject excess) is enforced at the DECODE boundary, where
   every wire decode passes `{ onExcessProperty: "error" }` (the
   `STRICT_DECODE` const) — see `transport/dispatch.ts` and the
   `closedStructGuard` validators, NOT the `Schema.Struct` shape
   alone.
3. **Define the descriptor** with `defineRpc({ name, params, result,
   capabilities? })`. Add it to the layer's
   `<layer>RpcMethods` array (e.g., `taskRpcMethods` in
   `task/methods.ts`). The root `rpc-registry.ts` re-aggregates.
4. **Add JSDoc above the `defineRpc` call** describing the method
   semantics, parameters, and failure modes. Use `@error
   ClassName when ...` for documented failure types — the Mintlify
   generator reads these. The JSDoc IS the source of truth for the
   protocol reference page.
5. **Declare tagged errors** the handler will raise. Each error
   class extends `Data.TaggedError`, carries
   `static readonly code` and `static readonly message`, and
   self-registers via `registerErrorClass` at module load. Wire
   codes outside `JSON_RPC_RESERVED_CODES` (-32700..-32603) come
   from the per-layer ranges documented near the registry call
   sites.
6. **Run `pnpm docs:generate`** from the package root. The
   generator produces `docs/protocol/methods/<name>.mdx` from the
   descriptor + JSDoc. CI runs `pnpm docs:check:drift` to verify
   no hand edits to generated files.
7. **Implement the handler** in `@moltzap/server-core`. The
   server's binding wrappers enforce the layer-tag allowlist; any
   per-frame capability is declared at the binding site as a
   `CapabilityMiddleware` (#705 HALF-2 — capabilities are no longer
   descriptor metadata) and woven by the binding's `weaveCaps` (see
   `packages/server/src/app/capability-middlewares.ts`).

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
  `Schema` module) the protocol uses post-#723. Schemas are values —
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
  `defineNotification`. Carries the Effect `Schema`,
  decode-time validators, and encoders for one wire method (#705
  HALF-2 — capabilities are NO LONGER on the descriptor; they are
  declared at the server binding site). Every RPC
  slot is required; the dispatcher fails closed when no handler is bound.
- **Capability tag** — A `Context.Tag` whose value carries a runtime
  authority proof. The server declares each as a `CapabilityMiddleware`
  at the binding site and weaves it per-frame, so handler bodies just
  `yield* TagName` instead of hand-piping `Effect.provideServiceEffect`.
  Pattern documented in
  `@moltzap/server-core/src/app/capability-middlewares.ts`.
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
