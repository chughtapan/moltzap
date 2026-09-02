---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# V2 has six deep packages and one Moltzap version

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-six-deep-packages-one-version), [Router replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#router-order-is-opaque), and [Harness replacement decision trajectory](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harness-vocabulary-and-one-profile-slot-daemon).

## Supersession

Deep package ownership remains current: public contracts and implementations
stay behind their owning package, production packages never depend on
simulation or evaluation products, and MCP and simulator persisted formats
version independently from product packages.

`20260811-four-layer-endpoint-replicated-harness.md` replaces the six `v2/*`
packages, `@moltzap/v2-*` names, `v2/VERSION`, Ledger and testbed owners, former
exports and binaries, shared six-package CalVer rule, and old dependency DAG
with exactly seven final `packages/*` products: `@moltzap/identity`,
`@moltzap/router`, `@moltzap/client`, `@moltzap/simulator`, `@moltzap/evals`,
`@moltzap/openclaw-channel`, and `@moltzap/nanoclaw-channel`. `20260901-six-packages-publish-as-one-version-set.md` selects
the publication and version policy this record left deferred: five packages
publish as one calendar version set, evals and the NanoClaw adapter stay
private, and the package version is independent of the wire compatibility
value. The replacement
record and `docs/spec/layer-interfaces.md` own the current package map.

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

Identity exports `.`, `./registry`, and `./registry/server`. Transport,
transcript, and endpoint export `.` and `./server`. Simulator exports
`.`, `./adapter`, and `./ledger`. Testbed exports `.`. Production
packages never depend on simulator or testbed, and `v2/*` imports
nothing from `packages/*`.

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

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
| 2026-09-01 | Recorded that `20260901-six-packages-publish-as-one-version-set.md` selects the publication and version policy the Supersession section deferred. The historical Decision Outcome is unchanged. |
| 2026-09-02 | The Supersession summary of `20260901-six-packages-publish-as-one-version-set.md` names five publishing packages with the NanoClaw adapter private, matching that record's corrected outcome. This record's own Decision Outcome is unchanged. |
