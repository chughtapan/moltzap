# Blind review result: FAIL

## Review record

- Reviewer: fresh Codex subagent `/root/blind_candidate_review_24a09aa930`
- Isolation: received only the repository root, candidate commit, six fixed questions, and read-only/quarantine rules. No inherited conversation, summary, design pointer, diff tour, expected answer, or prior-review output.
- Candidate: `24a09aa9305159ce987b4ecdfd76547fa0153645`
- Parent: `9d3488c1db028f362008384a865c07a7d9dc317d`
- Git tree: `e221bb2f3348ec03d5dbcaedddfb87a2b2ef4aeb`
- Started: `2026-08-14T08:32:21Z`
- Finished: `2026-08-14T08:41:28Z`
- Duration: 9 minutes 7 seconds
- Author interventions: none
- Repository modifications: none; final `git status --short` was empty.
- Quarantine attestation: earlier `*-cold-review.md`, `*-blind-review.md`, and `*-invalid-review.md` paths were seen only in listings/diffs. Their contents were never opened, read, or searched.

Discovery trail:

1. Read root `AGENTS.md`, `README.md`, and the repository `decisions` and `cold-read` procedures.
2. Discovered current records through `docs/decisions/README.md`.
3. Followed the authority order through `v2/AGENTS.md` and `v2/VISION.md`.
4. Read the four current decision records and their supersession/trace sections.
5. Read only the three cited decision trajectories, never prior review records.
6. Followed normative owners through `docs/spec/README.md`, layer, history, Client, daemon, management, task, Router, Identity, and enforcement specifications.
7. Searched current documentation and package instructions for stale Ledger/profile/Client contracts with quarantined records excluded.
8. Verified the resolved Nx graph using an external temporary cache: seven product projects plus the root workspace project, with the exact admitted dependency edges.
9. Compared package-scoped agent law with the implemented Client root and current documentation.
10. Used normal Git history to inspect the candidate’s architecture correction. The tip itself changes no ADR or normative spec; it updates `docs/architecture.mdx` and adds a quarantined prior-review artifact.

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

Verdict: **PASS**

The repository at this candidate makes a four-record packet current:

- `20260811-four-layer-endpoint-replicated-harness.md`, partially superseded: four layers, endpoint-replicated certified history, durability thresholds, catch-up, Router re-anchor, recursive institutions/governance, daemon topology, seven-package graph, and cutover.
- `20260812-harness-client-uses-conversation-id.md`: caller-minted `ConversationId`, `start`, current-conversation turns, content-only bound reply, and `void` completion after local certification.
- `20260813-client-protocol-and-attention.md`: exact private Client evidence, attention consumption, MCP/daemon/management representation, registration recovery, and the five Simulator removals.
- `20260813-simulator-link-faults-perturb-delivery.md`: an explicitly activated, private post-Router Simulator fault scope may perturb recipient delivery while the inactive path remains byte/order preserving.

Together they resolve the excessive eight-layer design, central-Ledger dependency, profile/split-daemon machinery, ambiguous Client boundary, incompatible Simulator contracts, and tension between directed-link fault testing and Router ordering.

Binding material is:

- root/scoped agent law and `v2/VISION.md`;
- current ADR `Decision Outcome` text and explicitly current `Supersession` scope;
- normative `docs/spec/` chapters.

ADR context, considered alternatives, consequences, implementation examples, historical bodies of superseded records, `docs/architecture/`, and decision trajectories are explanatory or historical. The trajectories explicitly disclaim normative authority.

The tip commit itself does not admit a new decision. Its `docs/architecture.mdx` change correctly replaces stale “four choices are still pending” prose with the already-admitted closed Client boundary.

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

Verdict: **FAIL — the intended answer is discoverable, but one retained-scope statement is inconsistent.**

Replaced:

- Eight layers and two trust regions become Identity, Communication, Tasks/norms, and Personal trust.
- Privileged monitoring, institution, credential, and governance layers become ordinary agents and protocols.
- Central Ledger/Transcript storage, `LedgerOffset`, author-only append, and immediate all-member readability become independently stored endpoint histories with separate action and durability certificates.
- Permanent post-Router-restart fencing becomes verified catch-up and threshold re-anchor.
- Named profiles, profile files/selectors, split MCP paths, CLI/socket machinery, and dual backings become one explicitly configured state directory and one `/mcp`.
- Six `v2/*` packages, product Ledger/testbed owners, protocol/server packages, and compatibility aliases become seven final `packages/*` products.
- Public transaction/proof machinery, universal context/checkpoints, generic send, and proof-shaped success become `ConversationId`, current-action turns, bound reply, `void` completion, and MCP-only management.
- Simulator content-free open, generic send, message-only receive/results, runtime network authority, and persisted Router-order evidence are removals.
- Active directed Simulator faults may perturb delivery only after Router ordering.

