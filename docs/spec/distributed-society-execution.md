# Distributed society execution

Status: **Accepted post-Gate-1 target**

Decision owners:

- [`20260729-one-container-per-agent-gates-distributed-runs.md`](../decisions/20260729-one-container-per-agent-gates-distributed-runs.md)
- [`20260729-kubernetes-kueue-admits-agent-cohorts.md`](../decisions/20260729-kubernetes-kueue-admits-agent-cohorts.md)
- [`20260729-temporal-orchestrates-distributed-runs.md`](../decisions/20260729-temporal-orchestrates-distributed-runs.md)
- [`20260729-openclaw-experiments-are-late-bound.md`](../decisions/20260729-openclaw-experiments-are-late-bound.md)
- [`20260729-kubernetes-secrets-bind-agent-slots.md`](../decisions/20260729-kubernetes-secrets-bind-agent-slots.md)

## Scope and ownership

This chapter owns the observable contract for one code-first simulator run over
a distributed agent-container cohort. It extends the accepted simulator and
testbed boundary without changing Gate 1 wire, identity, Router, Transcript,
daemon MCP, package, or completion requirements. Gate 1 still completes
without deployment. Implementation remains blocked until the simulator handoff
records an immutable landed SHA and a separate implementation-scope decision
admits the first slice.

`simulator` owns the portable definition, immutable roster, private kernel,
closed EventCatalog, runtime lifecycle contract, and RunLedger. `testbed` owns
platform choice, `StackProvider` implementation, Kubernetes/Kueue/Temporal
clients, external runtime construction, persistent state, and cleanup. No
scheduler, cloud, orchestration, bootstrap, or Kubernetes type moves into
`simulator`.

The six packages and export maps remain exact. Submission is one reusable
TypeScript call and a repository-local CLI-shaped composition until a later
decision authorizes another owner. This chapter creates no package, binary, or
Router feature.

## Terms

- **Expected roster**: the immutable keyed AgentId set resolved after ordinary
  Registry registration or validation and before agent materialization.
- **Roster slot**: a stable declared key, resolved AgentId, runtime
  configuration, endpoint profile, and acquisition identity.
- **Logical Sandbox**: one Kubernetes Sandbox CR bound to one roster slot.
- **Execution generation**: the current backing Pod UID and application
  container restart count beneath one Logical Sandbox.
- **Agent application container**: the sole user container that contains one
  logical runtime bridge and its one `moltzap-agentd`.
- **Capacity admitted**: Kueue has admitted aggregate quota for the complete
  cohort. It says nothing about semantic readiness.
- **Slot ready**: the current execution generation has a current scoped
  readiness handle after identity, daemon, and runtime-bridge acquisition.
- **Roster ready**: durable exact-set evidence exists while every expected
  slot and the run-stack core have current readiness handles.
- **Program dispatch**: durable authorization and attempt evidence immediately
  before one invocation of the customer Effect. It does not prove the first
  customer instruction executed.

## Distributed cohort contract

One run resolves and freezes one expected roster. For a run claiming this
distributed profile:

1. every expected AgentId maps to one distinct Logical Sandbox and one agent
   application container in its current backing Pod;
2. the application container contains no second logical agent, init container,
   or sidecar;
3. Registry, Router, Ledger, controller, Kueue, and Temporal processes do not
   count as agents;
4. the Logical Sandbox, slot Secret, AgentId, endpoint profile, and persistent
   state root remain bound for the run;
5. backing-container restart or backing-Pod recreation is a new execution
   generation, not a new logical agent; and
6. in-process, packed-process, or synthetic agents do not count toward the
   claimed cohort size.

One cohort and run stack serve one dispatch, then tear down. A rebooted
generation never turns the run into a reusable society or authorizes a second
dispatch.

The controller declares a current generation ready only after all of these
hold:

- aggregate capacity admission and Sandbox/PersistentVolume binding succeed;
- the slot's pre-existing or provisioned key/profile is registered or
  validated through ordinary Registry operations and resolves the expected
  immutable AgentCard;
- the expected `EndpointProfileRef` is present;
- daemon discovery reports the expected AgentId;
- the runtime bridge has acquired its required loopback MCP subscription; and
- the backing Pod's local readiness probe is passing for the current Pod UID
  and application restart count.

The controller derives slots from its own Sandbox metadata, watches the
Sandbox-to-Pod ownership relation and Pod status, and maintains the exact set
of current handles. A generation change invalidates its slot immediately.
Kubernetes readiness is operational evidence, not a proof of honest agent
behavior, a Router operation, or a substitute for L1 authentication.

Roster readiness linearizes at the durable RunLedger append while every
current handle is ready. The controller rechecks the same exact generation set
before dispatch. A loss observed before dispatch returns a recoverable slot to
acquisition; a core loss, unrecoverable mismatch, or expired acquisition
deadline fails and releases the run.

After dispatch, generation loss is typed evidence. A replacement generation
may reattach durable state and rejoin under the same AgentId, but active model
turns, live subscriptions, volatile cursors, and other in-flight work are
lost. The controller does not replay them or the customer Effect. Logical
runtime termination remains evidence for customer policy. Controller loss
fails execution and may leave RunLedger unfinalized; external cleanup may
continue idempotently without appending simulator evidence.

