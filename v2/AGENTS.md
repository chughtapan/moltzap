# moltzap v2 track

Extends the workspace-root `AGENTS.md`; governs work under `v2/*` and
on the `v2` branch.

## Authority and reading order

Read these sources in order. A lower source explains or implements a
higher one and must not contradict it.

1. `AGENTS.md` and `v2/VISION.md` — project law and the layer
   constitution.
2. Current ADR outcomes in `docs/decisions/`—accepted records and the
   explicitly retained portions of partially-superseded records—
   beginning with `20260728-gate-1-architecture-freeze.md`.
3. Normative chapters in `docs/spec/`: the frozen Gate 1 contract and
   accepted post-Gate-1 targets explicitly indexed as such in
   `docs/spec/README.md`.
4. `docs/architecture/` — orientation and the durable execution plan.
5. `docs/decision-evidence/` and `v2/inputs/` — decision context, review
   evidence, research, audits, and source provenance. These explain
   authority but never create it. `v2/drafts/` is historical input only.

The freeze manifest assigns every Gate 1 decision a `G1-DEC-NNN`
identifier and maps it to its normative owner and acceptance evidence.
An accepted post-Gate-1 chapter does not alter Gate 1 completion or
authorize implementation before its Gate 1 prerequisites and a separately
recorded implementation-scope decision.
No implementation may rely on a decision found only in chat, an issue,
an agent-private directory, a fully superseded record, or a portion
explicitly marked replaced.

## Structure

V2 has exactly six deep packages:

| Package | Owns |
|---|---|
| `identity` | L1 contracts, Registry client, PostgreSQL Registry server, `moltzap-directory` |
| `transport` | L2 contracts, Router client, in-memory Router server, `moltzap-router` |
| `transcript` | L3 record contracts, Ledger client, PostgreSQL Ledger server, `moltzap-ledger` |
| `endpoint` | endpoint protocol engine, SQLite state, daemon MCP, CLI, `moltzap-agentd`, `moltzap` |
| `simulator` | portable code-first kernel, runtime roster, event catalog, simulation `RunLedger` |
| `testbed` | platform acquisition, external processes, fault layers, substitutes, black-box subjects |

The production dependency graph is:

```text
transport  -> identity
transcript -> identity + transport contracts
endpoint   -> identity + transport + transcript
simulator  -> identity + endpoint public capabilities
testbed    -> identity + transport + transcript + endpoint + simulator
```

`transcript` may depend on the transport contracts needed to retain L2
evidence; it never depends on a Router implementation. `simulator` and
`testbed` are never production dependencies. `wire`, `protocol`,
`endpoint-core`, `daemon-api`, `cli`, `harness-adapter`, and
`conformance` are not packages.

All six manifests and the Moltzap wire compatibility value match the
exact CalVer in `v2/VERSION`. MCP `2026-07-28` and simulator
definition/event/RunLedger persisted-schema versions are independent.

## Implementation rules

- **Gate 0 first.** No simulator landing, v2 scaffolding, or product
  implementation begins until the repository-native architecture freeze
  is contradiction-free, mechanically checked, and passes the root
  blind teammate review gate.
- **Spec first.** Do not write implementation code ahead of the
  normative chapter and current ADR outcome that govern it.
- **Deep modules.** Each package owns its public contract, production
  implementation, binary where applicable, and tests. Keep mechanisms
  private; do not create pass-through packages or accessor layers.
- **Zero v1 imports.** Nothing under `v2/` imports a workspace module
  whose source resolves under `packages/`, or reaches into that tree by
  relative path. V2 packages may import one another only along the
  frozen v2 DAG. Port behavior by reimplementation against v2
  contracts. Enforce both rules in CI.
- **Effect at the edge and through the core.** Define validated boundary
  models with Effect Schema, model dependencies as cohesive services,
  compose resource-owning implementations with scoped Layers at process
  roots, use Effect SQL and Migrator for Registry/Ledger/daemon storage,
  and keep typed failures rather than throwing across boundaries.
- **Network boundaries stay separate.** Registry, Router, and Ledger are
  independent HTTP processes. Router and Ledger are siblings; endpoints
  coordinate them. The daemon's loopback MCP surface is a local runtime
  boundary, not the Router data plane.
- **Endpoint authority.** Only endpoints interpret bodies, run protocols,
  apply L4/L5/L7 rules, and decide which certificates to sign. Router is
  opaque delivery; Ledger is mechanical atomic storage.
- **One production stack.** The simulator surrounds the same production
  capabilities as a system driver. Testbed adds acquisition and faults;
  it never reimplements or wraps an umbrella production server.
- **Case studies remain consumers.** `moltzap-propagation-bench`,
  `moltzap-arena`, OpenClaw, and NanoClaw exercise public interfaces.
  A consumer that must reach into v2 internals exposes an interface gap.

## Simulator provenance gate

The v2 simulator port may start only from the immutable SHA recorded in
`v2/inputs/simulator-handoff-20260728.md`. Until the source rewrite is
fully tracked, rebased onto current `main`, constitution-aligned, landed,
and green under non-vacuous architecture, build, type, lint, unit, and
evaluation checks, that manifest remains `pending` and its SHA remains
unset. Never copy from or edit the dirty source worktree.

Preserve the landed kernel's `Simulator.define`, closed EventCatalog,
typed `RunLedger`, scoped runtime roster, and private lifecycle engine.
Replace v1-facing contracts with v2 public capabilities. The simulator
`RunLedger` is run evidence; the product `Transcript` is society state.
They are different stores and types.
