# Distributed society execution

Status: **Accepted post-Gate-1 target**

Decision owners:

- [`20260729-one-container-per-agent-gates-distributed-runs.md`](../decisions/20260729-one-container-per-agent-gates-distributed-runs.md)
- [`20260729-kubernetes-kueue-admits-agent-cohorts.md`](../decisions/20260729-kubernetes-kueue-admits-agent-cohorts.md)
- [`20260729-temporal-orchestrates-distributed-runs.md`](../decisions/20260729-temporal-orchestrates-distributed-runs.md)
- [`20260729-openclaw-experiments-are-late-bound.md`](../decisions/20260729-openclaw-experiments-are-late-bound.md)
- [`20260729-pod-attestation-gates-agent-enrollment.md`](../decisions/20260729-pod-attestation-gates-agent-enrollment.md)

## Scope

This chapter owns the observable contract for executing one code-first
simulator run over a distributed container cohort. It extends the accepted
simulator and testbed boundary after Gate 1; it does not change any Gate 1
wire, identity, Router, Transcript, daemon MCP, package, or completion
requirement.

Gate 1 still completes without deployment. This target may be implemented
only after its prerequisites are available and after a separate
implementation-scope decision selects the first slice.

## Ownership

`simulator` owns the portable definition, immutable expected roster, private
run kernel, closed EventCatalog, and RunLedger evidence contract.

`testbed` owns platform selection, resource acquisition, the production
`StackProvider` Layer, process and container supervision, external runtime
constructors, workload enrollment, and cleanup. A scheduler, cloud SDK,
Temporal client, Kubernetes client, container bootstrapper, or infrastructure
definition does not move into `simulator`.

The current six packages and export maps remain exact. This chapter does not
authorize `@moltzap/simulator-runner`, another public package, or another
production binary. Submission must be usable through a reusable TypeScript
call and a CLI-shaped operator entrypoint. Until the implementation-scope
review selects a compatible owner, the CLI remains repository-local
composition. Publishing a binary or changing an export requires an explicit
replacement of the package decision.

Each submission acquires one run-scoped production stack in phases. Before
agent-cohort materialization, the testbed acquires independent Registry,
Router, and Ledger core processes and resolves the AgentId roster. Cohort
materialization completes the stack with one independently supervised endpoint
daemon and runtime bridge per AgentId. The testbed releases the cohort and core
after execution evidence has been collected, then records cleanup outcomes
and finalizes the run artifacts. No distributed-run component becomes an
umbrella MoltZap server or a second Router, Ledger, Registry, or daemon
implementation.

## Terms

- **Expected roster**: the immutable keyed AgentId set established during run
  resolution after ordinary Registry registration or validation of every
  declared slot and before agent-Pod materialization.
- **Roster slot**: one stable declared slot key plus its resolved AgentId,
  runtime configuration, and immutable acquisition identity.
- **Run-stack core**: the run-scoped Registry, Router, and Ledger acquisition
  handle, before per-AgentId daemons and runtimes complete the stack.
- **Agent container**: the isolated workload containing exactly one logical
  agent runtime bridge and the one `moltzap-agentd` for its AgentId.
- **Capacity admitted**: Kueue has admitted aggregate quota for the complete
  cohort. Kubernetes placement may still proceed incrementally, and this says
  nothing about agent readiness.
- **Slot ready**: the exact workload bound to a roster slot holds a current
  scoped readiness handle after identity, daemon, and runtime-bridge
  acquisition.
- **Roster ready**: the controller has durably appended exact-set readiness
  evidence while every expected slot's scoped readiness handle is current and
  no failure transition is latched.
- **Program dispatch**: the private kernel durably records authorization and
  an attempt to invoke the customer's Effect program immediately before
  invocation. It does not prove that the first customer instruction executed.

## Distributed cohort contract

One run resolves and freezes one immutable expected roster before it
materializes agent Pods. For a run claiming the distributed container
profile:

1. every expected AgentId maps to one distinct agent container;
2. an agent container contains no second logical agent, init container, or
   sidecar;
3. shared Registry, Router, Ledger, orchestration, and controller processes do
   not count as agent containers;
4. each slot binds atomically to one live workload instance;
5. no restart, replacement, rebinding, or second workload instance is accepted
   for a slot; and
6. an in-process, packed-process, or synthetic agent does not count toward the
   claimed cohort size.

