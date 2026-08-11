# Four-layer v2 cutover plan

Status: **APPROVED EXECUTION PLAN — NON-NORMATIVE UNTIL AUTHORITY GATE PASSES**

Date: 2026-08-11

Branch: `cutover/four-layer-v2`

This is the durable execution plan for replacing the eight-layer Gate 1
design and retiring v1. Normative behavior continues to live in
`AGENTS.md`, `v2/VISION.md`, current ADR outcomes, and `docs/spec/`.
No v2 implementation step governed by a changed decision may begin until
the replacement authority, lineage, specifications, and blind-review
evidence described below have landed on this branch.

## Outcome

MoltZap cuts over to one four-layer social harness:

1. **Identity** binds an agent to its cryptographic identity.
2. **Communication** delivers opaque messages and lets endpoints form
   reliable conversations backed by their own certified history.
3. **Tasks and norms** build coordinated work and action-validity rules on
   conversation records.
4. **Personal trust** lets each endpoint decide what to accept, disclose,
   attend to, and rely on.

Monitoring, institutional credentials, institutions, and governance are
not infrastructure layers. They are agents and task protocols built
recursively on the same four layers. A monitor is an agent assigned an
observation task. An institution is an agent or society that issues
statements through ordinary conversations. Governance is a set of tasks
and norms. Querying or reconciling another agent's private history is a
task whose disclosure is controlled by that agent's personal trust policy.

There is no central product Ledger, profile system, transcript service, or
testbed package. Each conversation member maintains its own durable copy
of certified conversation history. The existing simulator `RunLedger`
remains simulation evidence and is not a product Ledger.

## Architecture invariants

### Identity

- The Registry remains the authoritative bootstrap and lookup boundary for
  immutable agent identity.
- Registration commits one identity into one daemon's local state.
- Identity does not carry institutional policy, governance status, or a
  deployment profile.

### Communication

- The Router remains a trusted, correct, non-equivocating service for the
  first executable profile.
- The Router sees attributed addressing and opaque bytes only. It owns no
  conversation, task, norm, history, certificate, or policy semantics.
- Conversation membership, protocols, records, recovery, and local
  persistence belong to endpoints in `@moltzap/client`.
- Fixed membership is the first cutover profile. Dynamic membership is a
  later protocol built above the fixed-member record model.
- Every member stages the exact canonical, hash-linked record locally
  before signing a durability vote for that record.
- Action validity and storage durability use different certificates.
  `OpenFloorV1` remains unanimous for action validity. A durability
  certificate proves replicated storage only and never makes an action
  semantically valid.
- For `n < 4`, every member must sign the durability certificate. For
  `n >= 4`, let `f = floor((n - 1) / 3)` and require `n - f` durability
  signatures.
- Any member may assemble and disseminate a completed durability
  certificate. Finalization is not tied to the action author remaining
  available.
- Successful start and reply operations return the locally durable,
  certified proof: `ConversationId`, `TxnId`, `RecordHash`, and the
  durability certificate. `LedgerOffset` does not exist.
- Ordinary missing-history catch-up is automatic communication behavior.
  Cross-agent disclosure, audits, and reconciliation of private histories
  are explicit tasks governed by personal trust.
- After a Router restart, members reconcile the latest certified head and
  sign a new Router-instance epoch anchor for the same conversation. A
  restart does not permanently fence the conversation.

### Tasks, norms, and personal trust

- Tasks and norms consume certified conversation records and never add
  semantics to the Router.
- Norms define action-validity certificates independently from durability
  certificates.
- Personal trust stays local. It controls signing, attention, disclosure,
  task acceptance, and which agents' claims an endpoint relies on.
- Later monitoring, credentials, institutions, and governance use public
  task and conversation interfaces. They do not gain privileged imports or
  hidden network paths.

## Final public interface

`@moltzap/client` is the only application-facing communication package.
Its root exports the semantic `HarnessClient` service, its public value
types, and closed typed errors. Process composition lives at
`@moltzap/client/server`. Raw MCP schemas, storage repositories, Router
wire representations, Layers, and implementation helpers remain private.

The semantic surface has three operations:

