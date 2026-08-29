# Blind teammate review

Overall result: **PASS**  
Maintainer acceptance: **pending; reviewer prose is not self-certifying**

## Review identity

| Field | Value |
|---|---|
| Review run ID | `adr_blind_review_3-20260829T023446Z` |
| Candidate root | `/home/tapanc/moltzap-v2-cutover` |
| Candidate branch | `impl/addressed-messaging-native-sessions` |
| Candidate commit | `89e9609e9e33b8e229710d279d0978760d6225e4` |
| Candidate parent | `1538fc2a4d1b07fba3f88eaa6ba5a44b77f0d4d7` |
| Candidate tree | `604f15ba35048d73de06374a14ca0855b543f9d5` |
| Candidate content digest | SHA-256 `1e476ef4c427d52af9c290f67f550919e734fe61422b467fe7f91e8d096d4002` |
| Digest scope | Complete Git tree manifest at `HEAD`; command emitted only the digest |
| Digest command | `git ls-tree -r --full-tree HEAD \| sha256sum` |
| Reviewer | Codex fresh teammate agent `/root/adr_blind_review_3` |
| Reviewer session | `/root/adr_blind_review_3` |
| Review started | `2026-08-29T02:34:46Z` |
| Review finished | `2026-08-29T02:46:10Z` |
| Duration | `00:11:24` |
| Review budget | One uninterrupted fresh-agent context, with a 45-minute ceiling |
| Rerun of | Not determined: a prior-review path was visible but quarantined |
| Rerun reason | Not determined without opening quarantined material |
| Candidate state | Clean at start and finish |

## Exact prompt

```text
Conduct the repository's fresh blind teammate review in candidate root /home/tapanc/moltzap-v2-cutover. This review is confined to the changed ADRs and their governing normative specifications, decision manifest, provenance, authority, supersession, and lineage; do not evaluate implementation code. You have no inherited author conversation, compaction, memory, private state, or prior review output. Follow the repository's AGENTS.md blind-review gate exactly. Do not open, read, or search the contents of any earlier *-cold-review.md, *-blind-review.md, or invalid-review artifact; merely seeing such paths is allowed. If a command returns content, an answer, or a verdict from one, invalidate the run immediately. Do not ask the author for help. Discover everything from the candidate repository. Record the candidate identity, exact prompt, reviewer identity and isolation attestation, start/end/duration, unedited answers, independently discovered paths/headings, discovery trail, author interventions, per-question verdicts, blockers, and overall result in your final response. Do not edit files.

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.
```

## Fresh-context attestation

- [x] I did not author or reconcile the candidate.
- [x] I received no inherited author conversation, compaction, memory, private state, answer key, or earlier review output.
- [x] I received only the candidate root, fixed questions, and procedural scope constraints.
- [x] I received no ADR/file pointer, design summary, diff tour, search term, expected answer, or expected result.
- [x] I navigated the repository independently through its instructions, decision index, history, and search.
- [x] I did not open, read, or search any prior cold-, blind-, or invalid-review artifact.
- [x] `docs/decision-evidence/20260828-addressed-messaging-1538fc2a-blind-review.md` appeared only as a path in `git show --name-status`; no content, answer, or verdict was returned.
- [x] I did not ask the author for help.
- [x] I did not modify the candidate.
- [x] Author interventions were none.

## Unedited reviewer answers

### 1

The candidate makes no new standalone product choice. It repairs the current addressed-messaging authority chain so the already-admitted 2026-08-28 decisions are unmistakably current:

- Every `HarnessEndpoint.send({to, content})` invocation creates a distinct post with a fresh Client-minted `PostId`; hosts decide whether to call again.
- An `ActionProposal` carries no action vote. Its outer `SignedMessage` proves authorship, then every member—including the author—durably locks the first valid Router-ordered candidate before emitting an action signature.
- OpenClaw and NanoClaw integrations stop at stock host callbacks. Hosts own session topology, context, prompt/output interpretation, persistence, retry, ACL, scheduling, and sandbox behavior.
- The retained addressed contract remains explicit `agent:`/`group:` addressing, immutable fixed groups, `HarnessEndpoint`, GENESIS/POST certification, endpoint-replicated durability, addressed inbound delivery, and the incompatible fresh-state cut.

