# Client protocol, attention, and daemon implementation trajectory

This non-normative ledger compacts the public exchange that selected the
remaining private Client representation, attention activation, daemon, and
Simulator cutover choices. It is evidence for human decisions, not design
authority.

## Source and omissions

- Source system: Codex TUI rollout JSONL (`originator: codex-tui`,
  `thread_source: user`).
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Source file at compaction time:
  `/home/tapanc/.codex/sessions/2026/08/06/rollout-2026-08-06T12-42-44-019fd899-779c-7e70-a8e4-338727b13e6c.jsonl`.
- The root session has no parent thread. ID-bearing public messages carry an
  enclosing `turn_id`; the source supplies no parent-message or parent-turn
  locator. Function-call records below likewise provide no parent locator.
- This ledger omits unrelated implementation status, tool output, hidden
  reasoning, and repeated summaries. The final-plan event below retains every
  substantive line; only its enclosing `<proposed_plan>` tags are omitted. No
  wording is normalized.

## Stable inner evidence and deferred cross-conversation memory

- Request locator:
  `fc_0fe7c1dd2e31cd97016a7d4fa1be4c819397c851716801b843`; UTC
  `2026-08-13T05:01:27.667Z`.
- Result locator: `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0`; UTC
  `2026-08-13T05:02:14.424Z`.
- Enclosing turn: `019ff969-5e2e-78b0-903f-2237aeae4010`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both function-call records.

Literal request arguments:

```json
{"questions":[{"header":"L3 signing","id":"l3_signing","question":"Which signing construction should the plan lock for Client-owned action, durability, and re-anchor evidence?","options":[{"label":"Nested SignedMessage (Recommended)","description":"Use a self-addressed inner SignedMessage as stable evidence and a separate all-member outer SignedMessage for transport, preserving Identity’s opaque signer boundary."},{"label":"Compact attestation API","description":"Add a new purpose-bound Identity signature artifact, yielding smaller certificates but superseding the accepted Identity public boundary."},{"label":"Fragmented evidence","description":"Keep only existing transport signatures but add fragmentation/reassembly, substantially increasing Gate 1 protocol complexity."}]},{"header":"Host memory","id":"host_memory_fallback","question":"If a runtime lacks a qualifying native cross-conversation memory facility, what should happen to its six cross-conversation eval cells?","options":[{"label":"Implement host integration (Recommended)","description":"Add/configure memory inside that host’s own integration layer; do not put context back into Client or Simulator."},{"label":"Mark unsupported","description":"Keep all 16 case definitions but skip unsupported runtime-condition cells with an explicit capability result."},{"label":"Adapter context cache","description":"Let the channel adapter cache and inject cross-conversation context, reversing part of the reduced-boundary decision."}]}]}
```

Literal result:

```json
{"answers":{"l3_signing":{"answers":["Nested SignedMessage (Recommended)"]},"host_memory_fallback":{"answers":["None of the above","user_note: just defer it now. let the evals fail"]}}}
```

## Attention selection and immediate correction

- Request locator:
  `fc_0fe7c1dd2e31cd97016a7d515b37bc8193a752005aaf28d092`; UTC
  `2026-08-13T05:08:47.345Z`.
- Result locator: `fco_019ff989-86d8-7d83-92c1-16da24457d21`; UTC
  `2026-08-13T05:12:47.576Z`.
- Enclosing turn: `019ff984-906f-7400-b6f3-9251a37c831b`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both function-call records.

Literal request arguments:

```json
{"questions":[{"header":"Attention","id":"attention_trigger","question":"Should the plan lock this ready-sink rule for automatic turn contention?","options":[{"label":"Remote action only (Recommended)","description":"A subscribed endpoint contends after a remotely authored certified action, preventing immediate self-follow-up loops."},{"label":"Every action","description":"A subscribed endpoint also contends after its own certified action, so the same agent may immediately win again."},{"label":"Defer trigger","description":"Build START/durability first and postpone live turns, adapters, and social eval restoration."}]}]}
```

Literal result:

```json
{"answers":{"attention_trigger":{"answers":["Every action"]}}}
```

The human immediately corrected that selection in a new turn:

- Message locator: `msg_019ff989-fa2d-76f0-8d83-7b09f663643a`.
- Enclosing turn: `019ff989-f8b5-7e30-b9ba-7806c5e72e3e`.
- Parent locator: absent.
- UTC: `2026-08-13T05:13:17.101Z`.
- Stored actor role: `user`.

Literal message:

> actually fine to not content again

The agent stated the interpretation that the later implementation plan used:

- Message locator:
  `msg_0fe7c1dd2e31cd97016a7d53f2c2f48193af0a0e94796ed417`.
- Enclosing turn: `019ff989-f8b5-7e30-b9ba-7806c5e72e3e`.
- Parent locator: absent.
- UTC: `2026-08-13T05:19:48.493Z`.
- Stored actor role: `assistant`.

Literal message:

> Got it: no self-recontention. An endpoint may contend after another member’s newly certified action, but not immediately after certifying its own action.
>
> I’m doing one read-only architecture reconciliation against the current v2 law—especially the Ledger boundary—then I’ll give you the concrete, decision-complete cutover plan. No extra review loop.

## Four-layer correction

- Message locator: `msg_019ff993-e348-7272-9e3c-f5ddce9d116e`.
- Enclosing turn: `019ff989-f8b5-7e30-b9ba-7806c5e72e3e`.
- Parent locator: absent.
- UTC: `2026-08-13T05:24:06.601Z`.
- Stored actor role: `user`.

Literal message:

> look at the 4 layer plan now

This correction excludes the older central-Ledger track from the plan below.

## Complete implementation plan and instruction

The agent presented the complete plan in one public final-answer message:

- Message locator:
  `msg_0fe7c1dd2e31cd97016a7d58c392bc8193bef23bb36ab9fc93`.
- Enclosing turn: `019ff989-f8b5-7e30-b9ba-7806c5e72e3e`.
- Parent locator: absent.
- UTC: `2026-08-13T05:41:01.581Z`.
- Stored actor role: `assistant`.

Literal message, with only the enclosing tags omitted:

> # Four-layer turn cutover
>
> ## Summary
>
> Build the missing endpoint layer in `@moltzap/client`: replicated conversation history, Router protocol engine, `moltzapd`, and the server half of the existing turn subscription.
>
> The current `HarnessClient` remains unchanged. Today its MCP subscription client exists, but no in-repo daemon produces turns.
>
> Final graph:
>
> ```text
> Identity ← Router
>     ↑        ↑
>     └── Client/moltzapd
>              ↑
>       OpenClaw / NanoClaw
>              ↑
>           Simulator
>              ↑
>             Evals
> ```
>
> No product Ledger, Protocol package, server-core, generic send, public hashes, or TxnId returns.
>
> ## Protocol and attention contract
>
> - Admit one narrow four-layer decision covering the missing private representation and attention activation rules. Update the owning specs and trace, then perform the single mandatory blind review—no additional design-review cycle.
> - Encode versioned Client evidence with canonical JSON and SHA-256 domain-separated hashes. Use Identity `SignedMessage` for stable inner attestations, wrapped in replaceable outer Router messages so `retry_identity_unknown` can re-envelope unchanged evidence.
> - Bind START to an initial Router anchor obtained from the omitted-cursor poll. Later Router instances require threshold-certified re-anchor evidence.
> - Limit Gate 1 to 32 fixed members and 32 KiB canonical content, with no fragmentation. Derived-size tests must prove every Router artifact remains below its existing limit.
> - Keep action certification unanimous and durability independent: all members for groups below four; otherwise `n-f`, where `f=floor((n-1)/3)`.
> - A locally certified remote-authored head becomes contention-eligible only while the endpoint has the active subscription. The action author never contends on its own action.
> - Every subscribed non-author may emit one BEGIN. Router order selects the winner; unanimous ACK creates the volatile 90-second reply grant.
> - Persist a private `(ConversationId, RecordHash)` consumed marker immediately before writing the turn frame. That endpoint never offers or bids for that head again—even after an ambiguous write or restart. Unconsumed losers may contend after round expiry.
> - No listener means no bid and no consumed marker. Catch-up, history, staged evidence, vote enrichment, and re-anchor never produce turns.
>
> ## Implementation
>
> 1. **Client representation and durable store**
>    - Add private schemas for membership, anchors, START, BEGIN/ACK, MULTICAST, action certificates, durability evidence, certified records, catch-up, and re-anchor.
>    - Add a SQLite/WAL endpoint store inside each state directory. Persist identity, canonical START intents, fixed membership/cards, anchor chain, staged records, votes, certified history/head, and consumed-attention markers.
>    - Make stage-before-vote and certified promotion atomic. Retain complete history indefinitely. Keep Router cursor, grants, subscriptions, and folds volatile.
>
> 2. **Endpoint protocol engine**
>    - Resolve and pin complete AgentCards before START traffic.
>    - Persist caller-minted `ConversationId` intent before sending. Identical retries resume; changed peers/content conflict.
>    - Verify every polled Router batch before advancing its volatile cursor.
>    - Serialize state transitions per conversation while allowing independent conversations to progress concurrently.
>    - Implement duplicate evidence handling, outer-message retry, feed-gap catch-up, restart recovery, and quorum re-anchor.
>
> 3. **Real turn subscription and bound reply**
>    - Preserve the public `HarnessClient.start` and `HarnessClient.turns` signatures exactly.
>    - Keep one scoped MCP connection and one active `subscriptions/listen`.
>    - Acknowledge the subscription before emitting notifications; reject racing listeners with `subscription-in-use`.
>    - Emit one event containing `conversationId`, verified author/card set, semantic content, and a random 256-bit opaque reply grant.
>    - Bound `reply(content)` consumes that live grant, certifies one MULTICAST, waits for local durable certification, and returns `void`.
>    - Validate the core two-agent flow: A starts, only B receives the turn; B replies, only A receives the resulting turn.
>
> 4. **`moltzapd` process and MCP catalog**
>    - Add a Client-owned server export and `moltzapd` binary configured by explicit state directory, Registry origin/JWK, Router origin, signing/admission files, and fixed loopback MCP port.
>    - Pre-registration tools: `register` and `status`. Registration accepts `operationId`, `principalId`, and `agentName`; the daemon supplies its configured public key, admission credential, and signing authority.
>    - Active tools remain exactly the specified six. `search_agents` directly projects Registry lookup/list. `search_conversations` enumerates local histories in ConversationId order, 50 per page. `read_conversation` returns a 50-record certified snapshot from genesis or a supplied RecordHash, using an opaque snapshot continuation.
>    - Supervise shutdown in dependency order: stop MCP intake, quiesce delivery/protocol work, close Router/Registry clients, then close SQLite.
>
> 5. **Simulator and consumers**
>    - Run one Registry and one Router per simulation run.
>    - Run `moltzapd` as a restartable sidecar in every agent Pod, with a per-agent PVC and private key/admission mounts. Register through an init step before starting the application.
>    - Give the application only `MOLTZAP_MCP_URL=http://127.0.0.1:<port>/mcp`; never expose Router/Registry origins, signing material, or state paths.
>    - Keep OpenClaw and NanoClaw on the structural `HarnessClient` boundary and replace their injected fakes with real-daemon acceptance tests.
>    - Restore all 16 historical eval definitions through public HarnessClient behavior. Cross-conversation cases run honestly and may fail behaviorally; do not restore automatic cross-conversation context.
>
> ## Test plan
>
> - Golden and rejection vectors for canonical evidence, hashes, signatures, signer sets, domain separation, and Router-size limits.
> - Atomic-store crash tests after intent, staging, each vote, promotion, and consumed-marker commit.
> - Two-, three-, four-, and seven-member certification/quorum tests, including Byzantine, duplicate, conflicting, and author-failure cases.
> - Real Router tests for retries, re-envelope, duplicate polls, feed gaps, restart, catch-up, and re-anchor.
> - Subscription tests for acknowledgment ordering, sole ownership, disconnect loss, no replay, no self-contention, group winner selection, TTL retry, and consumed-head restart behavior.
> - Two- and three-daemon START → turn → bound reply flows using real Registry and Router processes.
> - Real-daemon OpenClaw/NanoClaw tests and Simulator Pod tests for loopback isolation, PVC recovery, secret isolation, readiness, resource accounting, and cleanup.
> - Nx build, typecheck, focused tests, architecture checks, docs checks, and final package-graph/absence assertions.
>
> ## Assumptions
>
> - Target the accepted four-layer cutover branch, not the older eight-layer/Ledger branch.
> - The public `HarnessClient` boundary is frozen.
> - SQLite is private Client machinery, not a product storage layer.
> - One legal OpenFloor reply action is supported; plural-action mapping and cross-process reply recovery remain deferred.
> - Management schemas above are admitted with the protocol decision but implemented after the communication vertical, before `moltzapd` is declared complete.

The human then instructed implementation:

- Message locator: `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36`.
- Enclosing turn: `019ff9a4-2966-7860-aa43-3a15b49343e8`.
- Parent locator: absent.
- UTC: `2026-08-13T05:41:53.563Z`.
- Stored actor role: `user`.

Literal message:

> Implement the plan.

The source does not separately state motives, confidence, urgency, or a reason
for each implementation mechanism. It also does not spell out every protocol
field name, database table, error literal, or environment-variable name later
needed to make the accepted plan executable; those are repository-owned
specification and implementation details, not separately attributed human
selections. This ledger records none.