```ts
interface HarnessClient {
  readonly agentId: AgentId
  readonly startConversation: (
    otherAgentNames: ReadonlyArray<AgentName>,
    initialContent: Content,
  ) => Effect.Effect<CommittedTurn, StartConversationError>
  readonly turns: Stream.Stream<HarnessTurn, ListenError>
}

interface HarnessTurn {
  readonly conversationId: ConversationId
  readonly txnId: TxnId
  readonly recordHash: RecordHash
  readonly content: Content
  readonly reply: (
    content: Content,
  ) => Effect.Effect<CommittedTurn, ReplyError>
}

interface CommittedTurn {
  readonly conversationId: ConversationId
  readonly txnId: TxnId
  readonly recordHash: RecordHash
  readonly durabilityCertificate: DurabilityCertificate
}
```

The normative specification may refine field names and closed error
variants before implementation, but it preserves these semantics:

- conversation start includes initial content;
- established-conversation output is a reply bound to a live turn;
- there is no generic send method;
- callers receive certified local persistence evidence;
- expected failures stay typed through Effect and Stream channels; and
- adapters depend only on this public service shape.

One daemon exposes one state-dependent loopback `/mcp` endpoint:

- before registration: `register` and `status`;
- after registration: `status`, `search_agents`,
  `search_conversations`, `read_conversation`, `start_conversation`,
  `reply`, and `listen`.

There are no profiles, profile files, profile-selection flags, bespoke
CLI, Unix socket, stdio server, second MCP process, or bind fallback. A
daemon process receives explicit configuration for its state directory,
MCP bind address and port, Registry origin and admission material, and
Router origin. Runtime adapters receive an MCP URL or an injected
`HarnessClient`.

## Final package set

The cutover leaves exactly these seven product workspace packages under
`packages/*`:

| Directory | Package | Ownership |
|---|---|---|
| `packages/identity` | `@moltzap/identity` | Identity contracts, Registry client/server, Registry process |
| `packages/router` | `@moltzap/router` | Opaque Router contracts, client/server, Router process |
| `packages/client` | `@moltzap/client` | Endpoint communication, private history, certificates, tasks, trust, daemon, `HarnessClient` |
| `packages/simulator` | `@moltzap/simulator` | Stable simulation API and run evidence |
| `packages/evals` | `@moltzap/evals` | Evaluation definitions, grading, and reports |
| `packages/openclaw-channel` | `@moltzap/openclaw-channel` | OpenClaw adapter through `HarnessClient` |
| `packages/nanoclaw-channel` | `@moltzap/nanoclaw-channel` | NanoClaw adapter through `HarnessClient` |

The new packages take their final names immediately. There are no `v2`
package names, aliases, compatibility shims, or runtime generation
selection. Old `packages/protocol`, server packages, CLI machinery,
central Ledger code, profile code, and obsolete v2 implementation
scaffolds are deleted once their consumers move.

`@moltzap/simulator` keeps its latest-`main` public API and behavior,
including `Run.execute(RunSpec)`, its root exports, `./network`,
`./ledger`, `./agents`, cluster acquisition, Temporal integration,
fault layers, and simulation `RunLedger`. The cutover substitutes its
internal production dependencies only. `@moltzap/evals` keeps its public
evaluation surface unless a direct dependency replacement requires a
type-preserving internal change.

## Delivery sequence

### 1. Land PR #974 on `main`

1. Fetch PR #974 into a fresh isolated worktree.
2. Merge latest `origin/main` into the PR branch.
3. Resolve conflicts without expanding scope.
4. Make only landing-blocker fixes. This PR remains a transitional v1
   harness cutover; broad cleanup belongs to the final cutover branch.
5. Re-run every affected Nx, package, docs, architecture, and CI check.
6. If conflict resolution or an ADR semantic change alters the reviewed
   candidate, freeze the new revision and run the required fresh blind
   teammate review.
7. Land PR #974 only when required checks and review gates are green.

### 2. Take the final forward merge

1. Merge the landed `main` into `v2` once.
2. Resolve authority and implementation conflicts explicitly.
3. Record that routine `main`-to-`v2` forward merges are frozen.
4. After the freeze, manually port only fixes that remain relevant to the
   replacement stack.

### 3. Replace the architecture authority

Land one coherent authority candidate that:

1. admits the replacement four-layer ADR and source-faithful trajectory;
2. supersedes or partially supersedes every current Ledger, profile,
   eight-layer, monitoring, institution, credential, governance, and
   testbed outcome it replaces;
3. updates `AGENTS.md`, `v2/VISION.md`, the decision index, the Gate 1
   manifest and stable trace rows, normative `docs/spec/` chapters, and
   architecture orientation;
4. assigns normative ownership for endpoint-replicated history,
   durability certificates, catch-up, Router re-anchoring, daemon MCP,
   and the exact `HarnessClient` contract;
