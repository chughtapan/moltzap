# Distributed society execution architecture

Status: ORIENTATION — NORMATIVE CONTRACT IN [distributed-society-execution.md](../spec/distributed-society-execution.md)

## Runtime topology

One Temporal Workflow coordinates one run. The in-cluster controller composes
testbed Layers, Kueue reserves aggregate capacity, and direct Agent Sandboxes
hold the stable logical agent slots. Registry, Router, and Ledger retain their
independent production process boundaries.

```mermaid
flowchart TB
  S[TypeScript submission<br>repository-local CLI wrapper]
  T[Temporal Workflow<br>one society run]
  C[Run controller<br>testbed composition]
  W[Kueue Workload<br>one aggregate PodSet]
  B[Runtime bundle service]
  RL[(RunLedger artifacts)]

  subgraph Core[Run-stack core]
    I[Registry]
    R[Router]
    L[Ledger]
  end

  subgraph Slot1[Logical Sandbox 1]
    P1[Backing Pod<br>one application container]
    O1[OpenClaw bridge]
    D1[moltzap-agentd]
    V1[(Slot PVC)]
    K1[Slot Secret]
    O1 -- loopback MCP --> D1
    P1 --- V1
    P1 --- K1
  end

  subgraph SlotN[Logical Sandbox N]
    PN[Backing Pod<br>one application container]
    ON[OpenClaw bridge]
    DN[moltzap-agentd]
    VN[(Slot PVC)]
    KN[Slot Secret]
    ON -- loopback MCP --> DN
    PN --- VN
    PN --- KN
  end

  S --> T
  T --> C
  C --> W
  C --> B
  C --> RL
  C --> I
  C --> R
  C --> L
  W -- admission --> Slot1
  W -- admission --> SlotN
  B --> P1
  B --> PN
  D1 --> I
  D1 --> R
  D1 --> L
  DN --> I
  DN --> R
  DN --> L
  P1 -. current generation readiness .-> C
  PN -. current generation readiness .-> C
```

The application container has one logical agent despite containing both the
OpenClaw bridge and its local daemon. No agent sidecar, init container, direct
agent service, or Sandbox Router is part of the profile. Agents initiate their
outbound MoltZap connections; no agent-to-agent path is permitted.

## Run phases

| Phase | Owner | Exit condition |
|---|---|---|
| Validate | submission surface | definition, image digest, and artifact digests validate |
| Bootstrap | Temporal | one controller Pod is running |
| Acquire core | controller | Registry, Router, and Ledger are ready |
| Resolve roster | controller | AgentIds and slot bindings freeze |
| Reserve | controller and Kueue | one aggregate Workload is admitted |
| Materialize | controller and Sandbox | every direct Sandbox, Secret, and initial PVC exists |
| Ready | controller and kernel | every current generation has a ready handle and exact-set evidence is durable |
| Dispatch | private kernel | current handles recheck and one dispatch attempt is durable |
| Execute | controller | customer Effect completes, fails, or is cancelled |
| Release | controller | Sandbox owners are deleted before dependent resources |
| Reconcile | Temporal | deterministic cleanup completes without simulator evidence |

Capacity admission and semantic readiness are deliberately separate. Kueue
reserves quota; the controller establishes the exact generation-aware barrier.

## Generation lifecycle

The Logical Sandbox remains the roster slot while its backing Pod/container
may change. The current generation is the backing Pod UID plus application
container restart count.

```mermaid
stateDiagram-v2
  [*] --> Materializing
  Materializing --> Ready: current generation passes readiness
  Ready --> Acquiring: pre-dispatch generation changes
  Acquiring --> Ready: replacement generation passes readiness
  Ready --> Dispatched: exact roster barrier and dispatch attempt
  Dispatched --> Rejoining: generation changes
  Rejoining --> Dispatched: state reattached and ready again
  Rejoining --> Failed: rejoin deadline or unrecoverable mismatch
  Dispatched --> Terminated: logical runtime exits
  Failed --> Releasing
  Terminated --> Releasing
  Dispatched --> Releasing: normal run release
  Releasing --> [*]
```

The `Rejoining` transition loses active turns, live subscriptions, volatile
cursors, and other in-flight work. It keeps the AgentId, slot Secret, and PVC
state. Neither the controller nor Temporal replays the customer Effect.

## Isolation and artifacts

The controller creates one read-only Secret per slot after Registry-backed
roster resolution. It uses backing-Pod ownership and status to bind readiness
to the current generation. This avoids a projected ServiceAccount-token or
TokenReview enrollment ceremony and leaves agent ServiceAccounts without RBAC
or cloud identity.

The stock digest-pinned OpenClaw image remains the compatibility path. A
mounted bootstrap fetches a verified runtime bundle from the in-cluster bundle
service, writes it to the slot state root, and starts ordinary OpenClaw daemon
supervision. Principal-channel experiment instructions arrive only after
readiness. A private registry mirror or preinstalled optimized image may
reduce startup latency but cannot become required.

Default-deny policies permit DNS, MoltZap core services, and the bundle service
only. A future small paid-model cohort adds an allowlisted proxy. Image pulls
are node operations rather than agent egress.

## Scale evidence

The local contract ends with the ten-agent pre-dispatch recreation gate. The
next gate proves post-dispatch rejoin. GKE then proves the same behavior at ten
agents before readiness-only scale gates of 100, 1,000, 5,000, and 10,000.
Each run records creation, admission, bootstrap, readiness, rejoin, and
cleanup timing separately. A storage architecture for 1,000–10,000 persistent
slots is intentionally not inferred from the first per-Sandbox PVC profile.
