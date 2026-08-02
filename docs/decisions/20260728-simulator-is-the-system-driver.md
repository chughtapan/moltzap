---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260801-harness-client-owns-runtime-context.md
---

# V2 owns one simulator as the system driver

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-simulator-is-the-system-driver) and [replacement decision trajectory](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harnessclient-owns-runtime-context).

## Supersession

Simulator ownership of the kernel, `StackProvider`, runtime roster,
EventCatalog, RunLedger, source gate, and testbed/fake Layer split remains
current. The `EndpointProfileRef` runtime handoff is replaced: runtime subjects
receive the public `HarnessClient` capability and do not construct its daemon
or transport from a public profile reference. The current handoff lives in
`docs/spec/layer-interfaces.md` under StackProvider and
`docs/spec/harness/client.md`.

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
