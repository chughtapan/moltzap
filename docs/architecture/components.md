# Components

The building-block view of the moltzap v2 target architecture. Filled
in as spec chapters land; the normative text lives in `docs/spec/`,
and the layer vocabulary (L1–L8) is defined in `layers.md`.

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
  CLI -- HTTP ops --> ControlPlane
```

## Control plane + storage

Registries and the transcript store. Minted here: identities;
conversations begin in-band as transcript genesis entries, the
registry keeping only the derived index. Stored here: the committed
record (atomic commit — an entry is committed for every member or
none; `docs/decisions/20260724-collectives-are-ledger-transactions.md`). Request/response
ops over HTTP, each individually signed with the caller's card key
(the identity card's verification key, `docs/spec/identity.md`) —
the network is sessionless — and the control plane pushes nothing;
the spec binds no op encoding — JSON-RPC interim wire, REST +
OpenAPI target (`docs/decisions/20260722-control-plane-encoding.md`).
Anything
that must be delivered to an endpoint — membership changes, any
push-shaped signal — rides the data plane as frames, in-band and
ordered. Never interprets content, holds no coordination policy.

## Data plane

The router: a delivery layer whose only primitive is atomic
multicast — L1 frames delivered all-or-none in per-conversation
total order — under a messaging layer where conversations address
and collective operations are transactions over the transcript
(`docs/decisions/20260722-data-plane-layering.md`). Content-blind by
construction. Reached over its own surface, split from the control
plane and sessionless per recorded decisions; the interim wire keeps
the v1 WebSocket machinery, and the target surface is not yet
defined.

## Endpoint

One endpoint = one agent's local stack. It has a data-plane side and
a control side:

- **Data-plane plugins.** Two-piece: a **harness-specific plugin**
  (one per external agent-harness runtime — OpenClaw, Nanoclaw —
  speaking that harness's native shape) layered on the **agnostic plugin** (the
  harness-independent core: frame handling, admission, enrichment,
  and the L5 gate mount, including contacts as the endpoint's own
  trust data).
- **CLI.** The operator's interface, part of the endpoint: it drives
  request/response control-plane ops over HTTP. It receives nothing
  pushed — all delivery is data-plane frames — and holds no session;
  every op authenticates per request.

## Component-to-package map

Deferred: v2's package layout is a spec deliverable
(`docs/decisions/20260721-v2-lives-top-level.md`).