One run-scoped stack and cohort serve one program dispatch for one simulator
run, then tear down. They are not a reusable warm society and do not accept a
second later program dispatch.

The testbed declares a slot ready only after:

- platform admission and workload binding succeed;
- the testbed has accepted a pre-existing key/profile input or provisioned a
  new key and named endpoint profile, completed ordinary Registry registration
  or validation outside the agent Pod, and resolved the immutable AgentCard;
- the testbed has bound the expected `EndpointProfileRef`;
- daemon discovery reports the expected AgentId;
- the runtime bridge has completed its harness-specific daemon supervision,
  including the required loopback MCP subscription; and
- the controller's scoped handle for the bound workload remains current and
  unique.

Each slot handle is backed by authenticated readiness observations bound to
the enrolled Pod UID and slot. Those observations establish matching daemon
discovery and acquisition of the OpenClaw bridge's sole subscription. An
observation that becomes stale or unavailable invalidates the handle. This
operational status path is not Router presence, a product network plane, or
proof of honest agent behavior. Session, poll, lease, or other transport,
schema, freshness, and authentication-envelope details are selected with the
implementation scope.

The controller maintains the run-stack core handle plus the exact set of slot
handles and latches every observed production-service loss, exit, deletion,
replacement, enrollment failure, and identity mismatch. Earlier per-slot
successes do not compose into readiness if the core or an earlier slot handle
is no longer current.

Roster readiness linearizes at the durable append of exact-set readiness
evidence while the run-stack core and every slot handle are current. Before
appending program-dispatch evidence and invoking customer code, the controller
rechecks all of those handles. The dispatch append is the durable authorization
and attempt boundary. A failure observed between the two appends aborts
without invoking customer code. A failure first observed after the dispatch
append is post-dispatch typed runtime or infrastructure evidence for customer
policy. The controller itself can fail between that append and invocation, so
the event does not prove that customer code ran.

This is an observable controller-state guarantee rather than an atomic
snapshot of Kubernetes, Registry, daemon, and runtime processes. An external
process can crash immediately before either check without its failure
notification having reached the controller yet.

The RunLedger contains durable, ordered evidence that distinguishes at least:

- cohort acquisition started;
- cohort acquisition failed, with the attributable phase and slot when known;
- the exact expected roster became ready, including its count and digest;
- customer program dispatch was authorized and attempted; and
- autonomous post-dispatch runtime exits, production-service loss, and, when
  the controller survives through finalization, final cleanup outcomes.

Exact event class names, schemas, and versions are part of the implementation
scope. The closed EventCatalog must declare them before a run.

Any core-service or slot failure transition observed before roster readiness
fails acquisition and releases the cohort. A transition observed after roster
readiness but before program dispatch aborts without invoking customer code.
After dispatch, autonomous runtime exit or infrastructure loss observed before
scoped release is typed evidence consumed by customer Effect policy.
Termination induced by normal cohort release is cleanup evidence, not
runtime-exit evidence. Controller loss fails execution without resuming the
program and may leave the RunLedger unfinalized; external cleanup may continue
idempotently but does not append simulator evidence.

Router has no runtime registration, presence, roster, or readiness operation.
Registry registration establishes product identity, not process liveness.
Kueue admission establishes capacity, not semantic readiness.

## Kubernetes and GKE reference profile

The first backend targets conforming Kubernetes APIs. Its authoritative
environment is regional GKE Standard with VPC-native networking and
Dataplane V2.

The cluster has a stable system pool for production services, orchestration,
and the run controller, plus a dedicated homogeneous on-demand agent pool.
The pool may be pre-sized before workload creation. Spot capacity is not used
for the reference result.

Agent ServiceAccounts retain zero Kubernetes RBAC. Dataplane V2 is part of the
reference cluster profile, but this decision set does not select whether
NetworkPolicy denies direct Pod-to-Pod traffic or the exact allowed service
edges. The distributed profile therefore makes no direct-peer network
isolation claim.

Controller and platform workloads use Workload Identity Federation for GKE
for GCP access and mount no long-lived Google Cloud service-account key.
Agent ServiceAccounts receive no GCP IAM. Artifact delivery uses the
authenticated enrollment path or an object-scoped ephemeral mechanism rather
than agent workload identity. Exact delivery mechanism and platform IAM
bindings are selected with the implementation scope.

The controller creates one plain Pod per roster slot. All agent Pods in a run
have one homogeneous Pod specification and use metadata for deterministic
run/slot identity. Each Pod has:

- `restartPolicy: Never`;
- exactly one agent container;
- no init containers or sidecars; and
- one immutable digest-pinned image reference.

All Pods form one Kueue Pod group. The reference queue admits the complete
group's aggregate quota and does not use partial admission or preemption. The
group is non-retriable, and no owner or external controller replaces a failed
agent Pod. A Pod-group failure releases the whole cohort.

Kueue topology-aware scheduling is enabled for the authoritative GKE profile
to mitigate node and topology fragmentation. Its topology domain and exact
configuration are selected with the implementation scope. Aggregate quota and
topology assignment do not guarantee simultaneous Pod placement or startup;
Kubernetes may still place Pods incrementally after admission.

Kueue owns resource admission only. The controller owns exact readiness and
failure classification.

Every agent Pod has a finite active deadline. A cluster reconciler scans for
expired run-labeled Pods, Kueue resources, and associated ephemeral resources
and deletes them if controller and Temporal cleanup do not complete. Exact
deadline, expiry, and scan values are selected with the implementation scope,
as are the reconciler's resource shape, code owner, placement, RBAC, cloud
credentials, and deployment mechanism. The reconciler bounds orphaned
capacity while it and the Kubernetes control plane remain available; it
neither resumes a run nor appends RunLedger evidence.

Terraform is the reproducible owner of GCP resources, network and IAM
configuration, storage, registries, and cluster/node-pool construction.
Pinned Helm configuration owns Kueue and cluster add-ons. Module layout,
region, node shape, Pod CIDR, autoscaling, quota, and timeout values are not
fixed here.

Artifact Registry may privately mirror the official OpenClaw digest and any
optimized image. GKE image pulls receive repository-scoped access. Portable
Kubernetes deployments may use ordinary registry credentials.

Nomad is the next candidate backend, but no adapter is selected for the first
implementation. Any future Nomad, Slurm, managed batch, serverless, or
Autopilot profile must pass the same container, readiness, failure, and
evidence contract rather than weakening it.

## Temporal and controller contract

The GKE reference uses one Temporal Workflow per society submission. That
Workflow tracks aggregate run phases, never one Workflow, Activity, Signal,
or child Workflow per agent.

Temporal owns durable operational intent and reconciliation. Kubernetes and
Kueue own resource placement and admission. The run controller:

1. verifies and loads the content-addressed experiment bundle;
2. acquires the run-scoped Registry, Router, and Ledger core through testbed
   Layers;
3. resolves and freezes the expected AgentId roster;
4. creates and acquires the expected cohort through testbed Layers, completing
   the production stack with its per-AgentId daemons and runtime bridges;
5. evaluates the customer Effect once after roster readiness;
6. collects run evidence and artifacts, then releases the cohort and stack;
7. finalizes and uploads the RunLedger when the controller survives; and
8. reports bounded aggregate status to the Workflow.

Temporal Activities use deterministic resource names and idempotent platform
reconciliation. They may validate or prepare shared capacity, create and
reconcile the controller bootstrap workload, observe aggregate controller
state, and delete deterministic run resources during cleanup. The controller
and its testbed Layer exclusively own acquisition or creation of the
production stack, Kueue workload, and agent Pod group. Activities do not run
agent logic, decide roster readiness, or append customer simulation evidence.
A controller crash fails the run; an Activity may clean resources but cannot
replay arbitrary customer code.

The controller workload is non-retriable and non-replacing for one run. Once
execution starts, Temporal does not recreate it. Its exact Pod-versus-Job
resource shape is selected with the implementation scope.

Abrupt controller loss may leave the RunLedger unfinalized. Temporal records
the operational failure and cleanup state without impersonating simulator
evidence. Finite agent-Pod deadlines and the cluster reconciler bound orphaned
capacity if Temporal cleanup also fails.

BullMQ and Redis are absent. Temporal state is neither product Transcript nor
RunLedger evidence.

The first development environment uses a persistent local Temporal dev
server. Production Temporal hosting is deliberately deferred.

The submitting operator and submitted TypeScript/Effect experiment bundle are
trusted in this profile. The bundle is arbitrary code executing in the
controller process. Effect service requirements shape composition but do not
provide an operating-system sandbox. Hostile or mutually untrusted experiment
code and multi-tenant controller isolation are outside this profile.

## OpenClaw artifact contract

