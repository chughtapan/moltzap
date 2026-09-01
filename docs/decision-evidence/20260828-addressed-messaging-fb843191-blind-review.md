# Addressed messaging blind review — `fb843191`

Status: **FAIL**

This is a quarantined blind-review artifact. Future blind reviewers must not
open, read, or search its contents.

## Exact prompt

```text
Candidate repository root: /home/tapanc/moltzap-v2-cutover

Start from that repository root and follow all applicable repository instructions for the blind teammate review gate. This is one fresh, uninterrupted context with no inherited conversation, compaction, memory, private state, or earlier review output. Do not open, read, or search the contents of any earlier *-cold-review.md, *-blind-review.md, or invalid-review record. If a command returns an answer or verdict from one of those quarantined records, invalidate the run immediately. There will be no author coaching or follow-up during the run.

Ask and answer exactly these questions:

1. What decision does this candidate make current, what problem does it
   resolve, and which statements are binding versus context or
   non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched,
   and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers
   are affected, and under what fault, trust, safety, liveness, and
   compatibility assumptions?
4. Which humans are named as decision-makers, which source events does
   the compacted trajectory cite for their calls, alternatives,
   reversals, and deferrals, and what source gaps does it explicitly
   record? Report only what the event ledger states; do not infer
   motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or
   broken lineage elsewhere in the repository. Resolve it using the
   authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing?
   List every missing link or unresolved choice and classify each as a
   deliberate deferral or an accidental gap.
```

## Unedited reviewer report

## Review identity

- Candidate commit: `fb8431917f10f184a3768da84263095ab5e795a6`
- Candidate tree: `5de6dae68f5a9d00dc407f135ac62ddd8b32b2da`
- Digest: Git SHA-1 tree from `git rev-parse HEAD^{tree}`
- Branch: `impl/addressed-messaging-native-sessions`
- Worktree: clean before and after review
- Reviewer: Codex fresh agent `/root/adr_blind_review`
- Started: `2026-08-29T01:32:41Z`
- Finished: `2026-08-29T01:40:47Z`
- Duration: 8 minutes 6 seconds
- Author interventions: none
- Earlier review artifacts: filenames were visible in a directory listing; no `*-cold-review.md`, `*-blind-review.md`, or invalid-review content was opened or searched.

## Fixed questions and answers

### 1. What decision does this candidate make current, what problem does it
   resolve, and which statements are binding versus context or
   non-normative explanation?

The candidate makes the addressed-messaging cutover current, refined by three 2026-08-28 decisions:

1. `20260827-addressed-messaging-replaces-openfloor.md`, now partially superseded, replaces OpenFloorV1, caller-visible conversations, START/bound reply, grants, and turn-oriented delivery with explicit `agent:`/`group:` posts, deterministic private fixed-member conversations, `GENESIS`/`POST`, endpoint-certified history, and stable addressed delivery.
2. `20260828-hosts-own-send-retry-policy.md` removes caller `IdempotencyKey` and `idempotency-conflict`; every send invocation creates a fresh Client-minted `PostId`, while recovery reuses it only within that invocation.
3. `20260828-action-signatures-follow-router-order.md` removes proposal-embedded `authorSignature`; the outer signed envelope proves authorship, and every member—including the author—locks the first valid Router-ordered candidate before emitting an action signature.
4. `20260828-channel-adapters-use-stock-host-apis.md` limits adapters to stock host callbacks. Sessions, prompts, final-text interpretation, inbox/outbox persistence, retry, ACLs, and sandbox behavior belong to the host.

These resolve four problems: duplicated Client/host conversation machinery, ambiguity between retry and repeat, the contradiction between pre-order author signatures and first-ordered-candidate locking, and channel adapters becoming host forks.

Binding material is the repository law and constitution, each current ADR’s `Supersession` and `Decision Outcome`, and the manifest’s current dispositions and normative owners. ADR context, consequences, historical body text displaced by a Supersession section, architecture orientation, record changelogs, and decision-evidence trajectories are explanatory or historical rather than normative.

Discovered paths/headings:

- `AGENTS.md` — Decisions; Docs
- `v2/VISION.md` — Authority; The constitution; First executable profile
- `docs/decisions/README.md` — Canonical reading guidance
- The four ADRs above — Supersession; Decision Outcome

Per-question verdict: **PASS** for discoverability and interpretation.

### 2. What earlier outcomes does it replace, retain, or leave untouched,
   and where does the current normative contract live?

Replaced outcomes include:

