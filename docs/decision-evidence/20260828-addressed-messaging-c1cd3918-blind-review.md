# Blind decision review record — addressed messaging

## Review identity

| Field | Value |
|---|---|
| Review run ID | `addressed-messaging-c1cd3918-codex-v5` |
| Candidate commit | `c1cd391856afa6794c55afa1786fadf5ad1d2d10` |
| Candidate tree | `523fe59215651fbc738ca8dad96a7bbde11625d8` |
| Candidate content digest | SHA-256 `34b5c8e5f2ea9f5a6d805b3aceb26ffcb5e19b09a16d738d8d38e40f99c24e2a` |
| Digest scope and command | Complete recursive Git tree manifest: `git ls-tree -r --full-tree c1cd391856afa6794c55afa1786fadf5ad1d2d10 \| sha256sum` |
| Reviewer | Codex fresh blind teammate agent `/root/blind_authority_review_v5` |
| Reviewer session | One isolated fresh-agent context; no author session or prior-review output inherited |
| Review started | `2026-08-28T01:22:12Z` |
| Review finished | `2026-08-28T01:35:15Z` |
| Review duration | 13 minutes 3 seconds |
| Review budget | One uninterrupted fresh-agent context; no token cap was supplied |
| Rerun of | Not supplied. A quarantined prior-review artifact path was visible in candidate history and was not opened. |
| Rerun reason | Not supplied in the review prompt. The current ADR changelog records earlier trace and authority corrections. |

## Exact review prompt

```text
You are a fresh blind teammate reviewer. Review exact candidate `c1cd391856afa6794c55afa1786fadf5ad1d2d10` in repository `/home/tapanc/moltzap-v2-cutover`. Use only that candidate repository and normal repository navigation/history/search. Do not open, read, or search the contents of any earlier `*-cold-review.md`, `*-blind-review.md`, or invalid-review record; seeing an artifact path in a listing is allowed. If any command returns an answer or verdict from one, invalidate the run immediately. You have no author conversation, summary, diff tour, expected outcome, or private state. Do not ask the author questions and accept no hints. Record candidate identity, this exact prompt, reviewer identity/isolation attestation, duration, unedited answers, independently discovered paths/headings, discovery trail, author interventions, per-question verdicts, blockers, and overall PASS/FAIL under `docs/decision-evidence/` in a newly named artifact containing the short candidate SHA. Answer exactly these six questions:

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

PASS only if all six answers are accurate and discoverable with consistent status, lineage, authority, assumptions, normative ownership, and source-event attribution. Any wrong or unfindable answer, broken locator, unresolved contradiction, invented binding choice, or need for an author hint is FAIL.
```

## Fresh-context attestation

The reviewer attests:

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited conversation, summary, memory, private state,
      or earlier blind-review output about the candidate.
- [x] I received only the clean candidate checkout and the fixed questions in
      the exact prompt above.
- [x] I received no out-of-band tour, decision or file pointer, search term,
      expected answer, or answer key.
- [x] I navigated the repository independently. I used checked-in entry
      points, repository-native indexes, ordinary search, and repository
      history only after discovering them myself.
- [x] I did not open, read, or search the contents of an earlier cold-review,
      blind-review, or invalid-review record. A quarantined artifact path
      appeared in a file listing and candidate history; no answer or verdict
      from it was returned.
- [x] I did not ask the author for help or modify the candidate revision before
      submitting these answers. This review artifact is outside the frozen
      candidate tree identified above.
- [x] The author interventions recorded below are complete.

## Fixed questions and verbatim answers

The numbered questions are reproduced only inside the exact prompt above.
Their normative owner remains
`.claude/skills/cold-read/references/questions.md`.

### 1

Verdict: **PASS**

Candidate `c1cd3918` makes the accepted addressed-messaging replacement
current. Applications send explicit addressed posts to exactly
`agent:<AgentName>` or `group:<AgentName>,...`; each local runtime uses one
host-native session; and unanimous fixed-member GENESIS plus author-inclusive
threshold POST certification replaces OpenFloorV1, START/current-turn/bound
reply, and grant-derived output authority.

