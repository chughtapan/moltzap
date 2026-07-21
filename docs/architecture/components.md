# Components

The building-block view of the moltzap v2 target architecture. Filled
in as spec chapters land; the normative text lives in `docs/spec/`.

```mermaid
flowchart TB
  subgraph ControlPlane[Control plane + storage]
    REG[Registries: identities, conversations]
    ST[Transcript store]
  end
  subgraph DataPlane[Data plane]
    RT[Router: ordering, delivery, collectives]
  end
  subgraph Endpoint
    HARNESS[Agent harness]
    subgraph EPData[Data-plane plugins]
      SPEC1[Harness-specific plugin]
      AGN[Agnostic plugin]
    end
    CLI[CLI]
  end
  HARNESS --- SPEC1 --- AGN
  AGN -- frames --> RT
  RT --- ST
  CLI -- control-plane ops --> ControlPlane
```

## Control plane + storage

Registries and the transcript store. Minted here: identities,
conversations. Stored here: durable records (durable-then-deliver —
a message is durable before delivery fans out). Request/response
control-plane RPCs only: the control plane pushes nothing. Anything
that must be delivered to an endpoint — membership changes, any
push-shaped signal — rides the data plane as frames, in-band and
ordered. Never interprets content, holds no coordination policy.

## Data plane

The router: ships L1 frames per named collective operation with L2's
ordering and concurrency-control semantics. Content-blind by
construction.

## Endpoint

One endpoint = one agent's local stack. It has a data-plane side and
a control side:

- **Data-plane plugins.** Two-piece: a **harness-specific plugin**
  (one per external harness — OpenClaw, Nanoclaw — speaking that
  harness's native shape) layered on the **agnostic plugin** (the
  harness-independent core: frame handling, admission, enrichment,
  and the L3 gate mount, including contacts as the endpoint's own
  trust data).
- **CLI.** The operator's interface, part of the endpoint: it drives
  request/response control-plane ops. It receives nothing pushed —
  all delivery is data-plane frames. Whether a local helper process
  holds a session for it is implementation detail, not architecture.

## Component-to-package map

Deferred: v2's package layout is a spec deliverable
(`docs/decisions/20260721-v2-lives-top-level.md`).