- OpenFloorV1, START/MULTICAST, BEGIN/ACK contention, reply grants, turn readiness, and unanimous ordinary actions.
- `start_conversation`, bound `reply`, public `ConversationId`, `TxnId`, events-v1, current-chat targeting, Client-built context, and proof-shaped send success.
- Host-provided idempotency keys and cross-invocation Client deduplication.
- Proposal-embedded action signatures.
- MoltZap-selected host session topology, provider-defined prompt/final-text behavior, provider-owned host inbox semantics, ACL materialization, and sandbox execution.
- The five incompatible Simulator contracts: empty open, inherited/unaddressed send, message-only receive, runtime Router authority, and persisted Router-order claims.

Retained outcomes include:

- Exact `agent:` and canonical fixed-member `group:` addresses.
- Deterministic private conversation identity, immutable membership, unanimous `GENESIS`, author-inclusive threshold `POST`, stage-before-vote durability, certified endpoint history, catch-up, and Router re-anchor.
- Stable Client pending-delivery identity and replay.
- One daemon per configured local state directory, one `/mcp`, MCP-only management, the seven-package DAG, opaque Router transport, and immutable Registry identity.
- The four-layer model and endpoint-owned personal-trust decisions.

The retry and channel ADRs supersede only their stated portions of the addressed-messaging ADR. The action-signature ADR changes the normative wire mechanism without replacing another admitted ADR outcome. Unlisted manifest rows retain their existing disposition.

The intended authority chain is:

1. `AGENTS.md` and `v2/VISION.md`
2. Current outcomes in the four ADRs above plus retained portions of `20260811-four-layer-endpoint-replicated-harness.md`
3. Its `Gate 1 traceability disposition`
4. `docs/spec/conversation-history.md`, `harness/client.md`, `output.md`, `ingress.md`, `channels.md`, `tasks.md`, `daemon.md`, and `layer-interfaces.md`

However, that normative chain is not internally consistent in this candidate. `G1-DEC-612` and `G1-DEC-641` point to the nonexistent `harness/output.md — Native host projection` heading, and `G1-DEC-619` points to a `Durable host delivery` section that states the superseded durable-host-insertion rule.

Per-question verdict: **FAIL** because current normative ownership contains broken and contradictory links.

### 3. What must an implementer now do or avoid, which layers or consumers
   are affected, and under what fault, trust, safety, liveness, and
   compatibility assumptions?

An implementer must:

- Expose structural `HarnessEndpoint.send({to, content})` and `messages`, with no caller idempotency key.
- Mint a random opaque `PostId` once per invocation before persistence or traffic; retain it only for recovery of that invocation.
- Resolve direct and 3–32-member group addresses through Registry, insert self for groups, reject duplicates/unknown names, and canonicalize names by ASCII byte order.
- Use unanimous `GENESIS`; use author-inclusive `q(n)` for `POST`, where `q(n)=n` below four members and otherwise `n-floor((n-1)/3)`.
- Authenticate an `ActionProposal` using its outer `SignedMessage`; require the outer sender to equal the post author; count that envelope as no action vote.
- Make all members, including the author, durably lock the first valid gap-free Router-ordered candidate before signing.
- Keep action evidence, durability votes, and logical hashes distinct; retain signer identities/signatures while excluding evidence maps from `ActionHash` and `RecordHash`.
- Return `void` only after the local complete action- and durability-certified record is durable.
- Project canonical addressed inbound messages and acknowledge Client delivery only after successful completion of the stock host callback.
- Keep host session selection, prompt/final-text behavior, persistence, duplicate handling, retries, ACLs, scheduling, and sandbox execution outside MoltZap.
- Enforce the hard cut: protocol `2026.827.1`, Client hash domain v2, events-v2, SQLite schema 2, and empty-version-0-only initialization. Mixed peers and old/nonempty stores fail without migration, erase, shim, or rollback automation.

It must avoid public conversation identity, grants, inherited destinations, provider retry queues, host queue identifiers, host source patches, provider-owned host databases, compatibility facades, raw Router/runtime credentials, or a product Ledger.

Affected consumers are Client/daemon, OpenClaw and NanoClaw adapters, Simulator, evals, MCP projections, and documentation. Identity supplies immutable cards and signed envelopes; Router remains content-blind and provides ordering only.

Assumptions:

- Registry and Router are correct and non-equivocating, though they may be unavailable or restart.
- Endpoints may be Byzantine. For `n>=4`, durability assumes at most `f=floor((n-1)/3)` Byzantine members and proves at least `n-2f` honest staged replicas. Small groups make that storage guarantee only with zero Byzantine members.
- Safety is timing-independent and depends on signatures, quorum intersection, first-candidate non-double-signing, and the correct Router.
- Progress requires service availability, the required responsive action and durability quorums, and an honest source for missing ancestry. A withholding selected quorum stalls the conversation; there is no fairness, timeout replacement, or view change.
- Host persistence and replay effects are not MoltZap guarantees unless the stock host contract supplies them.

The governing intent is discoverable, but active scoped instructions and implementation contradict it, so an implementer cannot safely apply it without reconciliation.

Per-question verdict: **FAIL**.

### 4. Which humans are named as decision-makers, which source events does
   the compacted trajectory cite for their calls, alternatives,
   reversals, and deferrals, and what source gaps does it explicitly
   record? Report only what the event ledger states; do not infer
   motives, confidence, urgency, or rationale.

Every candidate ADR names **Tapan Chugh** as decision-maker.

`20260827-addressed-messaging-trajectory.md` cites Codex local-history session `019fd899-779c-7e70-a8e4-338727b13e6c`:

- Event 1: line 2920, `2026-08-27T18:57:37Z` — asks to restore cross-conversation context and add groups/private calls/shared meetings.
- Event 2: line 2922, `2026-08-27T19:27:10Z` — says to remove OpenFloorV1.
- Event 3: line 2924, `2026-08-27T19:55:09Z` — says to fall back to existing OpenClaw/NanoClaw code where possible.
- Event 4: line 2925, `2026-08-27T20:41:17Z` — asks about one main session and only `agent:`/`group:` forms.
- Event 5: line 2927, `2026-08-27T20:52:54Z` — selects agent addresses and no automatic notifications.
- Event 6: line 2930, `2026-08-27T21:29:13Z` — asks whether OpenClaw’s message tool is preferable to direct reply; it does not establish an answer.
- Event 7: line 2932, `2026-08-27T21:52:53Z` — asks about native messaging and requires group visibility; the missing explanation/selection is not retained.
- Event 8: line 2929, `2026-08-27T21:17:54Z` — defers CoordBench migration and says backward compatibility and rollback are not goals.
- Event 9: line 2936, `2026-08-27T22:21:49Z` — asks whether work is on the four-layer cutover branch.
- Event 10: line 2940, `2026-08-27T22:52:08Z` — says “Implement the plan”; the plan is absent.
- Event 11: line 2943, `2026-08-27T23:54:53Z` — says “ookay, that sounds good. proceed”; the preceding prompt is absent, so the ledger does not establish what it accepted.

That trajectory lacks native message IDs, turn IDs, parent locators, an explicit stored actor-role field, intervening agent explanations, structured prompts/selections, and the final plan. It explicitly does not reconstruct canonical-sorting rationale, the selected threshold, detailed interfaces, or what Event 11 accepted.

Each new 2026-08-28 ADR links a source-gap report. All three reports state that no source event was located because the active conversation exposed no native source-session identifier, locators, turns/parents, or exact UTC timestamps. The prior addressed trajectory predates the retry reversal, action-proposal representation choice, and stock-host boundary and does not establish those calls.

Per-question verdict: **PASS for discoverability**, with three explicit provenance gaps that do not substantiate the new calls.

### 5. Find the strongest apparent contradiction, stale instruction, or
   broken lineage elsewhere in the repository. Resolve it using the
   authority order or report it as a blocker.

The strongest contradiction is in `packages/openclaw-channel/AGENTS.md → Host integration law`. It requires:

- every delivery to use OpenClaw’s resolved main session;
- visible output to use the native `message` tool;
- plain final text to remain private; and
- acknowledgment only after native durable acceptance.

That is scoped agent law, yet it conflicts with root law, `v2/VISION.md → Local runtime surface`, the accepted stock-host ADR, and `docs/spec/harness/channels.md → Stock host boundary`, all of which assign session topology, tool/output interpretation, and host persistence to stock OpenClaw.

The root `AGENTS.md` says scoped instructions refine rather than override the constitution and that a conflict stops work. Therefore authority order does not make the repository consistent; the scoped instruction must be reconciled. It is a blocker.

The active implementation confirms the conflict:

- `packages/openclaw-channel/openclaw.plugin.json` exposes MoltZap-owned `shared` and `private` modes.
- `packages/openclaw-channel/src/openclaw-entry.ts` owns that mode and selects main versus address sessions.
- `openclaw-entry.test.ts` pins both MoltZap session topologies and provider-owned journal/deduplication behavior.
- `packages/openclaw-channel/README.md` documents those guarantees.