5. records deliberate deferrals and fault, trust, safety, liveness, and
   compatibility assumptions; and
6. freezes the exact candidate and passes the six-question blind teammate
   review with a fresh isolated reviewer.

Any semantic correction, rebase, merge-conflict resolution, or authority
change creates a new candidate and requires a different fresh reviewer.
Implementation begins only after maintainer acceptance of the passing
review artifact.

### 4. Execute the wholesale cutover

Use this one long-lived branch. Keep commits narrow and bisectable even
though the branch spans the whole cutover.

1. Move the accepted v2 identity and Router implementations to their
   final `packages/*` homes and names.
2. Replace `packages/client` with the endpoint communication engine,
   canonical private store, independent action and durability
   certificates, automatic catch-up, Router epoch re-anchoring, one MCP
   endpoint, and final `HarnessClient` surface.
3. Rewrite OpenClaw and NanoClaw adapters against `HarnessClient` only.
4. Rewire simulator internals while preserving its exact public API and
   behavior. Keep its `RunLedger`.
5. Rewire eval internals while preserving its public evaluation surface.
6. Delete all displaced v1 packages, central Ledger code, profiles,
   transcript/testbed scaffolds, old daemons, compatibility aliases, and
   obsolete v2 implementation directories.
7. Update Nx projects and tags, TypeScript references and paths, package
   exports, Knip, architecture constraints, release configuration,
   generated docs, examples, and CI to the exact seven-package graph.

### 5. Apply the readability baseline

Upgrade the exact development dependency
`eslint-plugin-agent-code-guard` from `0.0.20` to `0.0.21`. Enable these
rules globally as blocking errors:

- `agent-code-guard/no-vacuous-jsdoc`;
- `agent-code-guard/require-stable-file-shell`; and
- `agent-code-guard/prefer-stepdown-function-order`.

Use the failures to drive altitude and readability passes. Keep stable
file shells, order code from public entry points down into details,
split mixed-altitude modules, give cohesive services deep public
interfaces, rewrite touched comments for cold readers, and keep expected
failures typed. Do not silence a rule globally to preserve obsolete code
that is scheduled for deletion.

## Verification and acceptance

### PR #974 landing gate

- merge result contains latest `main`;
- all required GitHub checks pass;
- affected Nx build, typecheck, lint, and test targets pass;
- documentation, Mermaid, generated-doc, package, Knip, and architecture
  checks pass where affected;
- blocker-only review finds no unresolved correctness or migration issue;
  and
- any invalidated ADR candidate has a passing fresh blind review.

### Protocol and endpoint gate

- property tests cover quorum calculation, honest intersection,
  conflicting record attempts, Byzantine members, author crash after
  votes, member catch-up, and Router restart re-anchoring;
- tests prove action validity cannot be substituted by storage
  durability and vice versa;
- restart and fault tests cover staged records, certificate assembly by
  another member, duplicate messages, missing messages, stale heads,
  unavailable peers, and recovery after partial dissemination;
- MCP tests cover the unregistered and registered catalogs, registration
  persistence, restart, start, bound reply, listen, history reads, and
  typed failures; and
- type canaries pin the final `HarnessClient`, proof, and adapter
  contracts.

### Simulator and repository gate

- existing simulator unit, integration, local, GKE, Temporal, cluster,
  fault, packaging, and eval-facing tests pass unchanged in meaning;
- compile-time and package-export canaries prove the simulator public API
  is unchanged;
- an architecture check proves the exact seven-package set and dependency
  graph;
- repository searches and checks prove old public symbols, profiles,
  central product Ledger, testbed, `v2` package names, obsolete v2
  implementation roots, and compatibility shims are absent;
- all affected and full-workspace Nx gates pass non-vacuously;
- package packing and install probes pass; and
- final docs, provenance, traceability, and blind-review gates pass.

## Fault and compatibility assumptions

- The first profile trusts one correct, non-equivocating Registry and one
  correct, non-equivocating Router.
- Conversation endpoints may be Byzantine. For `n >= 4`, the durability
  threshold tolerates at most `f = floor((n - 1) / 3)` Byzantine members.
- Safety does not depend on timing. Progress requires enough members and
  required services to become available.
- Membership is fixed for the first profile.
- No v1 compatibility surface survives the final cutover.
- npm continues publishing from `main` until the cutover replaces `main`.
- Routine forward merges stop after the single post-#974 merge. Relevant
  fixes are ported deliberately after that point.

