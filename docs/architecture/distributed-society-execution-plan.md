# Distributed society execution implementation plan

Status: PROPOSED FOLLOW-ON PLAN — BLOCKED ON SIMULATOR HANDOFF

Normative owner:
[`distributed-society-execution.md`](../spec/distributed-society-execution.md)

This plan persists the first implementation sequence for the accepted target.
It authorizes no implementation while
`v2/inputs/simulator-handoff-20260728.md` remains pending and without its
immutable landed SHA.

## First implementation scope

The first implementation delivers a reusable TypeScript submission call in
`testbed`, a repository-local CLI-shaped wrapper, persistent local Temporal,
and a generic Kubernetes Agent Sandbox backend. `Simulator.define`, the
roster, and the public `StackProvider` boundary remain portable. No new
package, export subpath, or production binary is added.

The backend uses direct Sandboxes, one aggregate Kueue Workload, controller
provisioned per-slot Secrets, and one PVC per Sandbox for the two-agent and
ten-agent proof. The initial public runtime lifecycle adds opaque generation
observations rather than Kubernetes types: ready, lost, re-ready, and logical
termination. The kernel records the corresponding closed RunLedger events.

## Delivery sequence

1. Complete this ADR admission, then verify the simulator handoff SHA and its
   required checks. No tracked v2 implementation starts earlier.
2. Run disposable Docker/Colima compatibility evidence against the stock
   digest-pinned OpenClaw image: non-root startup, capability drop, mounted
   bootstrap, persistent state, and late-bound MoltZap adapter/daemon.
3. Implement the generation-aware acquisition state machine against a fake
   testbed backend. Prove stale generations never satisfy the barrier and that
   controller loss never replays customer code.
4. Implement the private Kubernetes adapter: aggregate Kueue reservation,
   direct Sandbox creation, Secret/PVC provisioning, Pod/Sandbox watch
   reconciliation, readiness collection, and owner-first cleanup.
5. Install Agent Sandbox core, Kueue, persistent Temporal, and a
   NetworkPolicy-capable CNI in kind. Prove a two-agent real OpenClaw/MoltZap
   exchange, then the ten-agent gate.
6. In the ten-agent gate, delete one backing Pod before dispatch. Require the
   same Sandbox and AgentId, a new generation, preserved PVC marker,
   reacquired exact readiness, and exactly one customer-program dispatch.
7. Immediately next, interrupt one agent after dispatch. Require loss of the
   active turn, no customer-program replay, state preservation, rejoin under
   the same AgentId, and success of a later principal-channel instruction.
8. Qualify the same behavior on regional GKE Standard with a dedicated gVisor
   pool. Then progress through 100, 1,000, 5,000, and 10,000 readiness-only
   agents. Paid model calls remain a smaller-cohort gate.

## GKE and scale gates

Terraform owns GKE, pools, IAM, Artifact Registry, network, and storage.
Pinned Helm owns Kueue, Temporal support, and MoltZap support resources. GKE
owns the managed Agent Sandbox add-on. Record GKE version, served Sandbox CRD,
controller identity, image digests, resource profile, and policy set in each
run artifact.

Before the 1,000-agent gate, run and admit a scale-storage decision. A
per-Sandbox PVC is required for the first persistence proof but is not assumed
viable at 10,000. Measure API throttling, admission time, object count,
creation rate, readiness latency, controller resources, restart convergence,
and cleanup leaks at every scale gate.

## Acceptance checks

- Reject any agent Sandbox with other than one application container, or with
  init containers, sidecars, an unpinned image, privilege, added capability,
  or mounted ServiceAccount token.
- Prove admission precedes all Sandbox creation and holds until cleanup.
- Prove generation changes invalidate readiness; duplicate, stale, or missing
  generations never satisfy the exact roster barrier.
- Prove Secret isolation, PVC persistence, denied direct agent-to-agent
  traffic, and permitted MoltZap/bundle edges.
- Prove normal exit is logical termination, while crash/Pod recreation can
  rejoin without replaying interrupted work.
- Run repository documentation checks and the relevant Nx build, typecheck,
  lint, and test targets.

## Deliberate deferrals

NanoClaw distributed conformance, Nomad/Slurm adapters, warm pools, snapshots,
production Temporal hosting, hostile submitted-code isolation, concurrent
society admission, and a 10,000-agent persistent-storage backend remain
separate decisions. AgentENV remains research only: it may inform a future
microVM-density profile if the literal container invariant changes.
