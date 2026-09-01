# Four-layer cutover implementation order

This is execution orientation. `v2/VISION.md`, current ADR outcomes, and
`docs/spec/` decide behavior.

## Constraints on every lane

- Work in final `packages/*` homes and final package names.
- A lane starts only when its behavior, representation, stable trace rows, and
  blind-review candidate are current.
- Move a deep module with its tests, configuration, migration, binary, and
  package contract. Do not leave a forwarding implementation behind.
- Delete displaced v1 or obsolete v2 machinery as soon as its final consumer
  moves. Do not build compatibility aliases or generation selectors.
- Keep expected failures typed and compose resource ownership through Effect
  services and scoped Layers.
- Keep package manifests, TypeScript references, Nx dependencies,
  architecture checks, release configuration, aliases, and CI aligned with the
  same seven-package graph.
- Treat the ACG vertical-readability rules as branch-wide errors. Fix retained
  code; delete dead code rather than constructing allowlists around it.

## Lane 0: freeze and integrate

1. Freeze the four-layer authority candidate, including ADR lineage, current
   trace rows, normative specs, and architecture orientation.
2. Pass the isolated six-question blind teammate review and record maintainer
   acceptance.
3. Integrate the accepted PR #974 head and its pinned `main` base into the
   long-lived cutover branch.
4. Record that routine forward merges are frozen. Port later v1 fixes only when
   they remain relevant to a final product.

PR #974 remains useful source material for the transitional Client and adapter
cutover. It does not make its profile, recovery, or simulator choices
authoritative for the final stack.

## Lane 1: establish the final graph

Move generic documentation tooling out of the protocol package before that
package is deleted. Add non-vacuous checks for exactly these products and
edges:

```text
identity
router       -> identity
client       -> identity + router
openclaw     -> client
nanoclaw     -> client
simulator    -> identity + router + client
evals        -> client + simulator
```

The graph check covers directory and package names, declared dependencies,
TypeScript references, Nx dependencies, export maps, binaries, forbidden
imports, deleted implementation roots, and retired public machinery. Root
artifact tooling may assemble images without creating runtime imports.

Freeze complete simulator export and behavior evidence before changing its
internals. Preserve the root, `./network`, `./ledger`, and `./agents` facade
censuses plus packed downstream compile and runtime import probes. Treat the
five accepted removals in Lane 6 as the expected breaking delta and preserve
the remaining facade contracts.

## Lane 2: move Identity

Move the complete accepted `v2/identity` implementation to
`packages/identity` and rename it `@moltzap/identity`. Move its Registry
process, migrations, configuration, tests, type canaries, representation
fixtures, and package instructions in the same lane.

Preserve the admitted immutable AgentCard, bootstrap-admission,
AuthenticatedHttp, lookup/list, exact closed representation, limits, and typed
Effect capability contracts. Replace only package/path identity and stale
Ledger/profile qualifiers. Delete the old implementation root after consumers
and checks target the final package.

Acceptance:

- all Identity Nx targets pass;
- package packing and process probes resolve the final name;
- no source import reaches the old root or v1 protocol identity; and
- Registry behavior remains independent of Router and endpoint storage.

## Lane 3: move Router

Move the complete accepted `v2/router` implementation to `packages/router`
and rename it `@moltzap/router`. Point its one production dependency to final
Identity. Move its tests, configuration, process binary, fixtures, and package
instructions together.

Preserve authenticated opaque send/poll, bounded volatile retention,
retry-scope behavior, one non-equivocating order per instance, and closed
Router representation. Replace Ledger reconciliation references with the
endpoint history/re-anchor boundary; do not add conversation state to Router.

Acceptance:

- all Router and Identity caller targets pass;
- restart tests expose a fresh RouterInstanceId without persistent
  conversation state;
- architecture checks reject Client concepts in Router; and
- old Router roots and imports are absent.

## Lane 4: build Client communication

Establish the accepted reduced `@moltzap/client` public shell, then replace the
transitional package behind that shell with cohesive endpoint modules for:

1. canonical record and certificate values;
2. local staged/certified history and atomic promotion;
3. action validation and independent durability voting;
4. mergeable certificate assembly and dissemination;
5. automatic fixed-member catch-up;
6. Router-instance head reconciliation and threshold re-anchoring;
7. GENESIS/POST tasks, first-candidate locking, and personal-trust decisions;
8. one state-directory daemon and one state-dependent `/mcp` endpoint; and
9. the final semantic `HarnessEndpoint` capability.

The public shell acquires one endpoint and exposes explicit addressed send plus
durable inbound deliveries. `HarnessEndpoint.send` accepts an `agent:` or
`group:` target and nonempty content. Every invocation creates one post with a
fresh Client-minted `PostId`; the host owns whether to invoke it again. Send
returns `void` only after local certification. The messages stream projects
certified direct and group posts with stable PostId, canonical address, sender,
group membership where applicable, and an adapter-only delivery
acknowledgment.

Keep raw Router envelopes, partial folds, repositories, storage codecs,
private RPC, Layers, and MCP representation private. `TxnId` is absent;
private conversation identity, `PostIntentHash`, `ActionHash`, `RecordHash`,
certificates, and recovery state stay behind the semantic boundary. Search,
history, status, registration, and proof inspection remain MCP management
operations. History reads and catch-up do not authorize output.

The protocol test floor includes quorum arithmetic, honest intersection,
conflicting successors, Byzantine votes, author failure, partial
dissemination, duplicates, missing history, stale heads, catch-up, Router
restart and re-anchor, local restart from staged material, and separation of
action validity from durability.

The MCP floor covers both catalogs, registration persistence, explicit
configuration, addressed send, durable message delivery and acknowledgment,
history reads, typed failures, and restart. Type canaries pin the reduced
public service, direct/group message union, void completion, and absence of
proof and management methods.

## Lane 5: rewrite runtime adapters

Retain OpenClaw and NanoClaw host integration while replacing their MoltZap
dependencies with an injected or MCP-backed `HarnessEndpoint`. Remove profile
environment, protocol/server imports, signing keys, raw Router attachment,
client internals, and cross-adapter imports.

Adapter tests use the Client public contract and real daemon boundary. A host
consumer that requires a private endpoint value reports a Client interface gap
rather than importing around it. Every DM and group enters the stock host
callback with canonical peer facts, every stock output callback becomes one
addressed send, and acknowledgment follows successful callback completion.
Adapters do not select host sessions or rebuild host persistence, retries, or
checkpoints.

## Lane 6: rewire simulator and evals

### Simulator provenance

The immutable porting baseline is
`102f110436bedbba828591c1b97fd4e322abcf76`, the merge of production
Simulator PR #974 into `main`. It is fully tracked and its CI, test, and
conformance checks passed. The later `main` commit `78e376341eb4b37aafbc5a3c446bb10826564085`
changes release numbers only and is not the behavioral Simulator baseline.

At the baseline SHA, the four facade barrels contain 196 unique named
declarations counting intentional cross-facade duplication: 70 at `.`, 41 at
`./network`, 40 at `./ledger`, and 45 at `./agents`. The five admitted removal
families delete exactly these 15 facade names:

- root: `ConversationOpened`, `EndpointMessageReceived`,
  `EndpointMessageSent`, `LinkMessageDelayed`, `LinkMessageDropped`,
  `LinkMessageHeld`, `MessageParts`, `ReceivedMessage`, and
  `RouterMessageCommitted`;
- `./network`: `CommittedRouterMessage`, `MessageParts`,
  `OpenedConversation`, `ReceivedMessage`, `RouterSequence`, and
  `routerSequence`; and
- `./ledger` and `./agents`: none.

The resulting checked-in census is 181 declarations: 61, 35, 40, and 45.
`packages/simulator/api-census.json` records the exact deletion set and final
type/value spaces. The baseline remains provenance for the admitted port.
`scripts/test/simulator-packages.mjs` checks the current packed facades against
that census and runs isolated type and runtime consumer probes.