The problem is the duplicate conversation and turn system in Client. The
retired contract required caller-minted conversation IDs, OpenFloor
contention, one current-conversation presentation, and acknowledgments used to
manufacture reply authority even though OpenClaw and NanoClaw already own
durable session, inbox, outbox, retry, and native messaging behavior. It also
could not represent fixed groups as first-class runtime addresses. The current
decision keeps correct Registry identity, opaque Router transport,
endpoint-replicated certified history, durability, catch-up, and re-anchor,
while avoiding a central product Ledger, peer directory, compatibility stack,
or second host-messaging implementation.

The binding outcome is the accepted ADR's `Decision Outcome`, read with the
current portions of partially superseded ADRs, the stable trace manifest, and
the exact normative `docs/spec/` owners under the authority order in
`AGENTS.md` and `v2/VISION.md`. In particular, the address grammar and
membership rules, structural `HarnessEndpoint`, one-native-session rule,
GENESIS/POST thresholds and first-candidate lock, evidence-independent hashes,
durable host delivery, and hard format cut are binding. The ADR's `Context and
Problem Statement` and `Consequences` explain history and effects; the
decision index expressly classifies context, considered options,
consequences, and examples as historical explanation rather than an
independent outcome. The record changelog is a change receipt. The trajectory
declares itself non-normative, and architecture pages are orientation below
the specifications.

Independently discovered paths and headings:

- `docs/decisions/README.md` — `Canonical reading guidance`, `Records`
- `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` —
  `Context and Problem Statement`, `Decision Outcome`, `Consequences`
- `v2/VISION.md` — `Authority`, `The constitution`, `First executable profile`
- `docs/spec/README.md` — `Authority and reading order`, `Addressed Client boundary`

### 2

Verdict: **PASS**

The explicit lineage has two classes.

Fully superseded records, with none of their old surface current, are:

- `20260726-the-engine-dispatches.md` — grant-before-generation dispatch;
- `20260728-model-surface-is-start-reply-listen.md` — start/reply/listen;
- `20260728-open-floor-v1.md` — OpenFloorV1, START/MULTICAST,
  BEGIN/ACK contention, grants, and unanimous ordinary actions;
- `20260801-harness-client-owns-runtime-context.md` — Client-built runtime
  context;
- `20260801-inbound-notifications-separate-content-from-grants.md` —
  grant-bearing notification;
- `20260801-model-output-is-start-or-bound-reply.md` — start or bound-reply
  output;
- `20260805-harness-client-is-the-production-adapter-contract.md` — the old
  `HarnessClient` capability; and
- `20260812-harness-client-uses-conversation-id.md` — public
  `ConversationId`, START, current-conversation turn, and bound reply.

Partially superseded records retain only their visible `Supersession` scope:

- `20260723-lifecycle-rides-l3.md` retains in-band fixed-membership genesis
  with initial content and no separate create operation, plus the absence of
  dynamic membership and empty/mutable groups.
- `20260724-firewall-two-directions.md` retains one inbound/outbound endpoint
  boundary and local signing, attention, disclosure, and reliance decisions.
- `20260728-endpoint-daemon-speaks-modern-mcp.md` retains the pinned MCP core
  and SDK boundary, Streamable HTTP framing, one loopback listener, discovery,
  local subscription ownership/trust, acknowledgment ordering, and
  host-specific supervision where independent of profiles and Ledger.
- `20260728-gate-1-architecture-freeze.md` retains repository-native
  authority, stable trace IDs, explicit lineage, contradiction-free gating,
  and blind review; its historical inventory is not current.
- `20260728-simulator-is-the-system-driver.md` and
  `20260801-main-simulator-runs-container-societies-on-kubernetes.md` retain one
  simulator, its execution/runtime-gateway baseline, closed catalog,
  Kubernetes path, compatible facades, and simulation `RunLedger`, but not
  old social-traffic or Router-authority contracts.
- `20260811-four-layer-endpoint-replicated-harness.md` retains the four-layer
  model, endpoint-replicated certified history, stage-before-vote durability,
  catch-up, Router re-anchor, recursive social features, daemon topology,
  seven-package graph, cutover outcome, and the now-updated stable manifest.
- `20260813-client-protocol-and-attention.md` retains Client ownership of
  closed representation, endpoint SQLite persistence, registration recovery,
  management isolation, verified catch-up, Router re-anchor, and daemon
  configuration; v1 hashes/actions, consumed turns, events-v1, grants,
  `HarnessClient`, and start/bound-reply Simulator cuts are replaced.

Unlisted stable-manifest rows retain their current dispositions. Identity's
immutable AgentCards and authentication, Router's authenticated opaque order,
the no-product-Ledger endpoint-history model, the four-layer package graph,
and the separately accepted post-Router Simulator link-fault decision remain
untouched except for the shared hard-cut protocol version where expressly
advanced.

The current contract lives in `AGENTS.md` and `v2/VISION.md`, then the accepted
addressed-messaging ADR and explicitly retained portions of partially
superseded ADRs. The single current manifest is
`20260811-four-layer-endpoint-replicated-harness.md` — `Gate 1 traceability
disposition`. Exact interfaces live in `docs/spec/conversation-history.md`,
`docs/spec/layer-interfaces.md`, `docs/spec/harness/{client,tasks,ingress,output,channels,daemon}.md`,
and `docs/spec/management.md`, with Identity and Router representations owned
by their layer specifications.

Independently discovered paths and headings:

- `docs/decisions/README.md` — `Canonical reading guidance`, `Records`
- every ADR whose frontmatter names
  `superseded-by: 20260827-addressed-messaging-replaces-openfloor.md` —
  `Supersession`
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` —
  `Supersession`, `Gate 1 traceability disposition`
