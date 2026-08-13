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
- **Explicit daemon configuration.** A daemon receives its state directory,
  MCP bind address and port, Registry origin and admission material, and Router
  origin explicitly. It has no profile selector, profile file, bespoke CLI,
  Unix socket, stdio server, second MCP process, or bind fallback.
- **Consumer-only adapters.** OpenClaw and NanoClaw use the public
  `HarnessClient` capability or its MCP transport. They do not import Identity,
  Router, Client internals, or one another.
- **Reduced Client boundary.** Applications mint a `ConversationId` before
  START and use it as the only public start/retry identity. An identical start
  intent resumes; changed peers or content conflict. `HarnessClient.start` and
  a turn-bound, content-only `reply` return only after local certification and
  expose no result value. Each turn projects one certified action from its
  current conversation. Search, history, status, registration, and proof
  inspection stay on MCP. `TxnId` does not exist; BEGIN-message digests,
  `ActionHash`, `RecordHash`, certificates, and recovery state stay behind the
  Client boundary.
- **One simulator.** Preserve every non-conflicting latest-`main` simulator
  facade and behavior while replacing production-stack dependencies. The
  explicitly deferred authority conflicts are not implemented through inert
  fields, lazy compatibility behavior, or hidden raw Router access.
- **Delete displaced code.** Once a final owner is usable, remove the old
  protocol, server, profile, CLI/socket, central-Ledger, `v2/*` implementation,
  and testbed code in the same migration lane. Do not polish code whose only
  planned outcome is deletion.
- **Keep graphs equal.** Package manifests, TypeScript references, Nx project
  dependencies, architecture checks, release configuration, Knip, aliases,
  generated docs, and CI must express the same seven-package graph.

## Remaining implementation gates

The Client boundary above is selected. Simulator work that reaches one of
these remaining questions waits for its named normative decision:

- the five simulator conflicts involving content-free open, generic send,
  message-only receive, runtime Router authority, and persisted Router-commit
  semantics; and
- package publication and version policy.

Do not infer an answer from an execution handoff or preserve conflicting
behavior behind a compatibility shim.

## Verification

Run work through `pnpm nx`. A structural lane passes only when its package
targets, architecture graph, import boundaries, packing probes, and relevant
documentation checks are non-vacuous. Before final merge, run the full build,
typed lint, tests, generated-doc checks, package-install probes, and absence
checks for every retired public surface.