#### Simulator provenance gate

No different source SHA, additional deletion, replacement alias, or public
namespace drift is a compatible port. A new baseline requires a current
decision and replacement evidence rather than editing the expected census.

Preserve every non-conflicting latest-`main` simulator facade and meaning,
including `Run.execute(RunSpec)`, clusters, Temporal integration, fault layers,
and simulation `RunLedger`. Replace production-stack acquisition with final
Identity, Router, and Client capabilities.

Apply the five admitted removals directly, without compatibility shims:

1. replace content-free `open` with `HarnessEndpoint.send` carrying an explicit
   address and nonempty content, with one new post per invocation;
2. route visible output only through stock host callbacks bound to the current
   inbound address or an explicit `agent:` or `group:` proactive target;
3. replace message-only receive and proof-shaped operation results with public
   semantic `InboundDelivery` input and resultless completion facts;
4. remove runtime keys, Router attachment, Registry/Router origins, and store
   handles; and
5. delete persisted Router-commit/order events. `RunLedger` records only
   simulation lifecycle and public semantic effects.

One run provisions one Registry and one Router. Each agent Sandbox Pod owns a
restartable `moltzapd` sidecar, private key/admission mounts, and a per-agent
persistent volume. Registration completes before application startup. The
application receives only
`MOLTZAP_MCP_URL=http://127.0.0.1:<port>/mcp`; it never receives the daemon's
network origins, signing material, or state path.

Place retained directed link faults at a private recipient-delivery
interposition after Router polling and before Client consumption. With no
active fault, pass the exact messages through in Router order. An explicit
fault scope may drop, delay, hold, or reorder one sender-to-recipient
delivery. The controller evaluates policy; application containers receive no
control endpoint or credential, and production Router and Client expose no
fault hook. Classify those observations as endpoint fault-tolerance evidence,
not Router conformance.

Rewire evals through Client and simulator while preserving grading, reports,
CLI modes, and deployment artifacts. Move image assembly that would otherwise
create hidden simulator-to-adapter or simulator-to-evals runtime edges into
root tooling. Execute all sixteen case definitions through the daemon-backed
Client. Do not inject automatic cross-conversation context; the six cases that
require it may fail until their host provides native memory.

Acceptance includes all four packed simulator facades, unit/integration/local
and cluster suites, Temporal and fault tests, GKE packaging where available,
and eval-facing behavior. Facade checks preserve every compatible declaration
and encode the five removals above as the only accepted breaking delta. Fault
checks separately prove inactive byte/order transparency, every activated
post-Router perturbation, and runtime isolation from fault controls.

## Lane 7: remove the retired stack

Delete:

- `packages/protocol` and `packages/server`;
- profile, bespoke CLI, Unix-socket, local-RPC, and generation-selection code;
- central product Ledger, Transcript, and `LedgerOffset` machinery;
- obsolete `v2/identity`, `v2/router`, `v2/transcript`, `v2/harness`,
  `v2/simulator`, and `v2/testbed` implementation roots; and
- aliases, fixtures, generated docs, examples, CI jobs, and release entries
  whose only purpose was a retired surface.

Preserve historical ADRs and source-faithful evidence. Absence checks target
executable code, current specs and orientation, configuration, package
metadata, generated documentation, and user guidance rather than rewriting
history.

## Final gate

Before release cutover:

- build before typed lint, then run the full workspace Nx test floor;
- run protocol property, recovery, fault, MCP, adapter, simulator, eval, and
  process integration suites;
- regenerate documentation and pass drift, Mermaid, link, ADR-shape, and
  architecture checks;
- pack and install every publishable product in isolated consumers;
- prove the exact seven-package graph and absence of every retired public
  surface;
- resolve publication/version policy and update release automation; and
- freeze and accept any final semantic authority candidate through a fresh
  blind review.
