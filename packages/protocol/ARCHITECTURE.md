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
│   ├── method.ts              # defineRpc, defineNotification, RpcDefinition
│   ├── wire-errors.ts         # Tagged-error registry, JSON_RPC_RESERVED_CODES
│   ├── rpc-errors.ts          # NotConnectedError, RpcServerError
│   ├── rpc-groups.ts          # decodeRpcRequest, decodeNotification over a method group
│   ├── json-rpc-server.ts     # makeJsonRpcServer, handler(), handleJsonRpcRequest
│   └── json-rpc-client.ts     # makeJsonRpcClient, pending-call map, call/resolve
│
├── identity/               # Agents, users, sessions, attestation, contact policy
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
| `taskCallbackMethods` | rpc-registry | Subset: methods the server calls *into* the client |
| `decodeServerInbound` / `decodeClientInbound` | rpc-registry | Tagged-union frame decoders, fail-closed |
| `defineRpc` / `defineNotification` | transport/method | Descriptor factories used by domain layers |
| `makeJsonRpcServer` / `makeJsonRpcClient` | transport | Runtime endpoints |
| `Agent*`, `User*`, `Session*` | identity | Identity primitives + auth flows |
| `Conversation*`, `Message*`, `TmDecision*` | task | Task-layer state |
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
| How wire methods are defined and validated | [01 — Method-definition pipeline](docs/architecture/01-method-definition.md) |
| Decoding inbound frames (both sides) | [02 — Frame decode pipeline](docs/architecture/02-frame-decode.md) |
| Server-side request handling | [03 — Server request handling](docs/architecture/03-server-request-handling.md) |
| Client-side RPC call lifecycle | [04 — Client call lifecycle](docs/architecture/04-client-call-lifecycle.md) |
| Notification fan-out | [05 — Notification fan-out](docs/architecture/05-notification-fanout.md) |
| End-to-end `messages/send` walk-through | [06 — End-to-end messages/send](docs/architecture/06-end-to-end-messages-send.md) |
| Server-initiated callbacks (e.g. dispatch/authorize) | [07 — Server-initiated callbacks](docs/architecture/07-server-initiated-callback.md) |
| Tagged error registry mechanics | [08 — Tagged error registry](docs/architecture/08-tagged-error-registry.md) |
| Layer DAG enforcement | [09 — Layer DAG](docs/architecture/09-layer-dag.md) |
| Conformance suite mechanics | [10 — Conformance suite](docs/architecture/10-conformance-suite.md) |

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
