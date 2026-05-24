# Architecture — `@moltzap/protocol`

Wire-level protocol surface for MoltZap. Pure types, schemas, RPC method
definitions, and the runtime JSON-RPC server/client implementations. No
transport, no I/O — every other package depends on this one.

## 1. Project Structure

```
packages/protocol/src/
├── schema-primitives.ts    # brandedId, brandedString, stringEnum, DateTimeString
├── version.ts              # PROTOCOL_VERSION
├── rpc-registry.ts         # Aggregated method + notification tables; decoders
│
├── transport/              # Wire-frame layer (no domain semantics)
│   ├── wire.ts                # Ajv, JSON-RPC frame schemas, encoders, decodeFrame
│   ├── method.ts              # defineRpc, defineNotification, RpcDefinition (optional + capabilities)
│   ├── wire-errors.ts         # Tagged-error registry, JSON_RPC_RESERVED_CODES
│   ├── rpc-errors.ts          # NotConnectedError, RpcServerError
│   ├── rpc-groups.ts          # decodeRpcRequest, decodeNotification over a method group
│   ├── handlers.ts            # ServerHandlers / AgentClientHandlers / TaskMasterHandlers (typed catalogs)
│   ├── capabilities.ts        # CapabilityProviderTable, CapabilityDescriptor, CapabilitiesOf
│   ├── defaults.ts            # FailClosedDefault taggedEnum, forbidden / noOpNotification sentinels (per-slot fail-CLOSED defaults)
│   ├── connection.ts          # ServerConnection / AgentClient / TaskMaster types + factories
│   ├── dispatch.ts            # build{Server,AgentClient,TaskMaster}Dispatcher (static-table dispatch + capability auto-provision)
│   ├── originator.ts          # makeOriginator — scope-bound outbound RPC + pending-call registry (internal helper)
│   └── typed-dispatcher.types-check.ts  # 6 type canaries on the live typed surface
│
├── identity/               # Agents, users, sessions, contact policy
├── network/                # Ping, presence, connection liveness, actor-model types
├── task/                   # Conversations, messages, dispatch, TM authority
├── app/                    # AppHost RPCs (apps/register, dispatch/*, hooks)
│
├── testing/                # Conformance suite, arbitraries, toxics, divergence proofs
│   ├── conformance/           # Property-based suite (executable + runner)
│   ├── arbitraries/           # fast-check generators
│   ├── models/                # Reference state machines
│   └── toxics/                # Toxiproxy fault-injection adapters
│
└── index.ts                # Public barrel: `export * from "./{layer}/index.js"`
```

Each domain layer (`identity`, `network`, `task`, `app`) has a self-contained
`index.ts` re-exporting its public surface; the root barrel composes them.

## 2. Public Surface

| Export | Layer | Purpose |
|---|---|---|
| `PROTOCOL_VERSION` | root | Wire-format version constant |
| `rpcMethods` | rpc-registry | All C↔S request methods (frozen array) |
| `notificationDefinitions` | rpc-registry | All S↔C notifications |
| `decodeServerInbound` / `decodeClientInbound` | rpc-registry | Tagged-union frame decoders, fail-closed |
| `makeServerConnection` / `makeAgentClientConnection` / `makeTaskMasterConnection` | transport/connection | Typed-dispatcher factories — one per connection kind |
| `ServerHandlers` / `AgentClientHandlers` / `TaskMasterHandlers` | transport/handlers | Per-kind static handler-table type aliases |
| `CapabilityProviderTable<Caps>` | transport/capabilities | Capability auto-provision table (plumbing-ships-empty until a defineRpc populates `capabilities`) |
| `FailClosedDefault` / `forbidden` / `noOpNotification` | transport/defaults | Per-slot fail-CLOSED default tagged-enum + sentinel values; the same values are both descriptor metadata (`optional: forbidden`) and handler-table sentinels |
| `Agent*`, `User*`, `Session*` | identity | Identity primitives + auth flows |
| `Conversation*`, `Message*`, `TmDecision*` | task | Task-layer state (Conversation row schemas + message payload + TM verdict union) |
| `TaskRequest`, `TaskLeave`, `TaskConversation*` | task | `task/*` + `task/conversation/*` RPC surface |
| `AppId`, `DEFAULT_APP_ID`, `ParticipantNotAdmittedError` | task | Wire-level app brand + participant-admitted invariant tag |
| `Dispatch*`, `App*`, `Hook*` | app | AppHost surface |
| Tagged errors (`HookBlockedError`, `TaskClosedError`, …) | various | Auto-registered into `RegisteredTaggedError` union |