Retained or left untouched:

- Correct, non-equivocating Registry and Router assumptions.
- Immutable AgentCards, Identity authentication, exact L1 representations, Registry admission, and deep Effect capabilities.
- Router opacity, volatile private global order, retry semantics, polling, and exact L2 representations.
- OpenFloorV1 fixed membership, START/MULTICAST, unanimous action validity, BEGIN/ACK contention, and its 90-second TTL.
- Modern loopback MCP, official SDK boundary, sole listener, acknowledgment-first transient delivery, and local trust.
- Compatible Simulator facades, Kubernetes/Temporal execution, runtime-native gateways, and the distinct simulation `RunLedger`.

The normative chain is `AGENTS.md` and `v2/VISION.md`, then the four current ADRs, then `docs/spec/`, especially:

- `layer-interfaces.md`
- `conversation-history.md`
- `harness/client.md`
- `harness/daemon.md`
- `harness/ingress.md`
- `harness/output.md`
- `harness/tasks.md`
- `management.md`
- `identity.md`
- `router.md`
- `enforcement.md`

Lineage defect: `docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md → Supersession` still says that Client-owned presentation “checkpoints” remain current. The accepted `20260812` outcome and `20260811` trace rows `G1-DEC-634`, `G1-DEC-638`, and `G1-DEC-819` explicitly remove those checkpoints. Following the supersession chain reveals the intended no-checkpoint contract, but the visible retained scope of a partially superseded record remains contradictory.

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

Verdict: **PASS**

An implementer must:

- Maintain exactly seven products and the admitted dependency DAG.
- Run `moltzap-registry`, `moltzap-router`, and one `moltzapd` per local state directory; there is no Ledger process.
- Keep Router opaque and endpoint interpretation in Client.
- Use fixed 2–32-member conversations and at most 32,768 canonical content bytes, with no fragmentation.
- Use closed RFC 8785 Client values, domain-separated private hashes, stable inner self-addressed `SignedMessage` evidence, and replaceable all-member Router envelopes.
- Build START genesis from caller-minted `ConversationId`, canonical membership/content, and the Router instance learned through omitted-cursor poll.
- Preserve unanimous OpenFloor action certification separately from durability:
  - all members vote for `n < 4`;
  - otherwise `f = floor((n-1)/3)` and `n-f` votes complete durability.
- Stage durably before voting, allow any member to assemble completion evidence, maintain hash-linked local history, catch up fixed members, and threshold re-anchor after Router restart.
- Expose only structural `HarnessClient.start` and `turns`, plus creation/acquisition operations. Start and bound reply return `void` after local certified durability.
- Keep registration, status, search, history, and proof inspection MCP-only.
- Automatically contend only for an unconsumed remote-authored certified head while owning the active listener. Persist consumption before the turn frame.
- Preserve compatible Simulator behavior while applying the five admitted removals. Keep active fault interposition private and post-Router; inactive delivery preserves bytes and order.

It must avoid central Ledger/Transcript storage, profiles, CLI/socket compatibility, generic send, `TxnId`, public hashes/proofs/receipts, reply-by-id, universal context/checkpoints, `v2/*` executable packages, cross-package codec catalogs, privileged institutions, runtime Router authority, and compatibility shims.

Affected consumers are OpenClaw, NanoClaw, Simulator, and Evals. Their only runtime communication boundary is Client/MCP; Simulator alone may compose the public Identity, Router, and Client capabilities as system driver.

Assumptions:

- Registry and Router are correct and non-equivocating, though unavailable services may stop progress and Router may restart.
- Endpoints may be Byzantine.
- For `n >= 4`, replicated-storage safety assumes at most `f` Byzantine members and honest stage-before-sign/non-double-vote behavior.
- For `n < 4`, the replicated-storage guarantee assumes zero Byzantine members.
- Safety is timing-independent.
- New-action progress requires Router availability and every unanimous action signer; post-certification completion needs the durability threshold.
- Catch-up needs an honest reachable holder of required ancestry.
- No guarantee covers malicious/replicated Registry or Router, dynamic membership, encrypted history, disk-loss reconstruction, fairness, or continuing byte availability from Byzantine attestations.
- Identity/Router representation compatibility is preserved. The five Client/Simulator cuts are intentional breaks. npm remains main-owned until publication/release policy is admitted.

## 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

Verdict: **PASS**

All four current ADRs name **Tapan Chugh** as decision-maker.

The four-layer trajectory cites one Codex CLI session, `019fd899-779c-7e70-a8e4-338727b13e6c`.

Material human events include:

- `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d`: simplify the eight-layer design, remove the large Ledger/monitoring/revocable-credential layers, keep participant histories, and model institutions/governance recursively.
- The retained planning-UI exchanges under `Planning UI questions and selections`: simplify rather than replace semantics; initially choose five layers; choose trusted Router, fixed one-third storage threshold with all members below four, and any-member finalization; choose automatic catch-up; suggest merging former L2/L3; then select the final four layers and authority/spec before implementation.
- Later planning selections retain separate action/durability certificates, reject profiles and the old Client, select explicit process configuration, `@moltzap/client`, all-v1 cutover, final package names, frozen forward merges, PR #974 landing first, quorum re-anchor, long-lived cutover branch, and blocker-only PR cleanup.
- The first cutover-policy prompt records `aborted by user after 1.7s`; no selection is inferred.
- Assistant plan `msg_0fe7c1dd2e31cd97016a7b698cc8448193a837b65a5efb21f9`; user adoption `msg_019ff231-e57a-7323-a0a3-c98c9b10ff22`: “set this plan as your goal…”.
- `msg_019ff210-429e-7912-8d33-b80c7b409d53`: “enable” answers the preceding recommendation about the three ACG rules; “I don't think we have testbed anymore” is retained without strengthening it.
- Registry recovery sequence:
  - `msg_019ff259-becc-7400-9b3f-243c73c30dd4`: “I accept that” applies only to the immediately preceding activation-retry proposal.
  - `msg_019ff2a0-6576-7172-8c6b-e32415d4ede2`: changed recovery arguments should be a “failure.”
  - `msg_019ff2a1-23e6-7f90-b627-7df2faa176b6`: open the remaining Registry work as an issue and continue.
  - The ledger says the separate first recovery item was not answered.
- Reduced Client boundary:
  - Human messages `msg_019ff821-75f6-70c3-b36b-54f732ad8242`, `msg_019ff822-0a13-7130-9814-109109a0ab1b`, and `msg_019ff827-7b2a-7441-9f35-8b538e86add8` request further Client simplification and question `TxnId`.
  - Assistant exact-boundary proposal `msg_0fe7c1dd2e31cd97016a7cff8a2f50819397e84c52bd26d36c`.
  - Human acceptance `msg_019ff852-c742-7480-b464-fdae2792c6ad`: “accept the reduced boundary.”
  - Later human messages say “don't repeat reviews” and “we accept the changes.”

The Client-protocol trajectory cites:

- Request/result `fc_0fe7c1dd2e31cd97016a7d4fa1be4c819397c851716801b843` / `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0`: nested `SignedMessage`; defer host memory and let evals fail.
- Request/result `fc_0fe7c1dd2e31cd97016a7d515b37bc8193a752005aaf28d092` / `fco_019ff989-86d8-7d83-92c1-16da24457d21`: initially “Every action.”
- Human correction `msg_019ff989-fa2d-76f0-8d83-7b09f663643a`: “actually fine to not content again”; the following assistant event states the no-self-contention interpretation.
- Human `msg_019ff993-e348-7272-9e3c-f5ddce9d116e`: “look at the 4 layer plan now.”
- Assistant complete plan `msg_0fe7c1dd2e31cd97016a7d58c392bc8193bef23bb36ab9fc93`.
- Human `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36`: “Implement the plan.”

The Simulator trajectory cites:

- Assistant options in `msg_0fe7c1dd2e31cd97016a7dd586aa0c819380b891ef21a26512`.
- Human messages `msg_019ffc35-0352-7773-8385-27cd5007f44a` and `msg_019ffc35-0365-7dc3-bede-dd08ccfb4e38`: “I think life-level ordering is fine…” and “that's the point of testing right.”
- Assistant `msg_0fe7c1dd2e31cd97016a7e01710a1c8193b46e90aaf91bdc8e` records the interpretation of “life-level” as “link-level” and the resulting post-Router fault boundary. The ledger does not turn this assistant interpretation into a separate human event.

Explicit source gaps and omissions:

- Session metadata does not identify the human using the session.
- Session metadata lacks native message ID, enclosing turn, parent locator, and actor role.
- Planning function calls/results lack actor roles and parent locators.
- Public messages have enclosing turns but no parent-message/parent-turn locators.
- System/developer instructions, hidden reasoning, private research, unrelated tool/status material, and repeated summaries are omitted as stated.
- The initial use of “ledger” is ambiguous and does not select the record type, threshold, API, or disclosure protocol.
- The adopted plan is an assistant proposal followed by a human instruction to use it; it is not itself an ADR admission.
- Registry recovery item 1 was left unanswered and deferred in that exchange.
- The Client source does not separately state motives, confidence, urgency, every protocol field, table, error literal, or environment key.
- The Simulator source preserves the literal `life-level` wording. No human event selects the private interposition transport, authentication, port, deployment object, or wire representation.