There are also two broken manifest locators:

- `G1-DEC-612`
- `G1-DEC-641`

Both cite the removed `docs/spec/harness/output.md — Native host projection` heading.

Per-question verdict: **FAIL — blocker**.

### 6. Could a teammate implement the decision without chat or guessing?
   List every missing link or unresolved choice and classify each as a
   deliberate deferral or an accidental gap.

No. The core Client protocol is detailed enough, but the host-adapter boundary cannot be implemented consistently from the candidate.

Accidental gaps:

1. The scoped OpenClaw agent law and active adapter implementation contradict the accepted stock-host boundary.
2. `G1-DEC-612` and `G1-DEC-641` have nonexistent normative-owner headings.
3. `G1-DEC-619` says acknowledgment follows successful callback completion and host persistence is host-owned, but its named `conversation-history.md → Durable host delivery` owner requires durable host acceptance, duplicate success without a second model invocation, and typed payload collision.
4. The same superseded durability rule remains in:
   - `docs/spec/harness/client.md → Addressed inbound delivery`
   - `docs/spec/harness/daemon.md → Delivery ownership`
   - `docs/spec/layer-interfaces.md → Recovery`
   - `docs/spec/README.md → Gate 1 chapters` and `Addressed Client boundary`
   - `packages/client/README.md`
   - `packages/client/src/harness-mcp-contract.ts`
5. `docs/spec/README.md` still describes `harness/channels.md` as owning “One native host session.”
6. OpenClaw public/integration docs and tests still prescribe shared/private sessions, native-message-tool output, private final text, and native durable receive semantics.
7. The three 2026-08-28 decisions have explicit provenance gaps: no retained source event establishes the human call.

Deliberate deferrals, grouped from `v2/VISION.md` and the stable manifest:

- Publication membership, coordinated versus independent versions, release/deployment ordering, and external-consumer cutover (`G1-DEC-708`, `709`, `814`).
- Router replication, Byzantine sequencing, fork detection, failover, malicious Registry tolerance, identity rotation/recovery (`800`, `801`).
- Dynamic/mutable/named groups and changing-history authorization (`803`).
- Richer task/norm vocabularies, configurable quorums, view change, timeout replacement, pass/takeover, disputes, fairness/starvation, and FROST/signature aggregation (`804–806`, `821`, `823`).
- Portable personal-trust conformance and ordinary-protocol screening/institution/contact behavior (`807`, `820`).
- Local daemon authentication, hostile-host defense, dynamic ports, attachments, universal supervision, remote administration (`808`, `818`).
- MCP cursors, alternate push, asynchronous handles, and dynamic action tools (`809`).
- A separate transactional evidence outbox (`810`).
- Larger resource profiles, fragmentation, binary/media content, encryption/key distribution (`811–813`).
- Pruning, garbage collection, local disk-loss recovery, public/non-member disclosure, and cross-history audit conventions (`712`, `817`).
- Delegation evidence and peer-card custody (`815`).

Stock-host session, persistence, retry, ACL, prompt/output, and sandbox behavior is an intentionally delegated boundary, not a MoltZap implementation deferral.

Per-question verdict: **FAIL**.

## Discovery trail

1. Read root `AGENTS.md`, the local decisions procedure, fixed questions, provenance rules, and review template.
2. Fixed the clean commit/tree identity and inspected HEAD’s file-name-only change list.
3. Followed `docs/decisions/README.md → Canonical reading guidance`.
4. Read the addressed-messaging ADR, its three refinements, the four-layer manifest, and direct supersession lineage.
5. Read the addressed trajectory and three source-gap reports.
6. Read `v2/AGENTS.md`, `v2/VISION.md`, and the manifest-owned normative chapters.
7. Searched current specs for displaced idempotency, native-session, and host-durability vocabulary.
8. Followed the resulting conflicts into package-scoped instructions, OpenClaw manifest, source, tests, and README.
9. Rechecked candidate identity and verified the worktree remained clean.

## Overall result

Result: **FAIL**

Blocking findings:

- Contradictory top-authority scoped OpenClaw instructions.
- Active OpenClaw implementation contradicts the accepted stock-host boundary.
- Broken manifest locators at `G1-DEC-612` and `G1-DEC-641`.
- `G1-DEC-619` points to a normative section that states the opposite persistence/deduplication contract.
- Multiple current normative/public documents retain the superseded host-durability and session-topology guarantees.

These require a new frozen candidate and different fresh reviewer after reconciliation.