It resolves stale lineage that still presented host-supplied idempotency, a MoltZap-selected native session topology, and host-persistence-before-acknowledgment as current. It also reconciles `docs/spec/identity.md` with the already-admitted daemon configuration by assigning the private key path to `MOLTZAPD_AGENT_PRIVATE_KEY_FILE`.

Binding statements are, in authority order:

1. `AGENTS.md` and `v2/VISION.md`.
2. Current ADR Decision Outcomes and visible Supersession sections.
3. The `G1-DEC-NNN` manifest in `20260811-four-layer-endpoint-replicated-harness.md`.
4. Normative `docs/spec/` chapters.

The old bodies of superseded or partially superseded ADRs remain historical reasoning. ADR Context, Considered Options, Consequences, and changelog receipts do not override current outcomes. `docs/architecture/` is explicitly orientation/execution material. `docs/decision-evidence/` is non-normative provenance.

Independently discovered paths/headings:

- `v2/VISION.md` — Current cutover decisions, Authority, First executable profile.
- `docs/decisions/README.md` — Canonical reading guidance.
- `20260827-addressed-messaging-replaces-openfloor.md` — Supersession, Decision Outcome.
- The three accepted 2026-08-28 ADRs — Decision Outcome.
- `20260811-four-layer-endpoint-replicated-harness.md` — Gate 1 traceability disposition.
- `docs/spec/README.md` — Authority and reading order, Addressed Client boundary.

### 2

The lineage is complete and discoverable:

| Earlier outcome | Current disposition |
|---|---|
| `HarnessClient` owns runtime context and presentation checkpoints | Fully superseded. Client exposes `HarnessEndpoint` and builds no model/session context. Stock hosts own session topology and cross-address context. |
| Model output is conversation start or bound reply | Fully superseded. Output is explicit addressed send; there is no start, bound reply, inherited authority, or generic current-chat target. |
| Public `ConversationId`, caller-minted START retry identity, current-conversation turns | Fully superseded. Conversation identity is private; runtime uses addresses and new posts. |
| Host outbox identity supplies Client idempotency | Superseded by `20260828-hosts-own-send-retry-policy.md`. Each invocation gets a fresh `PostId`; only recovery within that invocation reuses it. |
| MoltZap selects one native host session and controls host prompt/output/persistence | Superseded by `20260828-channel-adapters-use-stock-host-apis.md`. Those concerns are host-owned. |
| Proposal embeds `authorSignature` before Router ordering | Replaced at the normative representation level by `20260828-action-signatures-follow-router-order.md`; no admitted outcome is displaced because the retained first-Router-ordered-candidate law remains unchanged. |
| Client owns closed protocol representation, endpoint SQLite persistence, registration recovery, management isolation, catch-up, re-anchor, and explicit daemon configuration | Retained from `20260813-client-protocol-and-attention.md`. Its events-v1/OpenFloor/turn/grant mechanisms are replaced. |
| Four layers, endpoint history, stage-before-vote, catch-up, re-anchor, seven packages, no product Ledger | Retained from `20260811-four-layer-endpoint-replicated-harness.md`. |
| Simulator post-Router directed fault boundary | Untouched. |
| Identity/Router representations, Registry registration idempotency, Router transport retry identity, and stable inbound-delivery replay | Untouched. They are distinct from removed cross-invocation Client send idempotency. |

The current normative contract is distributed deliberately:

- Runtime API: `docs/spec/harness/client.md`.
- Send semantics: `docs/spec/harness/output.md`.
- Inbound delivery and callback-before-ack: `docs/spec/harness/ingress.md`.
- Stock host ownership: `docs/spec/harness/channels.md`.
- GENESIS/POST and lock-before-sign: `docs/spec/harness/tasks.md`.
- Private identifiers, packets, certificates, recovery, pending delivery, and schema cut: `docs/spec/conversation-history.md`.
- Daemon configuration and persistence: `docs/spec/harness/daemon.md`.
- MCP-only management: `docs/spec/management.md`.
- Package graph and assumptions: `docs/spec/layer-interfaces.md`.
- Registry key-file ownership: `docs/spec/identity.md` — Registration.
- Stable decision mapping: `20260811-four-layer-endpoint-replicated-harness.md` — Gate 1 traceability disposition.