- `docs/decisions/20260813-client-protocol-and-attention.md` — `Supersession`
- `v2/VISION.md` — `Current cutover decisions`, `Authority`

### 3

Verdict: **PASS**

An implementer must:

- Resolve direct and fixed-group addresses through Registry. Direct membership
  is exactly two and rejects self. Group input may omit self, rejects repeated
  explicit or unknown names, inserts self, permits 3 through 32 total members,
  and renders complete canonical AgentNames in ASCII byte order. One exact
  AgentId set has one private deterministic conversation; there is no separate
  create, invitation, rename, add, remove, leave, directory, or duplicate
  same-member group.
- Expose the structural scoped `HarnessEndpoint` with
  `send({idempotencyKey,to,content}) -> Effect<void, SendError>` and a stream of
  direct/group `InboundDelivery` values. Direct and group messages carry
  PostId, canonical address, sender, content, and, for groups, exact complete
  membership. Acknowledgment is transport-only and follows durable host inbox
  acceptance.
- Persist the host's durable outbox intent before traffic. Derive an
  author-scoped PostId from the idempotency key. Identical target/content retry
  resumes or returns the same post; changed intent conflicts. Return `void`
  only after the local endpoint durably holds the complete action- and
  durability-certified record.
- Implement unanimous fixed-member GENESIS for the first nonempty post and
  author-inclusive POST threshold
  `q(n)=n` for `n<4`, otherwise `n-floor((n-1)/3)`. Keep action signatures and
  `q(n)` durability votes separate. Durably lock and sign only the first valid
  gap-free Router-ordered candidate for one predecessor; unchanged losing
  intent rebases only after a competing commit. Preserve signer AgentIds and
  exact signatures while excluding signer evidence from PostIntentHash,
  ActionHash, and the specified RecordCore hash.