## 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

Verdict: **FAIL**

Two blockers remain.

1. Broken ADR lineage

   `docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md → Supersession` explicitly retains Client presentation checkpoints. Current accepted authority removes them:

   - `20260812-harness-client-uses-conversation-id.md → Decision Outcome`
   - `20260811-four-layer-endpoint-replicated-harness.md → G1-DEC-634`, `G1-DEC-638`, and `G1-DEC-819`
   - `docs/spec/harness/client.md → Public values` and `Public boundary`

   The `20260728 → 20260811 → 20260812` supersession chain resolves intended implementation behavior to “no presentation checkpoints,” but it does not make the earlier record’s visible retained-scope statement internally correct. Because the index defines explicitly retained portions of partially superseded records as current, this is a lineage defect.

2. Stale scoped agent law

   `packages/client/AGENTS.md → Current cutover boundary` says the source is transitional v1 rewrite input and directs agents to replace it, relocate Identity/Router, and implement the accepted shell. But:

   - `packages/client/src/README.md → Client source boundary` says this tree implements the endpoint-owned final boundary;
   - the Client public barrel exposes the admitted reduced contract;
   - root `README.md → Cutover status` and `docs/introduction.mdx → Current cutover status` say registration, recovery, daemon, and real acceptance are implemented;
   - the resolved Nx graph already has the exact final package dependencies.

   The OpenClaw and NanoClaw scoped instructions contain similar “current source is transitional; rebuild it” directions. These are scoped agent law, not safely marked historical orientation. Root `AGENTS.md` says conflicts among scoped instructions and the constitution stop work rather than being silently overridden. Therefore the authority order cannot safely dismiss them.

By contrast, `docs/architecture/harness-implementation-slate.md` contains extensive old profile/Ledger/TxnId/checkpoint instructions, but its top-level status explicitly says “historical implementation handoff; non-normative and superseded” and points to current owners. That apparent contradiction is properly resolved by authority and is not a blocker.

## 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Verdict: **FAIL**

The semantic protocol is detailed enough to implement without chat: public types, closed evidence values, hashes, thresholds, attention rules, management DTOs, error mappings, daemon inputs, persistence boundary, package DAG, Simulator cuts, and acceptance criteria all have named normative owners.

Deliberate deferrals are clearly identifiable:

- Publication membership, coordinated versus independent versions, release ordering, and deployment cutover.
- Dynamic membership, pruning/GC/retention, physical-storage policy, and recovery after local disk loss.
- Router replication, failover, Byzantine sequencing/fork tolerance, malicious Registry tolerance, identity rotation/recovery, delegation, and peer-card custody.
- End-to-end encryption/key distribution, public observers, non-member audit/disclosure, and cross-history conventions.
- Larger resource profiles, fragmentation, binary/media actions, and alternate page sizes.
- Non-unanimous action certificates, richer norms/actions, addressed turns, fairness, pass/abort/renewal/takeover, disputes, witnesses, signature compression, dynamic task tools, and plural-action payload mapping.
- Cross-process reply recovery, delivery acknowledgment/replay, resumable subscriptions, alternate push/cursors, async handles, and dynamic MCP tools.
- Daemon-wide concurrency, queues, byte budgets, overload policy, remote administration, hostile-host/local-auth extensions, dynamic ports/attachment, universal supervision, and global duplicate-directory/key detection.
- Host-native cross-conversation memory; six eval cases may fail without it.
- Institution discovery, claim/revocation vocabularies, appeals, governance protocols, selective disclosure, and portable trust policy.
- Alternate catch-up transport and the exact evidence-outbox mechanism.
- Compatibility treatment for external consumers.

Private database tables, interposition transport, worker layout, and similar mechanisms are implementation latitude constrained by observable guarantees, not missing product choices.

Accidental gaps:

- The contradictory checkpoint retention in the partially superseded daemon ADR.
- Stale scoped package-agent instructions that still direct teammates to rebuild already-final Client and adapter implementations.

Because these accidental same-tier instruction/lineage defects force a teammate to choose which current authority to ignore, implementation cannot proceed under the repository’s own stop rule without reconciliation.

## Blockers and overall result

- Blocker 1: reconcile the checkpoint statement in the partially superseded daemon ADR with the accepted no-checkpoint Client outcome and its lineage.
- Blocker 2: update scoped package agent law to distinguish completed final code from any genuinely remaining migration input.

**Overall result: FAIL.** A new candidate and different fresh reviewer are required after semantic authority or lineage changes. A maintainer, not this report, determines acceptance.