### 3

An implementer must:

- Expose structural `HarnessEndpoint.send({to, content})` and `messages`.
- Resolve explicit `agent:` or `group:` addresses; direct membership is two, groups are 3–32 total immutable members.
- Mint a fresh 32-byte opaque `PostId` once per send invocation, persist that intent before protocol traffic, and reuse it only to recover that invocation.
- Return `void` only when the local endpoint durably holds the complete action- and durability-certified record.
- Emit direct/group deliveries derived from certified remote-authored records, with canonical address, sender, content, exact group membership, and stable transport acknowledgment.
- Invoke the stock inbound callback first; acknowledge Client delivery only after successful callback completion.
- Forward a stock current-origin reply callback to the inbound canonical address, or validate an explicit proactive `agent:`/`group:` destination. Invoke Client exactly once per callback.
- Encode `ActionProposal` without `authorSignature`. Verify its outer envelope and author binding, durably lock the first valid gap-free Router-ordered candidate, then apply local policy and emit the normal action signature.
- Require unanimous GENESIS signatures. Require author-inclusive `q(n)` POST action signatures and independent `q(n)` durability votes, where `q(n)=n` for `n<4` and otherwise `n-floor((n-1)/3)`.
- Preserve endpoint SQLite schema 2, stage-before-vote, signer evidence, automatic catch-up, Router re-anchor, pending-delivery replay, and exact daemon configuration.
- Preserve the seven-package graph and consumer-only adapters.
- Start from fresh compatible endpoint/host state.

An implementer must avoid:

- Public `ConversationId`, START, `HarnessClient`, turns, grants, bound reply, inherited destinations, proof-shaped success, or compatibility aliases.
- Host `IdempotencyKey`, cross-invocation Client deduplication, or `idempotency-conflict` in Client send.
- Any action vote before Router-ordered lock, including an author fast path or proposal-embedded action evidence.
- Host source patches, provider-owned host databases, custom session topology, prompt/output interpretation, inbox/outbox policy, ACL materialization, retry queues, or sandbox drivers.
- Adding conversation or policy semantics to Registry/Router.
- A product Ledger, per-recipient Router persistence, compatibility package, dual stack, migration, decoder, rollback automation, or automatic old-state erase.
- Treating a faulted Simulator observation as Router-conformance evidence.

Affected layers and consumers:

- Identity remains the card/signature/bootstrap owner; its registration chapter now points to the daemon-owned key-file configuration.
- Router remains opaque, volatile, and non-equivocating.
- Client owns conversations, protocol, persistence, recovery, daemon, and `HarnessEndpoint`.
- OpenClaw and NanoClaw consume Client through stock APIs.
- Simulator and evals consume the real daemon-backed Client; private Simulator faults occur after Router ordering.

Assumptions:

- One correct, non-equivocating Registry and Router.
- Endpoints may be Byzantine. For `n>=4`, the storage guarantee assumes at most `f=floor((n-1)/3)` Byzantine members and honest stage-before-sign. For `n<4`, that replicated-storage guarantee assumes zero Byzantine members.
- Safety is timing-independent.
- Progress requires applicable identity material, Router availability, enough responsive members for both action and durability thresholds, and an honest source for missing ancestry.
- A selected candidate can stall indefinitely; there is no timeout replacement or view change.
- Registry/Router/quorum outage blocks new progress but does not invalidate already certified local history.
- Send completion is local certification, not immediate all-member readability.
- Compatibility is exact: protocol `2026.827.1`, hash domain v2, events-v2, SQLite schema 2. Only an empty version-0 store initializes; old, mixed, or nonempty incompatible state fails closed without mutation.

### 4

Every reviewed relevant ADR names **Tapan Chugh** as `decision-makers`. The ledgers do not establish that the source-session account authored every ADR rationale; repository law assigns accountability through the admitted ADR field.

Material cited source events include:

- `20260811-four-layer-v2-cutover-trajectory.md`:

  - `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d` at `2026-08-11T17:56:38.308Z` requests simplifying eight layers, removing the product Ledger/monitoring/revocable-credential layers, endpoint-held history, and recursively modeled institutions/governance.
  - Planning request/result `fc_...b62f6d1...` / `fco_019ff1fd...` records “simplify but don't change too much” and preserve semantics.
  - `fc_...b63d625...` / `fco_019ff200...` initially selects five layers.
  - `fc_...b64c1c3...` / `fco_019ff202...` selects the trusted Router, fixed one-third threshold with all members for `n<4`, and any-member finalization.
  - `fc_...b653f727...` / `fco_019ff204...` selects automatic catch-up and suggests merging L2/L3.
  - `fc_...b65c1e660...` / `fco_019ff206...` later selects four layers, replacing the five-layer answer, and selects authority/spec before code.
  - `fc_...b6627e62...` / `fco_019ff209...` keeps action and durability certificates separate and questions retaining profiles/old Client.
  - `fc_...b692b46...` / `fco_019ff213...` selects quorum re-anchor and a long-lived cutover branch.
  - `msg_019ff231-e57a-7323-a0a3-c98c9b10ff22` selects the preceding durable plan as the execution goal.
  - Registry recovery is explicitly deferred by `msg_019ff2a1-23e6-7f90-b627-7df2faa176b6`; the ledger says this does not resolve the remaining recovery contract.

- `20260801-harness-mcp-and-dispatch-trajectory.md`, supporting the now-historical changed ADRs:

  - `msg_019fba76-81b9-7481-a39f-2b50c544bcdd`, `msg_019fbb68-fe7b-7103-a5d3-ac5ca1e8b626`, and `msg_019fbb70-7315-7b32-b6fd-f2df0c84426d` address Client-owned cross-conversation context and source-conversation notification.
  - D13 initially receives answer `A` in `msg_019fbb9d-03e4-7511-bfa1-1f273eb0865a`, then `msg_019fbb9d-59cc-7683-a137-4c9c8abe48c8` reverses it with “actually store the cursors etc. locally and then use C.”
  - D14 and D15 receive `A`, selecting pre-emission checkpoint advancement and stable checkpoints.
  - `msg_019fbeaf-8633-7e42-bf60-c9db136f911b` answers `yes.` to the retained stable-contract scope prompt.
  - `msg_019fbeb3-0e41-7e62-89a4-5b543e31c546` states that undiscussed design decisions and failure modes are out of scope.
  - `msg_019fbaa1-1e06-7cb3-8011-92d5de109a9a` and `msg_019fbaa2-8c81-7f51-a106-7b92d66c1679` remove generic send completely.
  - The ledger explicitly says no located human event states the complete atomic-START formulation or accepts the later proposed finite ingress profile.

- `20260811-four-layer-v2-cutover-trajectory.md` — Reduced HarnessClient boundary:

  - `msg_019ff821-75f6-70c3-b36b-54f732ad8242`, `msg_019ff822-0a13-7130-9814-109109a0ab1b`, and `msg_019ff827-7b2a-7441-9f35-8b538e86add8` request further Client simplification.
  - Assistant prompt `msg_0fe7c1dd2e31cd97016a7cff8a2f50819397e84c52bd26d36c` presents the exact reduced boundary.
  - Human `msg_019ff852-c742-7480-b464-fdae2792c6ad` says “accept the reduced boundary”; later `msg_019ff861-be31-7b40-b774-86ef3048c32a` says “we accept the changes.”

- `20260813-client-protocol-and-attention-trajectory.md`:

  - `fc_0fe7c1dd2e31cd97016a7d4fa1be4c819397c851716801b843` /
    `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0` selects nested `SignedMessage` evidence and explicitly defers host-memory fallback with “just defer it now. let the evals fail.”
  - The attention prompt/result initially selects “Every action”; human message `msg_019ff989-fa2d-76f0-8d83-7b09f663643a` immediately corrects it with “actually fine to not content again.”
  - `msg_019ff993-e348-7272-9e3c-f5ddce9d116e` directs the plan back to the four-layer track.
  - Assistant plan `msg_0fe7c1dd2e31cd97016a7d58c392bc8193bef23bb36ab9fc93` is followed by human instruction `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36`, “Implement the plan.”
  - The ledger states that exact field names, database tables, error literals, and environment-variable names are not separately attributed human selections.