- Keep endpoint-local staged/certified history, mergeable evidence, automatic
  fixed-member catch-up, quorum Router re-anchor, and durable pending inbound
  delivery. Any member may assemble and disseminate sufficient evidence.
  Remote committed posts create one pending delivery per recipient; the author
  receives no self-notification. Replay after ambiguous host acceptance is
  idempotent and changed payload under one inbound identity fails closed.
- Route all direct and group input for one local agent through OpenClaw's
  resolved native main session or NanoClaw's `agent-shared`. Use only native
  durable host messaging for visible output, with an explicit address on every
  send. Plain final model text is private. Do not synthesize a notification,
  automatic semantic acknowledgment, reply, or invitation response.
- Serve one explicitly configured state-directory daemon on
  `127.0.0.1:<port>/mcp`, with pre-registration `register`/`status`, the exact
  registered management and adapter catalog, and the events-v2 subscription.
  Owner-authorized history/proof reads stay MCP-only and expose verified signer
  evidence without creating output authority.
- Rewire OpenClaw, NanoClaw, Simulator, and evals through public Client/MCP.
  Simulator retains its compatible facades and simulation RunLedger but
  removes content-free open, unaddressed send, message-only receive/proof
  results, runtime keys/Router authority/store access, and persistent Router
  commit/order events. Its explicit directed link faults remain private and
  post-Router.
- Make the incompatible cut exact: shared source protocol `2026.827.1`, Client
  hash domains `moltzap/client/v2/*`, events-v2, SQLite schema 2, and fresh
  endpoint/host state. Initialize version 0 only when no user-created SQLite
  table/index/view/trigger exists, before WAL/schema/permission mutation.
  Reopen only version 2; reject nonempty version 0, version 1, every other
  version, mixed peers, and prior extensions without migration, decoding,
  erasure, aliases, dual stack, flags, or rollback automation.

The affected ownership spans Identity name/card resolution and the shared
version, opaque Router transport, Client communication/history/tasks/trust and
daemon/MCP, both host adapters, Simulator, and evals. Registry and Router must
not acquire conversation, group, action, history, durability, task, norm,
trust, or policy semantics. Runtime consumers must not receive credentials,
signing authority, raw network clients, Router attachment, endpoint storage,
private conversation IDs, hashes, certificates, receipts, or proofs.

The trust profile assumes one correct non-equivocating Registry and one
correct non-equivocating Router; either may be unavailable and Router may
restart. Endpoints may be Byzantine. For `n>=4`, at most
`f=floor((n-1)/3)` Byzantine members plus honest stage-before-sign gives at
least `n-2f` honest staged replicas after durability completion. For `n<4`,
the replicated-storage guarantee assumes zero Byzantine members. GENESIS is
unanimous; POST safety additionally relies on quorum intersection, correct
Router order, and the honest first-candidate lock. Safety is timing-independent.
Progress requires available/cached identity material, Router availability,
responsive action and durability quorums, and an honest reachable source for
missing ancestry. Refusal, withholding, an unavailable selected quorum,
missing/incomparable ancestry, or unavailable services may stall one
conversation; no timeout replacement, view change, fairness, or threshold
reduction is claimed. Certified local history remains readable and verifiable
during service outage.

Independently discovered paths and headings:

- `docs/spec/conversation-history.md` — `Addresses and membership`, `Closed
  schema vocabulary`, `Certificates and certified records`, `Proposal ordering
  and idempotency`, `Action validity and storage durability`, `Catch-up and
  Router restart`, `Durable host delivery`, `Persistence and compatibility`
- `docs/spec/harness/client.md` — `Service shape`, `Addressed send`, `Addressed
  inbound delivery`, `Closed failures`, `Host ownership`
- `docs/spec/harness/tasks.md` — `GENESIS`, `POST`, `Candidate selection`,
  `Screening and signing`, `Durability`
- `docs/spec/harness/ingress.md`, `output.md`, `channels.md`, `daemon.md`
- `docs/spec/layer-interfaces.md` — `Exact package graph`, `Trust, safety, and
  progress`, `Simulator cutover`