Subpath exports (`./transport`, `./identity`, `./network`, `./task`, `./app`,
`./testing`) let consumers pull only the layer they need.

## 3. Documentation Pipeline

Protocol docs have one source-of-truth chain:

```
packages/protocol/src/**/methods.ts
  -> packages/protocol/src/rpc-registry.ts
  -> packages/protocol/scripts/docs/metadata.ts
  -> packages/protocol/scripts/generate-docs.ts
  -> docs/protocol/{methods,notifications}/
```

The generator is package-owned because it imports protocol descriptors and
maintains protocol-specific prose. The generated MDX stays in root
`docs/protocol/` because that is the Mintlify site tree.

Cold-start rule: edit implementation docs in this package, edit generated
reference prose in `scripts/docs/metadata.ts`, and never hand-edit generated
method/notification pages. Run `pnpm docs:generate`; CI runs
`pnpm docs:check:drift`.

## 4. Communication Flows

| Topic | Document |
|---|---|
| How wire methods are defined and validated | [Method-definition pipeline](docs/architecture/method-definition.md) |
| Decoding inbound frames (both sides) | [Frame decode pipeline](docs/architecture/frame-decode.md) |
| Notification fan-out | [Notification fan-out](docs/architecture/notification-fanout.md) |
| Tagged error registry mechanics | [Tagged error registry](docs/architecture/tagged-error-registry.md) |
| Layer DAG enforcement | [Layer DAG](docs/architecture/layer-dag.md) |
| Conformance suite mechanics | [Conformance suite](docs/architecture/conformance-suite.md) |
| TestClient Stream consolidation | [TestClient Stream consolidation](docs/architecture/test-client-stream-consolidation.md) |
| Task / TaskConversation family (Spec D1) | [Task / TaskConversation family](docs/architecture/task-conversation-family.md) |
| List-RPC cursor pagination | [List pagination](docs/architecture/list-pagination.md) |

The typed dispatcher, originator lifecycle, and worked end-to-end RPC
flow (request handling + server-initiated callbacks) are documented in
the server package, where the only real consumers live. See
`packages/server/docs/architecture/request-response-handling.md` and
`packages/server/docs/architecture/server-initiated-callback.md`. The
protocol-side type-system invariants are exercised by the canaries in
`src/transport/typed-dispatcher.types-check.ts` — the source file is the
contract.

## 5. Dependencies

**Runtime**: `effect`, `@effect/platform`, `@sinclair/typebox`, `ajv`,
`ajv-formats`.
**Internal**: none — protocol is the root of the workspace dependency DAG.
**Consumers**: every other package in `packages/`, plus the arena repo via
submodule + workspace link.

## 6. Tests

- `src/testing/__tests__/` — direct unit tests for protocol-package code.
- `src/testing/conformance/__divergence_proofs__/` — divergence proofs.
- Consumed by `packages/server/src/__tests__/conformance/` (in-process)
  and `packages/client/src/__tests__/conformance/` (over the wire).

## 7. Glossary

- **TM (Task Manager)** — Authority for a task's conversation set.
  Default-TM (UUID-bound) for ordinary DMs/groups; app-bound TM for
  app-moderated tasks.
- **AppHost** — Server-side dispatcher that routes app callbacks
  (`dispatch/authorize`, hook RPCs) to the registered moderator.
- **Descriptor** — A frozen `RpcDefinition` or `NotificationDefinition`
  produced by `defineRpc` / `defineNotification`. Carries the schema,
  validators, and frame encoders for one wire method.
- **Conformance suite** — Property-based tests over the wire protocol.
  Lives in `src/testing/conformance/`; consumed by server, client, and
  external repos.
- **Divergence proof** — Executable test that asserts the conformance
  property *would fail* if the implementation intentionally regresses.
- **Task-callback method** — An RPC the *server* calls *into* a client.
  Restricted subset of `rpcMethods`; the client's `decodeServerInbound`
  rejects any other method shape as `MalformedFrameError`.
- **Registered tagged error** — A `Data.TaggedError` class with a
  `static readonly code` self-registered via `registerErrorClass` at
  module load. Allows the client to reconstruct a typed error instance
  from a wire `code` for `Effect.catchTag(...)` use.
