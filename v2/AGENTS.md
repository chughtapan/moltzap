# moltzap four-layer cutover track

Extends the workspace-root `AGENTS.md`. This directory now owns the
replacement constitution, historical inputs, and handoff evidence. Final
executable products live under `packages/*`.

## Authority and reading order

Read these sources in order. A lower source explains or implements a higher
one and must not contradict it.

1. `AGENTS.md` and `v2/VISION.md` — project law and the constitution.
2. Current ADR outcomes in `docs/decisions/` — accepted records and the
   explicitly retained portions of partially superseded records — beginning
   with `20260811-four-layer-endpoint-replicated-harness.md`.
3. Normative chapters in `docs/spec/`.
4. `docs/architecture/` — orientation and execution material.
5. `docs/decision-evidence/`, `v2/inputs/`, and `v2/drafts/` — provenance and
   historical input, never implementation authority.

The current trace tables assign stable `G1-DEC-NNN` identifiers to normative
owners and acceptance evidence. No implementation may rely on a decision found
only in chat, an issue, private state, a fully superseded record, or a replaced
portion of a partially superseded record.

## Final product graph

The cutover finishes with exactly seven workspace products:

| Directory | Package | Direct production dependencies |
|---|---|---|
| `packages/identity` | `@moltzap/identity` | none |
| `packages/router` | `@moltzap/router` | identity |
| `packages/client` | `@moltzap/client` | identity, router |
| `packages/openclaw-channel` | `@moltzap/openclaw-channel` | client |
| `packages/nanoclaw-channel` | `@moltzap/nanoclaw-channel` | client |
| `packages/simulator` | `@moltzap/simulator` | identity, router, client |
| `packages/evals` | `@moltzap/evals` | client, simulator |

The packages take these names immediately. There are no generation aliases,
compatibility shims, umbrella protocol/server packages, product Ledger,
transcript package, profile package, or standalone testbed. Production
packages do not depend on simulator or evals. Runtime adapters depend on the
Client root only.

Image construction and deployment assembly are root-owned artifact work, not
runtime dependency edges. Simulator `RunLedger` remains run evidence and is
not a product conversation store.

## Implementation rules

- **Authority first.** A changed behavior or public boundary needs a current
  ADR outcome, normative owner, stable trace row, and accepted blind-review
  candidate before implementation.
- **Use the final homes.** Move accepted Identity and Router implementations
  directly into `packages/identity` and `packages/router`. Do not add code to a
  temporary `v2/*` package or retain a forwarding package.
- **Deep ownership.** Each package owns its public contracts, production
  implementation, process binary where applicable, configuration, tests, and
  migrations. Mechanisms and private wire codecs remain private.
- **Representation stays owned.** Identity owns AgentCard and authenticated
  HTTP representation. Router owns its opaque message, poll, cursor, and
  instance representation. Client owns conversations, certified records,
  durability evidence, endpoint storage, catch-up, tasks, trust, and daemon
  MCP representation. Do not create a cross-package codec catalog.
- **Effect throughout.** Boundary values use Effect Schema. Dependencies are
  cohesive Effect services; resource implementations compose through scoped
  Layers at process roots; expected failures remain typed.
- **Network boundaries remain separate.** Registry and Router are independent
  HTTP processes. Each endpoint daemon owns local storage and speaks those
  protocols. Its one loopback MCP endpoint is a local runtime boundary, not a
  network plane.
- **Explicit daemon configuration.** A daemon binds only to the fixed loopback
  address `127.0.0.1` and receives its state directory, MCP port, Registry
  origin and admission material, and Router origin explicitly. It has no
  profile selector, profile file, bespoke CLI, Unix socket, stdio server,
  second MCP process, address override, or bind fallback.
- **Consumer-only adapters.** OpenClaw and NanoClaw use the public
  `HarnessEndpoint` capability or its MCP transport. They do not import Identity,
  Router, Client internals, or one another. They conform to stock host adapter
  APIs and do not patch host inboxes, ACLs, sessions, prompts, output parsers,
  or sandbox drivers.
- **Addressed Client boundary.** Applications provide explicit
  `@<AgentName>` or fixed-member `group:@<AgentName>,...` inputs. Client
  resolves names and canonicalizes group membership before protocol processing. Each
  `HarnessEndpoint.send` invocation creates one Client-minted post and returns
  only after local certification. `HarnessEndpoint.messages` yields
  addressed direct or group deliveries whose transport acknowledgment follows
  successful completion of the stock host callback. Search, history, status,
  and registration stay on MCP.
- **Closed Client protocol.** Client privately owns deterministic conversation
  identity, GENESIS/POST evidence, author-inclusive post thresholds,
  32-member and 32,768-byte content limits, nested `SignedMessage` transport,
  Router anchors, durability, catch-up, and pending delivery state.
- **One simulator.** Preserve every compatible latest-`main` simulator facade
  and behavior while replacing production-stack dependencies. Remove
  content-free open, unaddressed send, message-only receive, runtime Router
  authority, and persisted Router-order claims; do not preserve them through
  inert fields, lazy compatibility behavior, or hidden raw Router access. With
  no active link fault, delivery preserves Router message bytes and recipient
  order. An explicitly activated directed fault may drop, delay, hold, or
  reorder post-Router delivery for endpoint-recovery testing. Its mechanism is
  private Simulator infrastructure, never a Router or product hook or a
  runtime-facing control surface.
- **Delete displaced code.** Once a final owner is usable, remove the old
  protocol, server, profile, CLI/socket, central-Ledger, `v2/*` implementation,
  and testbed code in the same migration lane. Do not polish code whose only
  planned outcome is deletion.
- **Keep graphs equal.** Package manifests, TypeScript references, Nx project
  dependencies, architecture checks, release configuration, Knip, aliases,
  generated docs, and CI must express the same seven-package graph.

## Remaining implementation gate

Package publication and version policy remain unselected. The Client protocol
and Simulator compatibility and link-fault decisions are admitted
implementation inputs, not remaining questions. Do not infer a release policy
from their cutover or preserve removed behavior behind a compatibility shim.

## Verification

Run work through `pnpm nx`. A structural lane passes only when its package
targets, architecture graph, import boundaries, packing probes, and relevant
documentation checks are non-vacuous. Before final merge, run the full build,
typed lint, tests, generated-doc checks, package-install probes, and absence
checks for every retired public surface.