- `v2/VISION.md` — `First executable profile`

### 4

Verdict: **PASS**

The ADR names one human decision-maker: **Tapan Chugh**. The trajectory does
not identify the user account as that human. It records each retained source
entry only as `user input`, because the source has no separate stored actor
field; repository provenance law says the `decision-makers` field names the
accountable human and does not itself prove authorship of every session
rationale.

The compacted ledger cites these source events from Codex local-history session
`019fd899-779c-7e70-a8e4-338727b13e6c`:

| Event | Native locator and UTC time | What the literal event states |
|---:|---|---|
| 1 | line 2920, `2026-08-27T18:57:37Z` | Add back cross-conversation context, add agent-created group chat, and use “Individual private cal but shared meetings.” |
| 2 | line 2922, `2026-08-27T19:27:10Z` | Remove OpenFloorV1 now because it is not actually used and can be added later as a projection. |
| 3 | line 2924, `2026-08-27T19:55:09Z` | Reduce debt by falling back to existing OpenClaw and NanoClaw code where possible. |
| 4 | line 2925, `2026-08-27T20:41:17Z` | Ask for both hosts to route through one main session and use only `agent:` and `group:`. |
| 5 | line 2927, `2026-08-27T20:52:54Z` | Use agent addresses rather than attendee email-like values, send no automatic notification, and permit agents to message that they sent an invite. |
| 6 | line 2930, `2026-08-27T21:29:13Z` | Ask whether OpenClaw's message tool makes more sense now that sessions are shared and say direct reply feels weird. The ledger says this question does not establish the answer. |
| 7 | line 2932, `2026-08-27T21:52:53Z` | Ask about the native-messaging requirement and require a group recipient to know that it is a group conversation. |
| 8 | line 2929, `2026-08-27T21:17:54Z` | Defer CoordBench migration to a later handoff, make backward compatibility a non-goal, avoid rollback complexity, and follow the named style/testing/review/documentation guides. |
| 9 | line 2936, `2026-08-27T22:21:49Z` | Ask whether work is on the new four-layer cutover branch. The missing agent answer is not reconstructed. |
| 10 | line 2940, `2026-08-27T22:52:08Z` | “Implement the plan.” The plan is absent from this source, so this proves an implementation instruction but not its contents. |
| 11 | line 2943, `2026-08-27T23:54:53Z` | “ookay, that sounds good. proceed”. The preceding prompt is absent; the ledger records only that it followed discussion of retaining signature evidence while excluding evidence from logical hashes, and does not treat it as independent proof of an exact selection. |

The only source-stated later/revisit treatment is Event 2's statement that
OpenFloor can be added later as a projection. The source-stated deferrals and
non-goals are Event 8's CoordBench handoff, backward-compatibility non-goal,
and no rollback overcomplication. Events 6 and 7 preserve questions or
requirements; they are not silently converted into source-proven answers. The
ledger records no other alternative, reversal, motive, confidence, urgency,
or rationale, so none is inferred here.

The trajectory explicitly records these source gaps:

- no native message IDs, turn IDs, parent locators, or separate actor-role
  field are stored; it uses session, local line, event kind, and exact UTC time
  instead;
- intervening public agent explanations, structured-choice prompts and
  selections, and the final plan are absent;
- the source therefore cannot reconstruct the rationale or human selection for
  canonical sorting, the ordinary-post threshold, or detailed interface and
  wire shapes from terse replies;
- the prompt preceding Event 11 and the answer following Event 9 are absent;
- the plan referenced by Event 10 is absent; and
- the duplicate line 2921 copy of Event 1 was omitted and marked rather than
  presented as an independent decision.

Independently discovered paths and headings:

- `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` —
  frontmatter and `Decision provenance`
- `docs/decision-evidence/20260827-addressed-messaging-trajectory.md` —
  `Source scope and gaps`, `Addressed messaging, groups, and shared meetings`,
  `Native messaging and group visibility`, `Compatibility, process, and
  downstream deferral`