- `20260827-addressed-messaging-trajectory.md` records local-history lines 2920, 2922, 2924, 2925, 2927, 2930, 2932, 2929, 2936, 2940, and 2943. Their literal events request groups and shared meetings, removal of OpenFloorV1, reuse of host code, `agent:`/`group:` addressing, no automatic semantic notifications, group visibility, no backward compatibility, deferral of CoordBench migration, implementation of the missing plan, and a terse “ookay, that sounds good. proceed.”

- `20260813-simulator-link-fault-ordering-trajectory.md` records human messages `msg_019ffc35-0352-7773-8385-27cd5007f44a` and `msg_019ffc35-0365-7dc3-bede-dd08ccfb4e38`, with the literal “life-level” wording and “that's the point of testing right.” The following assistant event records the interpretation applied: explicit post-Router link-level perturbation is fault-tolerance evidence, not Router-conformance evidence.

Explicit source gaps:

- The 20260827 local history has no native message IDs, enclosing turns, parent locators, or explicit role fields. It omits intervening agent explanations, structured prompts/selections, and the final plan. It cannot independently establish canonical sorting, the ordinary-post threshold, or detailed wire/interface shapes from terse replies.
- Each of the three accepted 20260828 ADRs has a dedicated source-gap report. No source session, native event/message locator, enclosing turn/parent locator, or exact UTC event timestamp was available. The reports retain no decision event and do not reconstruct one from ADR prose, Git, memory, or repository changes.
- Those reports explicitly say the addressed-messaging trajectory predates the retry reversal and action-signature representation decision, and that earlier channel provenance predates the stock-host boundary.
- These are accidental provenance gaps, explicitly disclosed. No source event was invented.

### 5

The strongest apparent contradiction is inside the partially superseded `20260827-addressed-messaging-replaces-openfloor.md` body itself:

- Its historical semantic interface still includes `idempotencyKey` and derives `PostId` from a host outbox identifier.
- Its historical host section still requires one native session, naming OpenClaw’s main session and NanoClaw’s `agent-shared` session.

The contradiction is resolved without guessing:

1. The ADR frontmatter is `partially-superseded`.
2. Its immediately visible Supersession section says the retry ADR replaces `IdempotencyKey`, host-derived `PostId`, cross-invocation deduplication, and `idempotency-conflict`.
3. The same section says the stock-host ADR replaces MoltZap-owned session topology, prompt/output interpretation, persistence/replay, ACL materialization, and sandbox execution.
4. `v2/VISION.md`, the current manifest, and the normative Client/output/channels specs consistently carry fresh Client-minted post identity and host-owned session behavior.
5. The decision index lists both secondary replacements.
6. The retained portions—addresses, fixed groups, `HarnessEndpoint`, GENESIS/POST, endpoint durability/delivery, and fresh-state cut—remain current.

Older Gate 1 inventory rows and architecture pages still contain `HarnessClient`, events-v1, START, bound reply, and native-session vocabulary. They are visibly marked historical, superseded, or non-normative and point readers to the replacement chain. They do not outrank current ADRs/specs.

No unresolved contradiction or broken lineage remains.

### 6

Yes. A teammate can implement the selected addressed-messaging profile without chat or inventing a binding choice. The decision index, current ADRs, stable manifest, exact spec headings, current architecture plan, and source-gap disclosures are all discoverable. The ADR shape check resolved every required ADR/index/provenance anchor.

Deliberate deferrals:

- Package publication membership, coordinated versus independent versions, external-consumer cutover, and release/deployment policy.
- Dynamic, mutable, or named groups; multiple group identities for the same member set; add/remove/leave semantics.
- Pruning, garbage collection, retention policy, physical storage optimization beyond identity preservation, and disk-loss recovery.
- End-to-end encryption/key distribution, public observers, cross-history audit conventions, and non-member disclosure protocols.
- Malicious or replicated Registry/Router, Router consensus/failover/fork detection, identity rotation/revocation/recovery, delegation evidence, and peer-card custody.
- Fragmentation, larger resource profiles, and binary/media action content.
- Richer task/norm vocabularies and action mapping, configurable quorums, timeout replacement, view change, pass/takeover/dispute protocols, fairness/starvation guarantees, and signature aggregation/FROST.
- Portable personal-trust conformance and a separate transactional evidence-outbox mechanism.
- Remote daemon administration, hostile-host/local-auth hardening, dynamic ports, attach modes, and universal supervision.
- MCP cursors, alternate push, asynchronous task handles, and dynamic action tools.
- Cross-conversation eval success until a stock host supplies suitable memory behavior.

