---
status: accepted
date: 2026-08-01
decision-makers: Tapan Chugh
---

# The main simulator runs container societies on Kubernetes

Decision provenance: [main Kubernetes society execution trajectory](../decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md#main-simulator-runs-container-societies-on-kubernetes).

## Scope and authority

This record governs real v1 society execution in `packages/simulator` and its
`packages/evals` consumer on `main`. It does not amend the v2 simulator/testbed
package split, the v2 `Simulator.define` port contract, the Gate 1 manifest,
`v2/*`, or the draft decisions in #917. Those v2 authorities remain untouched.

The binding outcome is this record's Decision Outcome, including its public
contract, lifecycle invariants, assumptions, compatibility rules, normative
owners, and deliberate deferrals. Issue #936 is the non-normative execution
plan and acceptance checklist. Historical ADR bodies and transition notices
explain lineage or current implementation state; they do not extend this
contract.

## Context and Problem Statement

The current main simulator runs a definition-bound customer Effect after
acquiring host processes and in-process runtimes around a Docker-hosted v1
router. The private evaluation application builds sixteen cases against two
runtime conditions on that engine. This proves typed event catalogs, durable
ledgers, runtime-native principal gateways, grading, SQLite resume, and Phoenix
publication, but it does not provide a reconstructible distributed run, an
all-roster admission unit, durable execution attachment, or generation-aware
container lifecycle.

Making the Kubernetes work an example or a second backend would leave the
product with two execution semantics and would let evaluations continue to
exercise the host engine. The core simulator instead needs one authoring and
execution contract that runs the same container society on a local Kubernetes
cluster or on GKE, preserves the useful v1 evidence and evaluation boundaries,
and fails closed when the platform cannot supply those guarantees.

## Decision Outcome

### One package, one real execution path

`@moltzap/simulator` remains the only package that owns real society
execution. It owns the public run contract and CLI; the private kernel;
Kubernetes, Kueue, Agent Sandbox, and Temporal adapters; the controller and
worker; module and outcome artifacts; the execution-binding and ledger
authority; cluster profiles; deployment assets; simulator support images; the
run-scoped production v1 router/server; and cleanup and qualification logic.

`packages/evals` remains a domain consumer. It owns its cases, deterministic
peer policies and peer application image, grading, reports, SQLite authority,
and Phoenix publication. It submits those peers as container descriptors to
the same simulator path as OpenClaw and NanoClaw.

Kubernetes is the only real distributed execution backend. Docker is used only
to build images and as the substrate for kind and its registry. An internal
fake backend tests the kernel. There is no Docker executor, host-process
executor, in-process production peer, compatibility runner, or public
Kubernetes/Kueue/Temporal lifecycle API.

The package keeps the existing root, `./runtime`, `./network`, and `./ledger`
facades and adds no export subpath. Platform and orchestration modules are
private.

### Binding public contract

The root facade exposes four frozen namespaces: `RunSpec`, `Agent`,
`Infrastructure`, and `Run`. A society module default-exports one nominally
branded `RunSpec` whose API discriminator is
`moltzap.run-spec/v1`. Callers cannot construct any of these branded values
structurally.

The following names, fields, and semantics are binding. Generic parameter
ordering may follow Effect's type conventions without changing the contract.

```ts
export default RunSpec.define({
  id: "acme.echo-society/v1",
  input: InvocationSchema,
  result: ResultSchema,
  failure: ProgramFailureSchema,
  events: [customerEvents],
  agents: ({ input }) => ({
    alice: Agent.container({
      image: "registry.example/acme/alice@sha256:<64 lowercase hex>",
      bridge: openClawContainerBridge(/* schema-backed configuration */),
      resources: {
        cpuMillis: 500,
        memoryBytes: 536_870_912,
        ephemeralStorageBytes: 1_073_741_824,
      },
      persistentState: {
        mode: "run",
        capacityBytes: 2_147_483_648,
      },
      secrets: {
        modelProvider: Agent.secret("acme.model-provider/v1"),
      },
    }),
  }),
  execute: ({ input, agents, events, ledger, network }) =>
    Effect.succeed(/* a ResultSchema value */),
});
```

`RunSpec.define` is synchronous. It validates and recursively freezes the
static definition but does not evaluate `agents`. `id` is a namespaced,
versioned identifier. `events` is a required, possibly empty, tuple of closed
`EventCatalog` values. `input`, `result`, and `failure` are context-free Effect
Schemas whose encoded sides are finite JSON values. Excess properties are
rejected at every remote boundary.

`Run.execute` accepts the decoded `input` type. Before an execution binding or
run resource exists, the submitter strictly encodes it, requires a JSON value,
canonicalizes it with RFC 8785 JCS, hashes the canonical bytes with SHA-256,
strictly decodes those bytes again, and recursively freezes the decoded value.
The controller performs the same decode and freeze over the stored canonical
bytes. `agents` and `execute` therefore see immutable decoded values; neither
sees caller-owned mutable input.

`agents({ input })` is synchronous, deterministic, and total. A throw, Promise,
Effect, empty roster, roster larger than 10,000, invalid agent name, or
non-container descriptor is a definition rejection. Submission and controller
evaluate it independently. They canonicalize the descriptor projection with
JCS and reject a digest mismatch before an agent resource exists. Import-time
and roster-construction side effects are unsupported. Submitted source remains
trusted code rather than a hostile-code sandbox.

`execute` receives:

- the frozen decoded input;
- an exact keyed record of stable agent slots with the roster's inferred
  gateway types;
- definition-bound customer event emission and a readable live ledger;
- the retained controlled-probe and scoped-link capabilities from the network
  facade.

It returns `Effect<Result, Failure, never>`. The source module constructs every
customer service it needs. Submitter-local Effect requirements do not cross
the controller boundary. Controlled endpoints remain valid network probes,
but they are neither roster agents nor principal gateways, and their traffic
is diagnostic evidence rather than behavioral acceptance evidence.

```ts
Run.execute(spec, {
  source: new URL("./society.mjs", import.meta.url),
  input,
  executionId,
  infrastructure: Infrastructure.kubernetes({ profile: "local" }),
});

Run.open(spec, receipt.ledger);
```

`source` is a file URL. Its imported default export must be the passed branded
spec with the same API discriminator and static contract. The source digest is
SHA-256 over a deterministic content-addressed artifact containing the compiled
ESM entry, its complete transitive runtime dependency closure, and a canonical
manifest of build-tool identity and options. It is not a path or a digest of
the entry file alone.

`executionId` is a nonempty string of at most 256 UTF-8 bytes with no control
characters. It may contain `/` and never appears directly in Kubernetes or
Temporal resource names. It is recorded as evidence and must not contain a
credential or other secret. The same definition can run unchanged with either
of these only public infrastructure values:

```ts
Infrastructure.kubernetes({ profile: "local" });
Infrastructure.kubernetes({ profile: "gke", context: "required-context" });
```

The local profile uses the repository-owned cluster context. GKE requires an
explicit kube context. Context text is operator selection, not identity. A
resolved infrastructure authority derives from the immutable cluster and
simulator-installation identities. Cluster recreation or simulator
reinstallation intentionally produces a different authority.

`Agent.container` accepts a closed descriptor with no index signature:

- `image` is an OCI reference containing a literal SHA-256 manifest digest;
- `bridge` is a nominal runtime bridge from the existing `./runtime` facade;
- `resources` contains positive safe-integer `cpuMillis`, `memoryBytes`, and
  `ephemeralStorageBytes`; Kubernetes requests equal limits;
- `persistentState` is either `{ mode: "run", capacityBytes: positive }`, a
  run-scoped PVC deleted at cleanup, or `{ mode: "ephemeral" }`;
- `secrets` has exactly the bridge's declared Secret-slot keys and opaque
  logical `SecretRef` values created by `Agent.secret`.

The descriptor cannot express a command, environment value, mount, init
container, sidecar, RuntimeClass, ServiceAccount, Pod template, host setting,
or arbitrary Kubernetes/Docker/provider flag. The first execution profile
requires every roster entry to have the same resource numbers and rejects a
heterogeneous roster before execution binding. RuntimeClass overhead is part
of the resolved profile and admission projection, not caller input.

The `./runtime` facade owns `defineContainerBridge`, the generic extension
used by the eval-owned peer, and the shipped OpenClaw and NanoClaw bridge
constructors. A bridge has a versioned id, Schema-backed configuration, an
exact Secret-slot tuple, typed request/stream procedures, and an inferred
gateway. Its transport exposes no raw hostname, socket, Kubernetes object, or
process configuration to `execute`. The exact wire envelope and stock-image
bootstrap are compatibility-profile inputs frozen only after their live spike;
failure of a one-application-container bridge blocks that runtime rather than
creating a sidecar, init-container, or host fallback.

`SecretRef` names a profile-resolved immutable provider version, never secret
bytes or a secret digest. Resolution precedes execution binding and the
non-secret provider-version identity participates in the roster digest. The
profile copies the exact version into one immutable, read-only, per-slot
Kubernetes Secret volume. Rotation creates a different resolved roster. A
provider unable to name an immutable version is rejected.

### Stable slots and execution generations

One roster key is one stable logical slot and one stable AgentId for the run.
It maps to one direct Agent Sandbox with one application container. Kueue,
Temporal, controller, router, artifact, DNS, and storage processes are not
agents.

An agent generation is the observed pair of backing Pod UID and application
container restart count. The controller assigns a monotonically increasing
positive generation id whenever that pair changes. Pod details stay in the
qualification proof; the program receives only the opaque generation id.

Each program slot exposes the stable AgentId, a typed gateway proxy, its
initial ready-generation snapshot, and a replayable ordered stream of later
ready/lost generation events backed by the live ledger. A gateway call binds
to the current ready generation when the call starts. It is never moved to a
replacement mid-call. Loss maps through the bridge's typed unavailable or
termination failure. New calls use a later ready generation; active turns,
subscriptions, response streams, and volatile cursors never replay.

Readiness requires the application bridge and its configured MoltZap
capabilities to be usable. Generation loss invalidates readiness immediately.
Kubernetes and Temporal objects never enter the program context.

### Start-or-attach identity and durable artifacts

The profile-scoped artifact authority, which outlives every run namespace,
owns an immutable execution binding keyed by:

```text
(infrastructure authority, definition id, executionId)
```

It atomically compare-creates the first binding. That binding contains the API
version, source digest, canonical input digest, resolved roster digest,
resolved profile digest, and non-secret artifact identities. This is the
linearization point for simultaneous submitters and remains retained for at
least as long as the run outcome and ledger. Reuse is not automatic, including
after Temporal history retention expires.

The Temporal Workflow id is derived from a domain-separated SHA-256 hash of
the infrastructure authority, definition id, and execution id. It does not use
the later RunLedger run id. An exact retry attaches to the bound Workflow or
returns the stored terminal outcome and identical receipt. A changed source,
input, roster, profile, or authority is `RunExecutionConflict` and creates no
new binding, Workflow, ledger, or Kubernetes object. Loss of client
connectivity after the binding exists is not a no-resource failure.

If binding succeeds but Temporal start or ledger allocation is unavailable,
the binding remains resumable and an exact retry continues the same execution.
The Workflow allocates one RunLedger and run id. That run id names only the
ledger, controller, namespace, Workload, Sandboxes, Secrets, PVCs, policies,
router, diagnostics, and receipts.

Encoded program results and failures, sanitized defects, the ledger, and
cleanup proof are stored in the profile-scoped artifact authority. This lets a
completed retry return the original decoded result or failure rather than only
a ledger reference. An authority-bearing `LedgerRef` contains no path or
credential and is resolvable by `Run.open` in a different process using the
authority's ambient authentication. Existing unqualified local LedgerRef
strings remain valid through the read-only legacy filesystem resolver.

A completed run receipt contains the execution id, definition id, run id,
LedgerRef and LedgerCompletion, outcome-artifact digest, and cleanup-proof
digest. An incomplete receipt contains the execution/definition/run ids and
LedgerRef plus any available outcome/proof digests and normalized residue. Raw
encoded input and output artifacts do not enter ledger records, proof bundles,
or CLI diagnostics. Credentials use `SecretRef`; callers do not place Secret
bytes in input.

### Outcome and error model

Before ledger allocation, `Run.execute` has this closed typed error channel:

- `RunDefinitionRejected` for source/default-export/spec/roster or
  deterministic-artifact rejection;
- `RunInputRejected` for input encode, finite-JSON, strict-decode, or size
  rejection;
- `RunProfileRejected` for an incompatible, drifted, or unsupported installed
  infrastructure profile;
- `RunExecutionConflict` with the execution id and a nonempty conflict set
  drawn from `source | input | roster | profile | authority`;
- `RunStartUnavailable` after a valid binding cannot currently start or query
  its Workflow;
- `RunAllocationFailed` when the bound Workflow cannot allocate its ledger.

Safe digests may appear in these errors; raw input, Secret material, raw
causes, and authentication data may not. A pre-ledger error has no receipt.

After ledger allocation, every ordinary terminal path returns one of:

```ts
type ProgramExit<Result, Failure> =
  | ProgramSucceeded<Result>
  | ProgramFailed<Failure>
  | ProgramDefected
  | ProgramInterrupted;

type RunOutcome<Result, Failure> =
  | RunFinished<Result, Failure> // completed receipt and one ProgramExit
  | RunInfrastructureFailed<Result, Failure>; // receipt plus any known exit
```

`ProgramSucceeded` and `ProgramFailed` contain the strictly encoded value and
its digest. `ProgramDefected` contains only a bounded sanitized kind and
diagnostic digest. `ProgramInterrupted` has reason `cancel-requested`.
`RunInfrastructureFailed` contains a phase drawn from
`artifact | router | admission | acquisition | barrier | program-output |
ledger | controller | cleanup`, a code drawn from
`deadline | unavailable | rejected | schema-drift | observation-lost |
resource-mismatch | generation-lost | controller-lost | storage-failed |
residue-remains`, the completed or incomplete receipt, normalized non-secret
residue identifiers, and any program exit already encoded before
infrastructure failure. A typed program failure with successful finalization
is `RunFinished`, not infrastructure failure.

Caller Effect interruption remains interruption. After acceptance it requests
bounded Workflow cancellation/finalization and then gives caller interruption
precedence; it does not fabricate a `RunOutcome`. An exact later call attaches
and observes the durable terminal outcome. The CLI maps SIGINT and SIGTERM to
this path and exits 130 and 143. Process death cannot request cancellation;
Temporal continues observation and deterministic cleanup, never program
recovery.

### Aggregate admission, barrier, and dispatch fence

Each execution creates one manual aggregate Kueue Workload with one PodSet,
`count` equal to the frozen roster size, and no `minCount`. The first profile
uses one homogeneous resource shape. Native per-Sandbox Workloads, queue labels
on Sandboxes, partial admission, borrowing, and preemption are prohibited.
No Sandbox exists before complete logical-quota admission.

The adapter normalizes and proves equality among descriptor resources,
RuntimeClass overhead, admitted PodSet assignments, Sandbox templates, and
live Pods. Unknown schema, mutation, or observation discontinuity invalidates
the barrier and fails closed if reconciliation cannot restore a complete
view. Kueue admission is logical quota reservation, not physical gang
scheduling or proof of schedulable nodes.

The controller appends exact-roster-ready evidence only while every slot's
current generation is ready. It immediately rechecks the same generation set,
then appends the single durable dispatch fence before calling `execute`.
Pre-dispatch loss returns to acquisition. After the fence, replacement may
become ready and serve later gateway calls, but no event or state permits a
second invocation.

This is an at-most-once guarantee across failures. A controller that remains
live after the acknowledged dispatch fence makes exactly one call to
`execute`. Controller loss before the fence can produce zero calls; loss after
the fence can leave zero, partial, or complete external effects. The simulator
does not provide exactly-once gateway calls, model requests, messages, or other
customer side effects.

### Controller, Temporal, and cleanup ownership

There is one Temporal Workflow and one non-replacing controller Pod per
execution binding. The controller application container uses restart policy
`Never`. Retried aggregate activities find and reconcile the same controller
identity; neither Temporal nor Kubernetes starts a replacement after the
durable controller-start fact exists. Controller loss is terminal.

Temporal activities start/find the controller, observe bounded status,
collect artifacts, and clean deterministic resources. There is no per-agent
Workflow, Activity, Signal, child Workflow, or history item.

The controller is the only simulator-event producer for lifecycle facts. It
encodes the program exit, seals the immutable ledger record stream, and exits.
A Temporal finalizer then deletes Sandboxes owner-first, verifies backing Pods
and all other run-owned resources are absent, writes a non-event cleanup proof,
publishes the existing ledger completion marker, stores the terminal outcome,
and closes the execution binding. It may not append or rewrite simulator
records. Profile-scoped support services and artifact storage are not
run-owned residue.

Success requires confirmed absence of run-owned resources. Permission,
availability, or observation failure returns an incomplete receipt with exact
known residue; it never reports success. If the controller is lost before it
seals records, external cleanup may proceed but no actor invents a sealed
ledger or completion evidence.

### Closed core event contract

Existing v1 tags and fields do not change. New runs use a Kubernetes core
catalog that retains applicable router, endpoint, link, and ledger events,
does not emit host-runtime lifecycle tags, and adds these exact versioned
classes:

| Class and tag | Exact payload |
|---|---|
| `RunExecutionBound`, `moltzap.run-execution-bound/v1` | `definitionId`, `executionId`, `apiVersion: "moltzap.run-spec/v1"`, `sourceDigest`, `inputDigest`, `rosterDigest`, `profile: "local" | "gke"`, `profileDigest`, `infrastructureAuthorityDigest` |
| `CohortAdmissionRequested`, `moltzap.cohort-admission-requested/v1` | `agentCount` positive integer, `rosterDigest`, `resourceShapeDigest` |
| `CohortAdmitted`, `moltzap.cohort-admitted/v1` | `agentCount` positive integer, `rosterDigest`, `resourceShapeDigest`, `admissionDigest` |
| `AgentGenerationReady`, `moltzap.agent-generation-ready/v1` | `agentName`, `agentId`, `bridgeId`, `generationId` |
| `AgentGenerationLost`, `moltzap.agent-generation-lost/v1` | `agentName`, `agentId`, `generationId`, `phase: "before-dispatch" | "after-dispatch"`, `reason: "readiness-lost" | "generation-replaced" | "runtime-terminated" | "observation-discontinuity"` |
| `RosterReady`, `moltzap.roster-ready/v1` | `rosterDigest`, `generationSetDigest`, `generations`: nonempty exact roster sorted by `agentName`, each containing `agentName`, `agentId`, `generationId` |
| `ProgramDispatchAttempted`, `moltzap.program-dispatch-attempted/v1` | `rosterReadyEventId`, `generationSetDigest`, `attempt: 1` |
| `ProgramSucceededV2`, `moltzap.program-succeeded/v2` | `resultDigest` |
| `ProgramFailedV2`, `moltzap.program-failed/v2` | `failureDigest` |
| `ProgramDefected`, `moltzap.program-defected/v1` | `defectKind: "effect-defect" | "result-encode-failed" | "failure-encode-failed"`, `diagnosticDigest` |
| `ProgramInterruptedV2`, `moltzap.program-interrupted/v2` | `reason: "cancel-requested"` |
| `RunLifecycleFailed`, `moltzap.run-lifecycle-failed/v1` | `phase: "artifact" | "router" | "admission" | "acquisition" | "barrier" | "program-output" | "ledger" | "controller"`, `code: "deadline" | "unavailable" | "rejected" | "schema-drift" | "observation-lost" | "resource-mismatch" | "generation-lost" | "controller-lost" | "storage-failed"`, `diagnosticDigest` |

Every digest in these events is lowercase hexadecimal SHA-256. Schemas enforce
shape, while the kernel enforces event order and cardinality: admission request
precedes admission; admission precedes generation readiness; `RosterReady`
contains exactly one current generation per frozen slot; dispatch references
that same generation set after the immediate recheck; zero or one dispatch
exists; and a terminal program event requires dispatch. A lifecycle-failure
event is best-effort evidence only because controller or ledger loss can
prevent it. There is intentionally no cleanup-completed event: the controller
cannot truthfully observe its own deletion.

### Security, trust, safety, and liveness assumptions

Submitted ESM, the cluster administrator, simulator controller/worker/finalizer,
Kubernetes control plane and API, Kueue and Agent Sandbox controllers,
Temporal service and persistence, execution-binding/artifact/ledger storage,
registry digest resolution, DNS and policy enforcement, and the v1
router/server are trusted for the stated safety properties. A malicious or
incorrect one can violate them. Application containers and their outputs may
be faulty or malicious.

Agent Sandbox owns lifecycle. It is not itself the isolation guarantee. A
qualified runtime such as gVisor, the cluster policy, and the trusted control
plane supply the claimed container boundary. Local kind uses a trusted rootful
Linux/amd64 host and makes no hostile-code or isolation-parity claim until its
pinned runtime and CNI gates pass. Only a passing managed GKE suite may claim
managed isolation qualification.

The simulator creates no agent RoleBinding, ClusterRoleBinding, Workload
Identity binding, or projected ServiceAccount credential and disables token
automount. Agent Pods run non-root, drop all capabilities, have explicit
requests/limits, and receive no host namespace, path, port, privilege, or
Docker socket. Default-deny policy permits DNS, the run router, the bridge and
artifact path, and an optional in-cluster allowlisted provider proxy. It denies
direct peer traffic and direct provider egress.

Simulator-owned controller, worker, ledger, CLI, and proof collection never
intentionally serialize credential bytes and redact recognized Secret
material. Peers receive no cross-slot credential. The owning application must
read its own credential and can disclose it; preventing that is not a claimed
property. Kubernetes Secret storage is not claimed to be an independent vault
or encryption guarantee.

Safety requires the durable execution binding, dispatch fence, storage, and
controller/finalizer behavior described above. Liveness additionally requires
Temporal, storage, registry, DNS, router, Kubernetes and its controllers,
logical quota, physical capacity, every current generation, bridges, and any
provider proxy used by the program to remain available. Starvation, partition,
controller loss, or cluster deletion may stop progress but does not authorize
replay or weakened admission.

### Compatibility and evaluation cutover

`LEDGER_FORMAT_VERSION = 1`, admitted manifest/envelope/completion schemas, and
existing event tags remain unchanged. The Kubernetes catalog uses new tags.
Legacy event classes and ledger readers remain available only for read-only
artifact compatibility. An exact reader accepts either its registered legacy
catalog or its registered Kubernetes catalog; it never accepts an arbitrary
subset or unknown tag.

Definition id is the semantic family. The API discriminator and source digest
are executable identity. New evaluation source uses a new definition version.
Legacy UUID ledger refs remain readable through the filesystem resolver; new
refs are opaque authority-bearing strings containing no path or credential.

The cutover removes executable `simulator.define(...).run(...)`,
`simulatorLayer`, host-process runtime constructors, `AgentRuntime.acquire`,
`defineRuntime`, `effectRuntime`, and production in-process peers. No wrapper
delegates those APIs to the new executor. Legacy schemas, value types needed
to decode evidence, raw `openLedger` under `./ledger`, and evaluation report
decoders remain.

The evaluation matrix remains sixteen cases by OpenClaw and NanoClaw,
concurrency one. Each cell maps its existing `attemptId` directly to
`executionId`. Resume attaches to the same binding, Workflow, controller,
ledger, outcome, and receipt; it does not rerun a missing SQLite cell. Reports
add a new format for Kubernetes outcomes while existing reports remain
readable and publishable. There is no second production executor.

### Normative owners

- This ADR owns the v1 public and lifecycle decision until implementation
  surfaces below encode it.
- `packages/simulator/AGENTS.md` owns package boundary and dependency law.
- `packages/simulator/src/definition.ts` owns `RunSpec`, `Agent`, static
  validation, canonical input/roster projection, and inference.
- The existing `./runtime` facade owns bridge definitions and OpenClaw and
  NanoClaw bridge constructors.
- `packages/simulator/src/execution.ts` owns `Infrastructure`, `Run`, execution
  binding, public outcomes, errors, and receipts.
- `packages/simulator/src/events/` and `src/ledger/` own exact evidence schemas,
  legacy reading, live reading, and artifact validation.
- `packages/simulator/src/kernel/` owns lifecycle state, generations, barrier,
  dispatch fence, and record sealing without platform types.
- Private `src/platform/`, `src/orchestration/`, `src/controller/`, and
  `src/artifacts/` own Kubernetes/Kueue/Sandbox, Temporal/finalization,
  controller execution, and durable artifacts.
- `packages/simulator/deploy/`, `images/`, CLI code, and Nx targets own the two
  installed profiles and distribution.
- `packages/evals` owns its peer image/bridge policy, case program, grading,
  reports, resume transaction, and Phoenix publication.

### Deliberate deferrals

The upstream compatibility slice must prove and freeze exact versions,
digests, checksums, served Sandbox schemas, aggregate Kueue projection,
single-container OpenClaw/NanoClaw bootstrap, local runtime/CNI behavior,
regional GKE add-on behavior, durable Temporal deployment, artifact-authority
schemes, bridge wire envelope, timeouts, and profile limits. These are
profile-owned mechanisms, not unresolved public semantics. A failed gate
blocks that profile or requires a replacement ADR; it never enables a fallback
engine or weaker lifecycle.

Production Temporal hosting and HA, concurrent-society fairness, borrowing,
preemption, physical gang scheduling, multicluster dispatch, hostile submitted
module isolation, automatic execution-id reuse, local macOS/Windows/rootless
support, at-rest security certification, and exactly-once external side
effects are outside this decision.

Persistent per-agent storage and artifact design above the measured 100-agent
gate, plus 1,000/5,000/10,000 feasibility, latency, resource, throttling, and
cost budgets, remain measured qualification decisions. The ladder stops at the
first failed rung.

## Earlier outcomes replaced and retained

| Earlier record | Retained current scope | Replaced main/v1 scope |
|---|---|---|
| [`20260727-code-first-simulator-kernel.md`](./20260727-code-first-simulator-kernel.md) | TypeScript/Effect authoring, closed EventCatalog, typed RunLedger, producer-bound evidence, customer-owned scenarios/sweeps/completion/grading, one simulator package, production v1 router/protocol | `Simulator.define`, definition-bound `.run`, `simulatorLayer`, host/mixed runtime acquisition, Docker/process/filesystem execution composition, and restart/replacement deferral |
| [`20260729-principal-io-uses-runtime-gateways.md`](./20260729-principal-io-uses-runtime-gateways.md) | Principal-native control versus MoltZap social traffic, exact typed gateways, no universal gateway union/correlation id, no synthetic-principal shortcut, gateway/social evidence distinction | `RunningAgent`/`StartedAgent` acquisition shape, in-process Effect production peers, readiness as host acquisition, and replacement outside v0; stable slots and generations now govern |
| [`20260729-effect-native-evaluation-results.md`](./20260729-effect-native-evaluation-results.md) | Sixteen-by-two catalog, typed reports, deterministic/semantic grading, SQLite authority, Phoenix materialization, sanitized provenance, old-report reading | Host runtime snapshots and execution outcomes, runtime factories/in-process peers, and resume by rerunning a missing cell; schema-bound container input and start-or-attach govern |

The accepted v2 simulator-system-driver record and Gate 1 manifest are outside
this lineage and remain unchanged.

## Consequences

The main simulator becomes a distributed container-society product rather
than a host runtime harness. Local and GKE runs share one authoring contract,
state machine, evidence model, evaluation path, and conformance suite while
retaining profile-specific qualification facts.

The hard cut is intentionally source-breaking. Customers rewrite definitions
and runtime construction once; they do not choose between old and new engines.
Existing evidence and reports remain inspectable without keeping executable
legacy machinery.

The simulator gains substantial private platform and operational ownership.
That cost is bounded by one package, one aggregate orchestration path, one
fake seam, fail-closed upstream profiles, repository-owned distribution, and
measured scale gates. Platform availability may prevent progress, but cannot
silently weaken roster admission, generation fencing, replay safety, Secret
separation, or cleanup truthfulness.
