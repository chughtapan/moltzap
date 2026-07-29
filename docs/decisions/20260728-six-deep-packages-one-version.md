---
status: accepted
date: 2026-07-28
decision-makers: Tapan Chugh
---

# V2 has six deep packages and one Moltzap version

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-six-deep-packages-one-version).

## Context and Problem Statement

Earlier plans proposed five ports and several mechanism-shaped packages.
That split stable abstractions across shallow forwarding layers and
risked production binaries depending upward on testing machinery.

## Decision Outcome

Chosen: **exactly six networking-vernacular deep packages**:

| Package | Dependencies | Ownership |
|---|---|---|
| `identity` | none | L1 contracts, Registry HTTP/PostgreSQL, `moltzap-directory` |
| `transport` | `identity` | L2 contracts and Router, `moltzap-router` |
| `transcript` | identity and transport contracts | L3 records and Ledger HTTP/PostgreSQL, `moltzap-ledger` |
| `endpoint` | identity, transport, transcript | Engine, SQLite, daemon MCP, CLI, `moltzap-agentd`, `moltzap` |
| `simulator` | identity and endpoint public capabilities | Portable kernel, runtime roster, EventCatalog, RunLedger, root-exported StackProvider contract |
| `testbed` | all five | StackProvider Live Layer, platform acquisition, fault layers, substitutes, external processes, black-box subjects |

Identity, transport, transcript, and endpoint export `.` and
`./server`. Simulator exports `.`, `./adapter`, and `./ledger`.
Testbed exports `.`. Production packages never depend on simulator or
testbed, and `v2/*` imports nothing from `packages/*`.

Wire, protocol, endpoint-core, daemon-api, CLI, harness-adapter, and
conformance are not packages. Their implementation lives behind the
owning deep abstraction or in existing external consumers.

One CalVer value in `v2/VERSION` must exactly match all six package
manifests and Moltzap wire compatibility. MCP revision and simulator
definition, event, and RunLedger persisted-schema versions remain
independent.

## Consequences

Each production package owns the concrete service behind its
abstraction. Testbed cannot become a production dependency. When the
packages are scaffolded in Phase 2, CI must enforce the dependency
graph, exports, binaries, v1 isolation, and shared Moltzap version.