Deliberate ownership boundaries, not gaps:

- Host sessions, context, prompts, final-text behavior, inbox/outbox persistence, deduplication, replay effects, ACLs, retries, scheduling, and sandboxing are stock-host responsibilities.
- If a stock host lacks a desired behavior, the adapter provides fewer host-level guarantees until a released upstream host supplies it. MoltZap does not fork the host.

Accidental gaps:

- The 20260827 provenance omissions described in answer 4.
- The complete absence of source-faithful event rows for all three 20260828 decisions.
- These are evidence/audit gaps, not missing normative implementation choices. The accepted ADRs and exact specs still define the implementation contract.

No accidental normative-owner gap, unresolved current choice, broken link, or missing supersession was found.

## Per-question verdicts

| Question | Verdict | Reason |
|---:|---|---|
| 1 | PASS | Current composite decision, problem, and authority distinction are discoverable. |
| 2 | PASS | Earlier outcomes, retained scope, replacements, untouched laws, and normative owners are explicit. |
| 3 | PASS | Implementer obligations, prohibitions, affected layers, and all material assumptions are exact. |
| 4 | PASS | Decision-maker attribution, retained source events, reversals, deferrals, and source gaps are discoverable without invention. |
| 5 | PASS | The strongest apparent contradiction resolves through explicit status, Supersession, and authority order. |
| 6 | PASS | The selected profile is implementable; deliberate deferrals and accidental provenance gaps are distinguishable. |

## Discovery trail

| Order | Navigation step | Result |
|---:|---|---|
| 1 | `pwd`, Git status, commit/tree lookup, branch and latest commit metadata | Froze clean candidate `89e9609e…`; discovered candidate parent and tree. |
| 2 | `rg --files -g AGENTS.md`; read root and `v2/AGENTS.md` | Discovered authority order and mandatory decisions/blind-review procedure. |
| 3 | Read `nx-workspace`, `decisions`, provenance, cold-read, documentation, and reviewer skills | Established read-only procedure and quarantine rules. |
| 4 | `git show --name-status HEAD` | Independently discovered four changed ADRs, Vision/spec/architecture changes, and one quarantined prior-review path. |
| 5 | Read `docs/decisions/README.md` | Found current reading guidance, statuses, and the 20260811 manifest owner. |
| 6 | Read all four changed ADRs | Found corrected Supersession sections and changelog receipts. |
| 7 | Read 20260811, 20260827, and all three 20260828 current ADRs | Reconstructed retained/replaced decision chain. |
| 8 | Read `v2/VISION.md` and relevant normative spec chapters | Verified current behavior, assumptions, compatibility, and normative ownership. |
| 9 | Read explicit non-quarantined trajectories and source-gap reports | Verified source events, reversals, deferrals, and absence reports. |
| 10 | Searched current ADR/spec/architecture content while excluding `docs/decision-evidence/**` | Located stale `idempotencyKey`, native-session, events-v1, and `HarnessClient` assertions and verified their historical/superseded status. |
| 11 | Ran repository setup and mechanical ADR shape checks | Setup complete; `[check-adr-shape] PASS — 65 record(s) well-formed.` |
| 12 | Rechecked Git status and candidate identity | Candidate remained clean and unchanged. |

## Author interventions

None.

## Blockers

None.

## Overall result

**PASS.** All six answers are accurate and independently discoverable from the frozen candidate. Current status, supersession, authority, assumptions, normative ownership, stable manifest lineage, and provenance/source-gap reporting are consistent. No author hint, quarantined review content, implementation-code evaluation, or candidate modification occurred. Maintainer acceptance remains required.
