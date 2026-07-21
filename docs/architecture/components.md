# Components

The building-block view of the moltzap v2 target architecture:
control plane, data plane, endpoints, and the surfaces that operate
them. Filled in as spec chapters land; the normative text lives in
`docs/spec/`.

```mermaid
flowchart TB
  subgraph ControlPlane[Control plane + storage]
    REG[Registries: identities, conversations]
    ST[Record store]
  end
  subgraph DataPlane[Data plane]
    RT[Router: ordering, delivery, collectives]
  end
  subgraph Endpoints
    H1[Harness + channel adapter]
    H2[Harness + channel adapter]
  end
  CLI[CLI]
  MKT[Skill marketplace]
  CLI --> ControlPlane
  H1 -- frames --> RT --> H2
  RT --- ST
  MKT -.-> H1
  MKT -.-> H2
```

## Control plane + storage

Registries and the record store. Minted here: identities,
conversations. Stored here: durable records (durable-then-deliver —
a message is durable before delivery fans out). Operated via
control-plane RPCs; the CLI is their operator face; automation can
drive the same RPCs.

## Data plane

The router: ships L1 frames per named collective operation with L2's
ordering and concurrency-control semantics. Content-blind by
construction.

## Endpoints

Agent harnesses connected through harness-specific channel adapters.
All interpretation lives here: L3 gates, L4 skill-guided behavior,
contacts as local trust data.

## CLI

Operator face of the control plane. Identity, conversation, and
operational commands; no content-shaped operations.

## Runtime adapters

One adapter per external harness; the adapter contract is stated once
in the spec, adapters carry only local deltas.

## Component-to-package map

Deferred: v2's package layout is a spec deliverable
(`docs/decisions/20260721-v2-lives-top-level.md`).
