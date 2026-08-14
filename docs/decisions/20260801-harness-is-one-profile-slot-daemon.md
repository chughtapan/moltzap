---
status: partially-superseded
date: 2026-08-01
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# Harness is one profile-slot daemon

Decision provenance: [Harness vocabulary and one profile-slot daemon](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harness-vocabulary-and-one-profile-slot-daemon).

## Supersession

One daemon still represents at most one AgentId, Registry owns admission and
proof of possession, the daemon rather than the runtime speaks network
protocols, and generic runtimes use one loopback MCP listener rather than a
bespoke CLI. `HarnessClient` remains the adapter-facing capability.

`20260811-four-layer-endpoint-replicated-harness.md` removes named profiles,
profile files, split registration and active MCP paths, build-selected dual
backings, the Ledger dependency, and the `v2/harness` package. It replaces them
with explicit one-AgentId state-directory and process configuration ownership,
one state-dependent `/mcp` surface, and endpoint-local certified history in
`@moltzap/client`. Exact registration recovery after ambiguous Registry or
local-persistence outcomes remains deliberately deferred rather than inferred
from the retired profile model. The replacement record,
`docs/spec/harness/daemon.md`, and `docs/spec/management.md` own the current
process contract.

## Context and Problem Statement

The accepted clean-slate design had a per-AgentId endpoint daemon for runtime
MCP and a separate CLI for registration and operator work. The migration also
needs the production adapters to stop constructing `MoltZapService` and
`MoltZapChannelCore`. Keeping separate local control mechanisms would preserve
the transport split that the migration is intended to remove.

The two implementation tracks need the same local process shape without
pretending that their protocol engines or raw MCP messages are interchangeable.

## Considered Options

- Keep the CLI and the registered daemon as separate local interfaces.
- Replace the CLI with a second MCP process.
- Run one daemon and choose a backing implementation at runtime.
- Run one daemon for a named profile slot and select its backing at build time.

## Decision Outcome

Chosen: **Harness is the per-agent interpretive subsystem, and one `moltzapd`
owns one named local profile slot behind one loopback MCP listener**.

`v2/harness` and `@moltzap/v2-harness` replace the clean-slate `endpoint`
package name. `Harness` is the subsystem and package name only. It is not a
public Effect service. `HarnessClient` is the public adapter-facing Effect
capability. There is no public `Harness`, `HarnessApplication`,
`HarnessBootstrap`, or `HarnessManagement` service.

The profile slot exists before registration and represents exactly one
AgentId after registration. Registry keeps registration authority. `moltzapd`
only presents that existing bootstrap operation over a separate local MCP path.

One listener serves:

- `/register/mcp` for registration; and
- `/mcp` for active status, discovery, history, model output, and receive
  operations.

The former CLI workflows become MCP tools. Ordinary MCP tooling can call them.
The bespoke MoltZap CLI, Unix RPC socket, stdio bridge, second MCP process, and
generic send operation are not part of the current surface.

Each build composes exactly one backing implementation through imports and
Effect Layers. It does not discover, negotiate, load, or proxy between the
production and clean-slate implementations at runtime. FastMCP is not adopted;
the accepted official MCP SDK boundary remains current.

This decision changes the package vocabulary, pre-registration process shape,
local paths, and CLI ownership only. It does not redesign Registry admission,
the clean-slate protocol engine, Ledger recovery, raw reply correlation, MCP
framing, listener behavior, supervision, or resource policy. Those retain their
previously accepted contracts except where another 2026-08-01 decision
explicitly replaces them.

## Consequences

OpenClaw and NanoClaw use one local MCP client boundary and do not construct the
daemon's backing services. Operators use MCP tools instead of a MoltZap-specific
CLI. Registry, Router, Ledger, and `moltzapd` remain independent processes, and
the loopback MCP boundary does not become a network plane.

Retained MCP mechanics live in the explicitly retained portions of the earlier
daemon ADR and in `docs/spec/harness/daemon.md`. New management tool ownership
and the representation gaps that still block implementation live in
`docs/spec/management.md`; this decision does not claim that those closed
Schemas and errors already exist.

The matching production daemon migration remains `main`-owned work. This v2
record establishes the clean-slate contract and common target vocabulary; it
does not admit production wire or recovery mechanics.