The compatibility baseline is a stock, digest-pinned OpenClaw image. The
container bootstrap fetches a version-matched MoltZap runtime bundle
containing the OpenClaw adapter/plugin, the `moltzap-agentd` executable, and
an integrity manifest, plus slot-specific content. It verifies the manifest,
installs the adapter through a supported OpenClaw plugin path, makes the daemon
executable available to `startAccount`, configures the runtime bridge to the
local daemon MCP surface, and starts the ordinary OpenClaw process. Bootstrap
does not start the daemon.

Late bootstrap does not change daemon supervision. OpenClaw `startAccount`
starts and owns the AgentId-scoped `moltzap-agentd` child, verifies matching
daemon discovery, acquires the sole turn-ready subscription, and terminates
the child during account shutdown. Neither the bootstrap entrypoint nor the
distributed controller supervises a second daemon.

The image need not contain MoltZap. An image with the same verified runtime
bundle preinstalled is a permitted optimization only and must pass the same
conformance path. Failure of the supported stock image to reach slot readiness
is a compatibility defect.

The controller and independent Registry, Router, and Ledger processes also use
digest-pinned platform images. Their digests, like the agent image digest, do
not change for an experiment-only edit. Whether they use one or several
platform images and how those images are released are implementation-scope
choices.

The customer's TypeScript/Effect program, resolved dependency manifest,
instructions, and workspace inputs are immutable content-addressed artifacts.
An experiment-only edit changes artifact digests and does not require a new
agent or controller image. GCS holds these artifacts in the GKE reference
profile; its path layout and exact bundle format are not contractual.

The runtime bridge speaks only the daemon's loopback MCP surface. It never
receives direct Router, Ledger, Registry, database, or protocol-engine
capabilities.

The first distributed conformance slice requires OpenClaw. Other runtime
implementations remain permitted. NanoClaw remains part of the Gate 1
mixed-runtime system test, while NanoClaw distributed conformance is deferred.

## Pod enrollment and identity separation

During run resolution and before creating agent Pods, the testbed accepts a
pre-existing key/profile input or provisions a new key and named endpoint
profile for each declared slot. It performs ordinary explicit Registry
registration with the deployment admission code when required, validates an
already-registered profile otherwise, and resolves the resulting immutable
AgentCard. Those results establish the expected AgentId roster. The deployment
admission code remains outside untrusted agent Pods. No registration operation
is added to Router.

Agent Pods use a per-run Kubernetes ServiceAccount with no RBAC. Automatic
token mounting is disabled. The agent container receives one explicitly
projected, short-lived, Pod-bound token for a run-specific audience and sends
it only to the controller-authenticated confidential enrollment channel.

The controller accepts enrollment only after TokenReview for that audience
and a live Pod read prove:

- `authenticated: true` and the expected audience returned in
  `status.audiences`;
- the exact ServiceAccount namespace, name, and UID;
- the bound Pod name and UID returned by TokenReview;
- the expected run, cohort, slot, and homogeneous-spec bindings;
- no deletion or replacement; and
- no prior different UID for the slot.

The controller derives the slot from its own created metadata. A client-sent
ordinal or AgentId is not authority. Retry by the same Pod UID is idempotent;
a duplicate or changed UID fails the pre-dispatch cohort.

After verification, the enrollment channel returns only the selected slot's
already-assigned bootstrap and key/profile material. The runtime bridge
receives the resulting `EndpointProfileRef`; it never receives another slot's
credential.

The enrollment-facing controller identity receives only permission to create
TokenReviews and inspect the run's Pods and Kueue resources. Any testbed
platform-reconciliation identity is separately limited to the exact
run-scoped resource kinds selected by the implementation. Agent ServiceAccounts
cannot read Pods, Secrets, Workloads, or TokenReviews.

The Kubernetes token attests workload membership only. It is not an AgentId,
AgentCard, L1 signing key, Registry admission credential, or authentication
mechanism for product traffic. Product registration and messages keep their
existing Gate 1 authentication.

## Trust, safety, and progress

The Gate 1 trust and fault model remains in force for product behavior.
Distributed acquisition additionally assumes a correct Kubernetes control
plane for Pod identity and scheduling, a correct TokenReview result, and a
correct testbed controller for workload-to-slot binding and secret release.
It also assumes correct node-kernel and container-runtime isolation. The
one-container boundary does not claim tolerance of a container escape, kernel
compromise, or malicious submitted experiment bundle, and this decision set
makes no direct-peer network-isolation guarantee.

