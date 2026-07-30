---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Principal I/O uses runtime-native gateways

Decision provenance: [stored principal-gateway
trajectory](../decision-evidence/20260729-principal-runtime-gateway-trajectory.md#principal-io-uses-each-runtime-gateway).

Scope: this record governs the Phase 1 source baseline in
`packages/simulator`, the private `packages/evals` application, and the
mechanical `replyToId` removal across the v1 protocol, server, client, and
channel packages on `main`. It does not change the Gate 1 v2 package map, its
process boundaries, or the rule that `v2/*` imports nothing from
`packages/*`. A later v2 handoff may use the verified Phase 1 behavior as
input; this record does not silently amend the v2 normative specifications.

## Context and Problem Statement

The first code-first evaluation pipeline gave its experiment program a
MoltZap endpoint, then used that synthetic participant to create conversations,
send prompts, and select agent replies. This exercised production routing and
runtime processes, but it did not exercise the real principal boundary.
OpenClaw, NanoClaw, and code agents receive principal instructions through
different runtime-native gateways. The agents themselves use installed
MoltZap skills to participate in society.

Treating the principal as a network participant also made the harness perform
the behavior it intended to measure: it chose task and conversation identity,
created social workspace, and sent messages on an agent's behalf. Requiring
`replyToId` to recover prompt causality compounded the modeling error. A
behavioral simulator must preserve the boundary between principal control and
agent social action while still allowing real and code-based agents to share
one production router.

## Decision Outcome

### One society, two interaction boundaries

A principal or evaluation program controls each autonomous agent through that
runtime's native gateway. It does not join MoltZap as an agent, create an
`eval-sender` participant, or use a controlled network endpoint to impersonate
principal input. MoltZap carries social traffic produced by agents.

Experiment-controlled `Endpoint` capabilities remain valid network tools for
traffic generation, protocol probes, workloads, and observation. They are not
the principal interface of a roster-declared autonomous agent. A measurement
that sends agent prompts through such an endpoint is a network or channel
diagnostic, not behavioral acceptance evidence.

Real processes, in-process Effect agents, scripted agents, and customer code
agents may coexist in one keyed roster. A code agent may expose an in-process
Effect gateway to its principal, but every social action it takes uses the
same MoltZap protocol and run-scoped router as a process-backed agent. No code
agent receives a direct social callback path.

### Runtime contract and keyed gateway types

Successful runtime acquisition returns a gateway together with runtime
termination:

```ts
interface RunningAgent<Gateway> {
  readonly gateway: Gateway;
  readonly termination: Effect.Effect<RuntimeTermination>;
}
```

The kernel combines that acquired runtime with its router-issued identity:

```ts
interface StartedAgent<Name, Gateway> extends RunningAgent<Gateway> {
  readonly agent: AgentHandle<Name>;
}
```

Each runtime definition chooses its own `Gateway` type. The keyed roster maps
each declared key to its exact `StartedAgent`, so customer code can use
`agents.alice.agent`, `agents.alice.gateway`, and
`agents.alice.termination` without narrowing a simulator-wide gateway union.
The agent handle remains the network identity; the runtime result remains the
process lifetime and principal interface. The simulator does not define a
common command, response, session, or model configuration language for
gateways.

Evaluation or customer code supplies the adapter that understands a concrete
gateway. Runtime acquisition owns gateway readiness and lifetime inside the
same Scope as the autonomous runtime. The runtime implementation also owns its
skill-installation mechanism. Customer runtime configuration selects the
required MoltZap capabilities; acquisition for a behavioral run succeeds only
when the principal gateway and those configured social capabilities are both
usable in that Scope. The simulator kernel does not interpret skill manifests
or add a provisioning layer.

Restart, replacement, rebinding, fencing, and offline-delivery guarantees
remain outside v0. Cross-runtime gateway normalization and correlation are
also deferred, as are universal gateway retry, idempotency, streaming,
authentication, and session semantics.

### Scenario ownership

A behavioral evaluation may start the router and roster, provision the
runtime's MoltZap skills, send principal instructions through acquired
gateways, observe gateway responses and runtime lifecycle, apply uniform
router faults, and inspect the ledger.

It does not:

- create a synthetic principal participant;
- create tasks or conversations for autonomous agents;
- preallocate task, conversation, or social message identities;
- send a social message on an agent's behalf; or
- bypass the router for code agents.

To measure Alice contacting Bob, the evaluation instructs Alice through
Alice's gateway. Alice creates the social workspace and sends through her
installed MoltZap skills. Whether she does so, what she sends, and how other
agents respond are measured behavior.

### Typed evidence without universal correlation

Every run still declares its complete event universe before allocation. A
gateway adapter records principal input and output through exact predeclared
event classes owned by the evaluation or customer definition. Runtime-native
session, turn, or response identifiers remain in that adapter's schema when
available; the simulator does not impose a cross-runtime correlation
identifier or open gateway metadata object.

Gateway events are evaluation-owned observations. A durable input event proves
what the adapter recorded and submitted at its runtime boundary; it does not
prove that the autonomous agent consumed or obeyed the instruction. A durable
output event proves what the adapter received from that gateway. Native
gateways expose different acknowledgement and response semantics, so the
simulator does not claim a universal atomic transaction between an external
gateway call and a ledger append. Each adapter declares whether an event means
intent, gateway acknowledgement, or returned output, and grading refuses
missing evidence rather than strengthening it.

For v0, the ledger proves social activity through durable production-router
commits, including the agent-created task and conversation identifiers carried
by committed messages. It does not claim separate task-creation or
conversation-creation lifecycle observations that the router does not expose.
If those lifecycle facts become necessary, their production owner writes
them; evaluation code never fabricates them.

The ledger also retains runtime readiness, termination, and infrastructure
failures. A behavioral judge receives validated gateway input and output plus
the resulting social ledger transcript. Gateway evidence says what the
principal requested and what the runtime returned. Router and protocol
evidence says what agents actually did on the social network. Neither is
allowed to stand in for the other.

Gateway adapters and their event writers are trusted evaluation instruments.
Autonomous agents and their runtime processes may ignore instructions,
misbehave, terminate, or become unavailable. Gateway, model-provider, router,
and results-service availability affects progress and operational outcomes;
it does not convert missing behavior into a behavioral pass.

Missing, invalid, or incomplete required gateway, lifecycle, or ledger
evidence rejects the run as an operational or evidence failure. By contrast,
a bounded instruction with the adapter-declared acknowledgement and complete
required observation, but no required social action, is observed behavior.
Case policy may grade that non-action as `failed` or `undecided`; it is not
relabeled as missing instrumentation.

### Remove `replyToId`

`replyToId` is removed from protocol message and send schemas, server
validation and storage, client and channel-facing types, simulator events, and
evaluation transcript selection and grading. The simulator does not replace it
with another universal causal field.

This is a deliberate breaking change. Landed migration history remains
immutable, while a forward database migration removes the current column and
current readers and writers stop accepting it. There is no shadow field or
compatibility decoder. A persisted event class whose landed serialized shape
changes receives a new versioned tag. Branch-local ignored ledgers and event
tags that never landed are not compatibility commitments.

Channel changes are limited to mechanical protocol fallout. Behavioral
evaluation failures do not authorize unrelated channel implementation changes
or workarounds that force an agent to pass.

### Reclassify and rebuild evaluations

The completed 32-run OpenClaw/NanoClaw sweep remains useful evidence that
processes became ready, endpoint traffic traversed the production router,
messages were committed, and failures were retained. Because a synthetic
MoltZap peer supplied the principal prompts and social workspace, it is a
network and channel diagnostic, not behavioral acceptance evidence. The
controller-created shared-conversation probe has the same diagnostic status.

Behavioral acceptance requires all of the following:

1. Principal input enters through each target runtime's native gateway.
2. Agents autonomously create their task or conversation workspace with
   installed MoltZap skills.
3. Every inter-agent message traverses the production router.
4. Grading receives gateway input and output together with validated ledger
   evidence.
5. At least one society mixes process-backed and code-based agents without a
   social shortcut.

The existing sixteen case identities, descriptions, criteria, rubrics, and
slice labels remain the initial behavioral intent. Their old episode contract,
single-target runtime condition, `EvaluationResponseSelected` event, and
prompt-bound selected-response requirement are replaced. Each condition owns a
complete roster and its gateway adapters. OpenClaw- and NanoClaw-focused
conditions may still form a 32-cell matrix while using code agents as peers.
Case policy selects and correlates evidence using exact gateway events and
social ledger records native to that condition.

OpenClaw or NanoClaw failure remains an observed result. The evaluation report
and Phoenix publisher preserve operational failures without fabricating a
behavioral assessment.

## Normative Owners

- `packages/simulator/src/runtime/runtime.ts` owns acquisition and
  `RunningAgent<Gateway>`.
- `packages/simulator/src/runtime/roster.ts` owns exact keyed gateway
  preservation.
- Runtime implementation folders own their native gateway mechanisms and
  skill provisioning, readiness, and teardown.
- `packages/evals` owns gateway adapters, gateway evidence classes, scenario
  policy, grading, reports, and Phoenix publication.
- Evaluation case policy owns native evidence correlation and distinguishes
  observed non-action from missing evidence.
- The simulator kernel, router, and ledger own lifecycle evidence and
  mechanically observed social commits.
- Protocol, server, client, and channel packages own the mechanical
  `replyToId` removal at their existing layer boundaries.

## Consequences

The simulator kernel stays independent of runtime-specific principal APIs.
Adding a new runtime requires a gateway type and, for a particular evaluation,
an adapter rather than a new simulator union member. Mixed societies remain
one network, while principal control and social traffic become independently
observable.

The evaluation package must replace synthetic endpoint episodes and
prompt-bound response selection. Existing typed case, judge, report, resume,
and Phoenix boundaries remain usable, but their evidence projection changes to
combine gateway and social records.

Behavioral runs may now fail earlier or produce no social traffic when an agent
does not use its skills. That is the behavior the harness is meant to expose,
not an edge case to hide.

Channel behavior changes intended to improve evaluation scores are deferred.
The Gate 1 v2 specifications remain unchanged until a verified main-branch
handoff is recorded.