The closed EventCatalog declares, before execution, acquisition start/failure,
generation ready/lost, exact roster ready, dispatch attempted, logical
termination, and cleanup outcomes. Exact class names and schemas are part of
the first implementation scope.

Router has no runtime registration, presence, roster, or readiness operation.
Registry identity is not process liveness. Kueue admission is not semantic
readiness.

## Kubernetes and GKE reference profile

The first backend targets general Kubernetes. The authoritative environment is
regional GKE Standard with VPC-native networking, Dataplane V2, a stable
system pool, and a dedicated homogeneous on-demand gVisor agent pool. Spot
capacity is not a reference result.

The controller creates one direct Sandbox CR per slot after one aggregate
Kueue Workload has admitted the frozen roster's resource request. The Workload
has one PodSet with count equal to roster size. The controller applies admitted
flavor and scheduling constraints to each Sandbox template and retains the
reservation until cleanup. Agent Sandbox Pods carry no Kueue queue label, so
the native integration does not create a Workload per agent. The aggregate
adapter is conformant only when its local proof establishes admission before
Sandbox creation and resource equivalence; otherwise the first implementation
is blocked for a new decision.

Every Sandbox has one application container, no init container or sidecar,
`restartPolicy: OnFailure`, non-root execution, dropped capabilities, disabled
privilege escalation, disabled ServiceAccount token automount, and explicit
resource requests and limits. The Sandbox controller may recreate a missing
backing Pod. No Job, Deployment, StatefulSet, or other controller replaces an
agent Pod. A direct Sandbox, not a Claim or WarmPool, is the first profile.

The controller creates one read-only Secret per slot after roster resolution.
It contains only that slot's identity/profile/bootstrap material and immutable
runtime-bundle references. Agent ServiceAccounts have no Kubernetes RBAC or
GCP IAM. The controller verifies current Sandbox/Pod ownership and status;
projected ServiceAccount tokens and TokenReview enrollment are absent.

Default-deny run policies permit agent egress only to DNS, Registry, Router,
Ledger, and the in-cluster runtime-bundle service. Paid-model tests add an
allowlisted in-cluster HTTPS proxy. Direct agent-to-agent and direct provider
egress are denied. Image pulls use node identity and may use a private
Artifact Registry mirror without changing the pinned image digest.

Terraform owns GCP, cluster, pools, IAM, registry, network, and storage.
Pinned Helm configuration owns Kueue and MoltZap support resources. GKE owns
the managed Agent Sandbox add-on. Nomad is a future conforming backend seam;
Slurm, managed batch, Autopilot, and AgentENV are not selected first backends.

The first two- and ten-agent gates use one PVC per Sandbox to persist OpenClaw
home/workspace and committed daemon state. A separate measured storage
decision is required before any 1,000–10,000 reboot-persistence claim.

## Temporal and controller contract

One Temporal Workflow represents one society submission and tracks aggregate
phases only. It creates no per-agent Workflow, Activity, Signal, or child
Workflow. Activities use deterministic names to start the non-replacing
controller Pod, observe bounded aggregate progress, and perform cleanup.

The controller verifies the content-addressed experiment artifact, acquires
the run-stack core, resolves the roster, creates and awaits the aggregate
Kueue Workload, materializes Sandboxes, evaluates the Effect once after the
exact barrier, collects artifacts, releases resources, and finalizes evidence
when it survives. Temporal does not run agent logic, decide readiness, append
RunLedger evidence, or replay customer code. BullMQ and Redis are absent.

The first development environment uses persistent local Temporal. Production
Temporal hosting remains deferred.

## OpenClaw and artifact contract

The stock digest-pinned OpenClaw image is the correctness path. A mounted
bootstrap verifies and installs the content-addressed MoltZap adapter and
`moltzap-agentd` into the persistent state root, then starts ordinary OpenClaw
daemon supervision. The agent receives experiment instructions through the
MoltZap principal channel after readiness. A preinstalled image is an optional
optimization and cannot be required to pass. Stock-image failure is an
integration defect.

OpenClaw distributed conformance is first. NanoClaw distributed conformance is
deferred without altering Gate 1 mixed-runtime obligations.

## Conformance and deferrals

A two-agent local smoke may precede the ten-agent gate. The ten-agent gate
proves the stock image, Secret isolation, persistent state, aggregate
admission, exact barrier, one dispatch, and pre-dispatch backing-Pod
recreation. The immediately following gate proves post-dispatch reboot/rejoin
with lost in-flight work and no program replay. Later readiness-only gates are
100, 1,000, 5,000, and 10,000 agents; model calls remain a smaller cohort.

Warm pools, snapshots, production Temporal hosting, Nomad/Slurm adapters,
hostile submitted-code isolation, concurrent-run fairness, and a scale storage
backend remain deliberate deferrals. The durable implementation sequence lives
in [`distributed-society-execution-plan.md`](../architecture/distributed-society-execution-plan.md).