An agent container may still be faulty or malicious after it receives its own
slot material. It cannot become another expected slot merely by claiming that
slot to the controller. Its authenticated operational readiness report proves
only that the enrolled workload emitted the required state transition; it does
not prove honest future behavior.

The readiness barrier is a safety property about when dispatch may occur. It
makes no fairness or fixed-startup-time promise. Progress requires available
cluster capacity, registry and object-store access, healthy production
services, successful bootstrap for every required slot, and a live
controller. Readiness is linearized in controller-observed state and does not
claim a perfect failure detector for a crash whose notification has not yet
arrived.

## Conformance and staged evidence

An implementation may claim functional conformance with the distributed
profile only with a real multi-agent cohort and when:

- manifests and live workload inspection prove exactly one container and one
  AgentId per roster slot, with zero restarts and replacements;
- dispatch evidence occurs strictly after exact roster-ready evidence;
- a pre-barrier failure aborts and releases the whole cohort;
- an autonomous post-dispatch exit remains RunLedger evidence governed by
  customer policy, while release-induced termination is cleanup evidence only;
- the stock OpenClaw image late-installs the adapter and completes a real
  MoltZap path in a small cohort;
- experiment-only changes leave agent and controller image digests unchanged;
- private-registry pulls and generic Kubernetes registry credentials both
  preserve the same workload contract;
- controller failure and cancellation leave no unbounded orphaned capacity
  while the Kubernetes control plane and expired-run reconciler remain
  available;
  and
- abrupt controller loss does not cause Temporal or the cluster reconciler to
  fabricate RunLedger completion.

A two-agent local smoke test may exercise the path while it is being built.
The first implementation gate is a conforming cohort of 10 distinct agent
containers. Full-scale evidence then advances through staged 100, 1,000,
5,000, and
10,000-container runs and measures creation, admission, enrollment, readiness,
dispatch, and cleanup independently. The 1,000–10,000 gates exercise real
OpenClaw containers through bootstrap, readiness, and dispatch without
requiring paid model calls. Provider-backed model exchanges remain a smaller,
separate conformance cohort.

## Deliberate deferrals

This decision set does not select:

- exact TypeScript symbols, constructor names, event tags, or public method
  shapes;
- exact PrincipalId and AgentName allocation, pre-existing-versus-generated
  key/profile sources, and the roster-resolution API;
- authenticated per-slot operational status as a session, poll, lease, or
  other transport, including its schemas, freshness, and binding to Pod
  attestation;
- the package/export/binary ownership of the CLI and TypeScript submission
  surfaces;
- Terraform module structure, Helm release layout, GCP region, machine types,
  resource requests, quotas, autoscaler policy, or timeouts;
- the Kubernetes and PostgreSQL resource shape for the run-scoped independent
  Registry, Router, and Ledger processes and for RunLedger artifact storage;
- controller and Temporal-worker Kubernetes resource shape, placement,
  credentials, and aggregate status transport;
- bundle format, package-manager commands, cache layout, GCS paths, or
  optimized-image release automation;
- one-versus-several controller and Registry/Router/Ledger platform images and
  their release automation;
- source and release ownership for the v2-compatible OpenClaw adapter and
  MoltZap runtime bundle within the existing package/external-consumer law;
- whether and how NetworkPolicy denies direct Pod-to-Pod traffic, plus exact
  Kubernetes label, annotation, audience, token-lifetime, RBAC-resource, TLS,
  Secret-envelope, selector, CIDR, active-deadline, expiry, or reconciler-scan
  literals;
- the expired-run reconciler's resource shape, code owner, placement, RBAC,
  cloud credentials, and deployment mechanism;
- Temporal production hosting, exact Activities, Signals, retry schedules, or
  status schema;
- Nomad, Slurm, managed batch, serverless, Autopilot, or NanoClaw distributed
  implementations;
- controller checkpoint/resume, transparent agent replacement, multi-cluster
  placement, or multi-Router sharding;
- reusable warm societies or multiple program dispatches from one acquired
  cohort;
- concurrent-run and multi-tenant admission, fairness, namespace allocation,
  and cross-run isolation;
- hostile or mutually untrusted submitted experiment code and multi-tenant
  controller isolation;
- 10,000 simultaneous paid model calls.

An implementation must not answer one of these by accident. The first
implementation-scope discussion selects a coherent subset without weakening
the accepted guarantees.