- `.claude/skills/decisions/references/provenance.md` — provenance rules

### 5

Verdict: **FAIL**

The strongest broken lineage is in the single current stable manifest,
`docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` — `Gate 1
traceability disposition`. The addressed ADR says the manifest links every
changed row to an exact current specification heading. It does not:

- G1-DEC-221, G1-DEC-223, G1-DEC-403, and G1-DEC-610 name
  `docs/spec/conversation-history.md` — `Closed values and hashes`, but that
  heading does not exist. The file has `Closed schema vocabulary` and
  `Canonical encoding and preimages`.
- G1-DEC-404 and G1-DEC-516 name `GENESIS and POST` under
  `docs/spec/conversation-history.md`, but that file has no `GENESIS` or `POST`
  heading; those headings live in `docs/spec/harness/tasks.md`.

This cannot be resolved by the authority order: the manifest is itself the
current repository-native decision manifest, and selecting replacement
headings would repair author intent rather than follow a checked-in locator.
It is a blocker under the gate's broken-locator rule.

There is also an unresolved same-authority semantic contradiction.
`v2/VISION.md` — `The constitution` says the action-certified record carries
the complete action-validity certificate and that `RecordHash` commits to
“that canonical value.” `v2/VISION.md` — `Conversations and records`, the
current addressed ADR, and `docs/spec/conversation-history.md` — `Canonical
encoding and preimages` instead say `RecordHash` binds `RecordCore` and excludes
all signer evidence. `docs/architecture/layers.md` — `Communication` repeats
the older include-the-action-certificate wording. The architecture page is
lower and could be overridden, but the two incompatible readings inside
`v2/VISION.md` are at the same highest authority level. There is no declared
intra-document precedence, so the repository does not unambiguously select the
hash preimage.

The still-executable START/OpenFloor/events-v1/`HarnessClient` code is another
apparent contradiction, but it is resolvable: `v2/VISION.md` — `Evidence and
path` and `docs/architecture/first-implementation.md` explicitly put the
authority freeze before Client/adapters/Simulator implementation and deletion
lanes. Historical architecture slates carry visible superseded/non-normative
banners. I therefore classify current old code as pending implementation, not
the blocker.

Independently discovered paths and headings:

- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` — `Gate
  1 traceability disposition`
- `docs/spec/conversation-history.md` — complete heading inventory,
  `Canonical encoding and preimages`
- `v2/VISION.md` — `The constitution`, `Conversations and records`, `Authority`
- `docs/architecture/layers.md` — `Communication`
- `docs/architecture/first-implementation.md` — lanes 0, 4, 5, 6, and 7

### 6

Verdict: **FAIL**

No. A teammate can discover most of the target behavior, but cannot implement
the exact candidate without choosing among contradictory or absent binding
details.

Accidental gaps:

1. **Broken manifest ownership links.** The six trace-row heading errors listed
   in answer 5 prevent exact row-to-owner traversal. These are accidental
   lineage gaps, not deliberate deferrals.
2. **RecordHash evidence ambiguity.** The highest-authority Vision has the
   incompatible include/exclude readings described in answer 5. This is an
   accidental authority gap and affects persistent/wire hash identity.
3. **Incomplete events-v2 wire closure.** `DeliveryToken` appears only in
   `docs/spec/harness/ingress.md` — `MessageReadyEvent` and
   `docs/spec/conversation-history.md` — `Durable host delivery`; no current
   normative chapter defines its JSON type, exact canonical representation,
   bounds, or generation/collision contract. The daemon is also said to
   advertise `xyz.moltzap/events-v2`, while no exact discovery-extension value
   is specified even though `ConnectError("incompatible-daemon")` depends on
   absence or mismatch and the trace classifies this as WIRE. Choosing those
   values would be an implementation guess. The lower OpenClaw guide does make
   PostId the stable native-inbox identity, but it does not close the MCP token
   or discovery representation.
4. **Explicitly recorded provenance loss.** The source system did not retain
   the agent prompts/options, selections, final plan, native message/turn/parent
   locators, or a separate actor field. The trajectory therefore cannot prove
   canonical sorting, q(n), or the detailed interface/wire choices from the
   terse replies. This is an accidental source-provenance gap, explicitly
   disclosed rather than an undisclosed implementation choice. The current ADR
   and specs do state those choices, so this gap does not by itself force an
   implementer to invent them.

Deliberate deferrals and negative boundaries:

- publication membership, coordinated versus independent package versions,
  external-consumer/release/deployment cutover, and the addressed ADR's scoped
  exclusions for npm/image publication, a self-contained Simulator artifact,
  calendar implementation, and CoordBench migration;
- dynamic membership, add/remove/leave, mutable or named groups, multiple
  groups with identical membership, group directories, and invitations as a
  separate protocol operation;
- pruning, garbage collection, post-certification retention policy, local
  disk-loss recovery, and non-member disclosure/cross-history audit
  conventions;
- fragmentation or larger resource profiles, binary/media action content,
  encrypted history, and key distribution;
- Router replication, Byzantine sequencing, failover/fork recovery, malicious
  or replicated Registry profiles, identity rotation/recovery, and public or
  privileged observers;
- richer task/norm vocabularies, executable user-provided norms, configurable
  quorums, timeout replacement, view change, pass/takeover/disputes, fairness
  and starvation freedom, automatic semantic acknowledgments, signature
  aggregation/FROST, and a separate transactional evidence outbox;
- portable personal-trust conformance, delegation evidence, and peer-card
  custody; and
- local hostile-host authentication, dynamic ports, attachment transport,
  universal supervision, remote daemon administration, MCP cursors, alternate
  push, asynchronous task handles, and dynamic action tools.

Those deliberate items must remain unanswered by this implementation. They do
not authorize compatibility shims or restoration of a retired surface. The
three accidental implementation/lineage gaps above must be reconciled in a new
candidate before a teammate can implement without guessing.

Independently discovered paths and headings:

- `v2/VISION.md` — `Deliberate deferrals`
- `docs/spec/conversation-history.md` — `Explicitly deferred`, `Durable host
  delivery`
- `docs/spec/layer-interfaces.md` — `Deliberate deferrals`
- `docs/spec/harness/tasks.md` — `Explicitly deferred`
- `docs/spec/harness/ingress.md` — `MCP extension`, `Durable acceptance`
- `docs/spec/harness/client.md` — `Service shape`, `Closed failures`
- `docs/decision-evidence/20260827-addressed-messaging-trajectory.md` — `Source
  scope and gaps`

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Verified UTC start, HEAD, branch, and worktree state | Candidate `c1cd3918`; clean worktree | Candidate identity matched the prompt. |
| 2 | Read repository instructions, then the repository-local procedures they require | `AGENTS.md` — `Decisions`, `Docs`; `.claude/skills/decisions/SKILL.md`; `.claude/skills/docs/SKILL.md`; cold-read questions and template | Established authority order, quarantine, evidence shape, and blind-gate standard without external material. |
| 3 | Listed candidate files with quarantined review globs excluded | Repository tree; one quarantined prior-review path was visible | No quarantined content was opened or returned. |
| 4 | Read repository README and decision index | `README.md`; `docs/decisions/README.md` — `Canonical reading guidance`, `Records` | Found the current addressed-messaging ADR and stable manifest entry point. |
| 5 | Followed the current ADR's checked-in provenance links | Addressed ADR and `20260827-addressed-messaging-trajectory.md` | Recovered the current outcome, event ledger, and explicit source gaps. |
| 6 | Followed the highest-authority current-decision list | `v2/VISION.md` — `Authority`, `The constitution`, `First executable profile`, `Deliberate deferrals` | Recovered process model, exact profile, assumptions, and deferrals; later exposed the RecordHash conflict. |
| 7 | Followed the ADR's single-manifest pointer | Four-layer ADR — `Supersession`, `Gate 1 traceability disposition` | Recovered stable row dispositions and normative owners. |
| 8 | Enumerated ADRs whose frontmatter names the replacement, then read only their visible supersession sections | Sixteen addressed-messaging lineage records — `Supersession` | Distinguished eight fully superseded records and eight retained partial scopes. |
| 9 | Inventoried headings and read the normative Client/history/daemon/management/package chapters | `docs/spec/*` and `docs/spec/harness/*` | Reconstructed exact intended implementation, faults, failures, and compatibility cut. |
| 10 | Read current implementation orientation and historical-slate banners | `docs/architecture/first-implementation.md`, `components.md`, `layers.md`, superseded slates | Resolved old executable code as pending lanes; found stale action-certificate hashing prose. |
| 11 | Searched current authority and code for retired terms and version literals | Specs, architecture, packages, scripts | Confirmed old code is not yet migrated and the shared source version is `2026.827.1`. |
| 12 | Searched current authority for `DeliveryToken` and events-v2 discovery representation | `harness/ingress.md`, `conversation-history.md`, Client failure contract | Found no exact token schema or extension-advertisement value. |
| 13 | Compared every relevant manifest owner phrase to the target file's heading inventory | Stable manifest versus `conversation-history.md` | Found six nonexistent heading locators. |
| 14 | Ran the repository's mechanical ADR shape gate | `scripts/docs/adr/check-shape.ts` | PASS for 62 records; the script expressly does not validate manifest semantics or every owner heading. |
| 15 | Computed frozen tree identity and a reproducible recursive-tree digest | Candidate Git tree and `git ls-tree` manifest | Recorded exact candidate identity above. |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| none | none | none |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| B1 | The current stable manifest has six nonexistent normative-owner headings. | Four-layer ADR — G1-DEC-221, 223, 403, 404, 516, and 610; `conversation-history.md` heading inventory | Point every affected stable row to actual exact current heading(s), preserve row meaning, freeze a new semantic candidate, and use a different fresh reviewer. |
| B2 | Highest-authority RecordHash ownership is internally inconsistent about action-signature evidence. | `v2/VISION.md` — `The constitution` versus `Conversations and records`; addressed ADR and conversation-history spec; stale `architecture/layers.md` prose | Make the Vision constitution and orientation unambiguously match the selected exact RecordCore preimage, then freeze and re-review. |
| B3 | The events-v2 token and discovery advertisement are not an exact closed wire contract. | `harness/ingress.md` — `MCP extension`; `conversation-history.md` — `Durable host delivery`; `harness/client.md` — `Closed failures` | Define the exact DeliveryToken schema/bounds and exact events-v2 discovery value, including the mismatch check, without inventing them in code; update trace/spec/acceptance and re-review. |

## Overall result

Result: **FAIL**

Rationale:

Questions 1 through 4 are substantially accurate and independently
discoverable, including the explicit source gaps. Questions 5 and 6 fail. The
candidate's current manifest contains broken normative-owner locators, the
highest-authority Vision does not unambiguously select whether RecordHash
includes action-signature evidence, and the supposedly exact events-v2 wire
leaves its token and discovery value undefined. These require author
reconciliation rather than reviewer inference, so the candidate does not meet
the gate's consistent-authority, exact-lineage, no-guessing standard.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity above and
records the gate decision.

| Field | Value |
|---|---|
| Maintainer | `_fill_` |
| Reviewed result | `addressed-messaging-c1cd3918-codex-v5` |
| Candidate identity matches | `_fill yes or no_` |
| Gate decision | `_fill ACCEPTED or REJECTED_` |
| Decision time | `_fill ISO 8601 timestamp_` |
| Rationale | `_fill_` |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `_none_` |
| Superseded candidate commit | `_none_` |
| Superseded candidate content digest | `_none_` |
| Reason a rerun was required | `_none_` |
