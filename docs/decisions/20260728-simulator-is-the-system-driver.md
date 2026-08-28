---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

# V2 owns one simulator as the system driver

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-simulator-is-the-system-driver) and [replacement decision trajectory](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harnessclient-owns-runtime-context).

## Supersession

One simulator continues to own system composition, the runtime roster, closed
EventCatalog, simulation-evidence `RunLedger`, source gate, and focused fake
Layers. Product conversation history and simulator RunLedger remain distinct.
Runtime subjects receive `HarnessEndpoint` or MCP and do not construct Router,
Registry, daemon, or transport from a public profile reference.

`20260827-addressed-messaging-replaces-openfloor.md` retains the
`20260811-four-layer-endpoint-replicated-harness.md` removal of the separate v2
simulator and testbed products and assigns the one preserved latest-main
simulator to `@moltzap/simulator`, with direct dependencies on identity,
Router, and client for process composition. It resolves the social-traffic
surface as explicit addressed send and addressed inbound delivery through the
public Client capability. Runtime Router authority and persisted
Router-evidence semantics remain removed. The replacement record and
`docs/spec/layer-interfaces.md` own the current handoff and migration gate.

## Context and Problem Statement

The code-first simulator has become stable enough to drive development,
but its current kernel still faces v1 protocol types and its reviewed
worktree is not an immutable reconstructible source. Reimplementing a
second simulator would split the evidence model and lifecycle semantics.

## Decision Outcome

Chosen: **port one verified simulator kernel into the first-class v2
`simulator` package, then use it to drive the stack**.

Preserve `Simulator.define`, the closed immutable EventCatalog, typed
run-evidence RunLedger/LedgerStorage, runtime roster, and scoped private
lifecycle kernel. Replace v1 protocol-facing ports and events with
v2-native public capabilities. RouterProvider becomes StackProvider;
the `simulator` root owns and exports that contract, while testbed
supplies its production Live Layer and focused tests supply fake
Layers. Runtimes receive EndpointProfileRef. Product Transcript and
simulator RunLedger remain distinct stores and abstractions.

Porting begins only after the source rewrite is rebased onto the
post-freeze `main`, aligned with the eight-layer constitution, fully
tracked, and landed with non-vacuous architecture checks and green
build, type, lint, unit, and evaluation gates. The repository handoff
records that immutable source SHA. Later source fixes forward-port
explicitly.

Do not port legacy `launchTestbed`, public v1 protocol types,
YAML/grading DSLs, or concrete platform mechanisms into production
modules. The existing simulator becomes a temporary compatibility
facade or is retired; two simulator engines do not coexist.

Testbed remains distinct: it acquires platforms, supervises external
processes, injects faults through public capabilities, supplies test
substitutes, and runs black-box production subjects.

## Consequences

Simulator provenance is an implementation gate, not a best-effort
note. The kernel can run against fakes before production services exist
and later drive mixed scripted, Effect, OpenClaw, and NanoClaw
acceptance without changing ownership.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
| 2026-08-27 | Repointed the runtime adapter surface to `HarnessEndpoint` and native shared sessions while retaining Simulator ownership and provenance gates. The historical Decision Outcome is untouched. |
