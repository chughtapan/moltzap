# Harness MCP and dispatch blind teammate review

## Candidate and isolation record

- Candidate commit: `5051cdd246dede3d9a4dde3888b2437811ed6eb5`.
- Candidate tree: `423d23e289294fb1d940bc8874b791dcebd2dac9`.
- Repository root supplied to reviewer:
  `/home/tapanc/moltzap-harness-adr`.
- Reviewer identity: fresh Codex agent
  `/root/harness_cold_review_5051cdd2`.
- Review started: `2026-08-01T20:44:04Z`.
- Review completed: `2026-08-01T20:48:30Z`.
- Duration: 4 minutes 26 seconds.
- Isolation: the reviewer was spawned with no inherited turns and received only
  the candidate repository root and fixed six-question prompt below.
- Author interventions: none.
- Quarantined inputs: the reviewer attests that no `*-cold-review.md` or
  invalid-review record content was opened, read, or searched. Filenames were
  seen only in an initial repository path listing.
- Overall reviewer result: **PASS**.
- Maintainer acceptance: pending. Reviewer prose is not self-certifying.

## Exact prompt

Candidate repository root: /home/tapanc/moltzap-harness-adr

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

## Unedited reviewer response

Candidate: `5051cdd246dede3d9a4dde3888b2437811ed6eb5`
Tree: `423d23e289294fb1d940bc8874b791dcebd2dac9`
Overall result: **PASS**

### 1. Current decision

**PASS — accurate and discoverable.**

The candidate makes four related decisions current:

1. Harness is the endpoint’s interpretive subsystem. One `moltzapd` owns one named profile slot and one loopback listener, serving registration at `/register/mcp` and active operations at `/mcp`.
2. `HarnessClient` is the sole adapter-facing Effect capability. It owns runtime context projection, stable local presentation checkpoints, and turn-bound replies.
3. Inbound content and reply authority are independent facts. Content can update context without invoking a model; only a live grant produces a replyable runtime turn.
4. Model output is either conversation start with initial content or the current turn’s `reply(payload)` closure. Generic established-conversation send is absent.

This resolves the split CLI/daemon boundary, backing details leaking into OpenClaw and NanoClaw, daemon-owned versus client-owned context, content being inseparable from grants, and generic send bypassing live reply authority.

Binding authority is the accepted ADR `Decision Outcome` text, then the normative specifications:

- `docs/spec/harness/daemon.md`
- `docs/spec/harness/client.md`
- `docs/spec/harness/ingress.md`
- `docs/spec/harness/output.md`
- `docs/spec/management.md`

The ADR context, considered options, and historical consequences explain the decision but do not override the outcomes. `docs/architecture/harness-implementation-slate.md` is explicitly non-normative. The trajectory is source evidence only and explicitly says it creates no architecture decision.

### 2. Supersession and normative ownership

**PASS — lineage is explicit and consistent.**

The candidate replaces:

- `endpoint`, `@moltzap/v2-endpoint`, `moltzap-agentd`, and the bespoke CLI with `harness`, `@moltzap/v2-harness`, and `moltzapd`;
- the old separate CLI/local-route presentation with one listener and two MCP paths;
- `EndpointProfileRef` as the simulator/runtime handoff with `HarnessClient`;
- daemon attention watermarks as the runtime-presentation boundary with client checkpoints;
- the indivisible content-plus-grant turn with independent content and authority facts;
- the runtime adapter’s raw reply fields with bound `reply(payload)`;
- the earlier shared-raw-wire direction with backing-specific raw MCP wires behind a structurally compatible client interface.

The supersession chain is recorded in the updated sections of:

- `20260721-physical-plane-split.md`
- `20260721-v2-lives-top-level.md`
- `20260724-firewall-two-directions.md`
- `20260726-the-engine-dispatches.md`
- `20260727-registration-is-out-of-band.md`
- `20260728-endpoint-daemon-speaks-modern-mcp.md`
- `20260728-model-surface-is-start-reply-listen.md`
- `20260728-simulator-is-the-system-driver.md`
- `20260728-six-deep-packages-one-version.md`
- `20260728-gate-1-architecture-freeze.md`

It retains the official MCP SDK and pinned revision, loopback Streamable HTTP framing, sole-listener and acknowledgment-first subscription, `xyz.moltzap/events-v1`, transient at-most-once raw delivery, raw watermarks, direct clean-slate OperationId START, `reply(TxnId, actionId, payload)`, ReplyFingerprint, grants, Ledger commitment, receipts, retry/reconciliation, Registry authority, SharedCore/OpenFloor mechanics, and consumer-specific supervision.

Current traceability is indexed as G1-DEC-635 through G1-DEC-642 in the architecture freeze. Production adoption and send removal remain `main`-owned; this candidate governs the clean-slate v2 contract.

### 3. Implementation obligations and assumptions

**PASS — obligations, prohibitions, affected consumers, and assumptions are discoverable.**

An implementer must:

- rename the clean-slate package and daemon to Harness/`moltzapd`;
- run one daemon per named profile slot with one fixed loopback listener;
- expose `register` at `/register/mcp`;
- expose active `status`, `search_agents`, `search_conversations`, `read_conversation`, `start_conversation`, raw `reply`, and `subscriptions/listen` at `/mcp` once their backing-owned contracts exist;
- keep Registry as registration authority;
- make OpenClaw and NanoClaw consume only `HarnessClient`;
- keep backing-specific MCP codecs and reply correlation private;
- label every observed content item with its source ConversationId;
- preserve later authority even if its content was already deduplicated;
- emit runtime turns only for live authority;
- persist stable per-target/source presentation checkpoints and advance them immediately before turn emission;
- rebuild context from search/history after restart without recreating grants;
- bind the original lease or TxnId/action authority into `reply(payload)`;
- preserve the existing clean-slate raw START/reply, Ledger, receipt, and recovery contracts.

An implementer must avoid:

- a public `Harness`, `HarnessApplication`, `HarnessBootstrap`, or `HarnessManagement` service;
- bespoke CLI, Unix RPC socket, stdio bridge, second MCP process, FastMCP, generic send, or compatibility send alias;
- runtime backing detection, protocol proxying, shared production implementation, or v2 imports from `packages/*`;
- exposing lease, TxnId, actionId, reply token, ConversationId-as-authority, or backing-generation fields to adapters;
- inventing search DTOs, content-only wire methods, payload/action mapping, errors, limits, checkpoint formats, or recovery behavior that has no admitted owner.

The directly affected package is Harness, spanning endpoint interpretation at L3/L4 and the local runtime/L5 attention boundary. Identity, Router, Ledger, and their L1/L2/storage representations remain unchanged. Consumers affected are OpenClaw, NanoClaw, simulator, testbed, generic MCP management tooling, and the separately owned production implementation on `main`.

Assumptions and guarantees:

- one correct non-equivocating Registry;
- one correct non-equivocating Router;
- one correct durable Ledger;
- potentially Byzantine remote endpoints;
- trusted same-host MCP clients, with hostile-local-process defense deferred;
- service outage can stop progress but does not weaken committed-state safety;
- local crash/disconnect may lose transient grants or attention;
- checkpoint advancement before runtime receipt creates an accepted context-loss window;
- no delivery acknowledgment, replay, or restart reconstruction of reply authority;
- compatibility is structural and compile-time only after both branch-owned exact contracts are admitted;
- raw MCP wires may differ.

### 4. Decision-makers and provenance

**PASS — source events, alternatives, reversals, deferrals, and source gaps are explicitly distinguished.**

All four ADRs name **Tapan Chugh** as decision-maker.

The shared trajectory cites Codex CLI rollout session `019fba0c-9f1e-7911-9496-45b305a00cb5`. Each retained message records its native locator, enclosing turn, UTC timestamp, stored actor role, and absent parent locator.

Material calls include:

- official MCP SDK: option prompt followed by user `A` at `msg_019fba44-f4b7-7d01-ae51-72b67db93e26`;
- no FastMCP: user `C` at `msg_019fba4a-f475-7261-bdfc-3b8d7c97993f`;
- compile-time interoperability: `msg_019fba4d-d5b1-7fe3-a7bd-757b1c6c2af1`;
- separate registration MCP path and CLI removal: `msg_019fba2e-63df-73c0-af5b-d2016097d12e`;
- other CLI workflows become MCP tools: `msg_019fba32-28f6-79b2-bef8-c42d47b36b9f`;
- one server/daemon for both responsibilities: `msg_019fba99-8166-7972-9c7c-6419c6ed7e7e` and `msg_019fba9b-e490-75a0-b0a6-d5496e090c4d`;
- backing-native grants and converged clients: `msg_019fbaa3-7017-7fb1-bfb3-e1f829f685c9` and `msg_019fbaa4-0194-7173-892b-018f4c4cb2cb`;
- different raw wires, identical client interface: user “okay lets do A for now” at `msg_019fbb36-cbcc-7df2-9f56-0c75af07ca60`;
- independently owned implementations: `msg_019fbb66-804c-70f3-844a-5d0f056699a3`;
- Harness rename and final vocabulary: `msg_019fbba9-30b7-74f0-899c-73896c527e86`, `msg_019fbbae-51c3-7803-abfd-71b4c01c112b`, and approval at `msg_019fbbc8-8810-7670-a0ba-6a02d6b08e53`;
- client-owned cross-conversation context: `msg_019fba76-81b9-7481-a39f-2b50c544bcdd` and correction at `msg_019fbb68-fe7b-7103-a5d3-ac5ca1e8b626`;
- source ConversationId on notifications: `msg_019fbb70-7315-7b32-b6fd-f2df0c84426d`;
- restart reversal from empty state to local checkpoints/history rebuild: `msg_019fbb9d-03e4-7511-bfa1-1f273eb0865a` reversed by `msg_019fbb9d-59cc-7683-a137-4c9c8abe48c8`;
- checkpoint advancement immediately before emission: `msg_019fbb9e-4488-7573-a2ac-937b951dd411`;
- stable per-conversation checkpoint: `msg_019fbba1-47b7-7f22-9b2d-e30a36011bc5`;
- content-only notifications: `msg_019fbb9b-6c03-7840-a79c-efbebcfbe608`;
- same-conversation exclusion and `conversation_busy`: `msg_019fbb3e-d7cc-7322-9b78-97b290060a8b` and `msg_019fbb43-7396-7901-b59e-817d26e6d6cb`;
- local retry reversal: initial `C` at `msg_019fbb63-155b-7fc3-b84d-bad989c0bf72`, reversed to `A` at `msg_019fbb63-f985-79a1-abb2-3ce77adb2512`;
- transient at-most-once delivery retained: `msg_019fbaff-641a-7db0-81e3-e5119af5b3a0`;
- generic send removal: `msg_019fbaa1-1e06-7cb3-8011-92d5de109a9a` and `msg_019fbaa2-8c81-7f51-a106-7b92d66c1679`;
- narrowed stable-contract scope: approval at `msg_019fbeaf-8633-7e42-bf60-c9db136f911b`, followed by the instruction not to redesign existing mechanics and to treat the transcript as scope boundary.

Explicit reversals are preserved: atomic cutover/mega-PR became two slices; one shared raw extension became different wires; empty restart became history rebuild; drop-on-busy became local retry; public `turnId` was rejected; umbrella `Harness` service names were rejected.

Explicit source gaps include:

- source metadata does not identify the human account holder;
- no human acceptance of exact agent/conversation search projections or empty-query behavior;
- no answer selecting `Conversation` versus `ConversationId` results;
- no complete HarnessClient signatures or management schemas/errors;
- no clean-slate content-only event method/schema;
- no payload-to-action mapping for plural legal actions;
- no newly decided atomic START mechanics;
- no checkpoint storage algorithm, limits, overflow policy, lifecycle state machine, or exhaustive error taxonomy;
- the production credential mechanism after selected recoverability requirements remains qualified rather than fully selected.

### 5. Strongest apparent contradiction

**PASS — resolved by authority order; no blocker.**

The current working tree still contains:

- `v2/endpoint/package.json` named `@moltzap/v2-endpoint`;
- `v2/endpoint/bin/moltzap-agentd`;
- simulator/testbed dependencies on `@moltzap/v2-endpoint`.

That appears to contradict the current `harness` package and `moltzapd` outcome. It is implementation lag, not competing authority. `AGENTS.md`, `v2/VISION.md`, the accepted ADRs, and `docs/spec/layer-interfaces.md` govern. `docs/architecture/first-implementation.md` explicitly makes renaming `v2/endpoint` to `v2/harness` the first Gate 4 implementation slice. The candidate is the prerequisite contract change, so the stale scaffold is expected work and not a lineage blocker.

Historical ADR bodies still mention Endpoint, CLI, and older routes, but their visible supersession sections quarantine those statements and point to the current Harness owners.

### 6. Implementability and unresolved choices

**PASS — the decided skeleton is implementable without chat; explicitly deferred surfaces are not yet implementation-ready. No accidental gap found.**

Implementable now:

- package/process rename;
- one-slot, one-listener topology;
- path ownership;
- removal of obsolete public CLI/socket/send boundaries;
- preservation of retained clean-slate MCP and engine mechanics;
- branch/package isolation;
- semantic placement of HarnessClient, context, checkpoints, content/grant separation, and bound reply.

Deliberate deferrals or owner-blocked dependencies:

- exact HarnessClient Effect Tag, methods, stream/result/error signatures, and portable error union;
- final bidirectional type canary until both branch-owned contracts exist;
- register/status/search/history request/result schemas and errors;
- whether registration inputs come from daemon configuration or the local tool;
- status fields and lifecycle vocabulary;
- empty-query semantics;
- agent and conversation result projections;
- matching, ranking, ordering, cursor encoding/authentication, page defaults, and totals;
- clean-slate content-only notification method and schema;
- payload-to-action mapping where multiple clean-slate actions are legal;
- exact context-entry representation;
- history stable-position representation;
- checkpoint file/encoding/storage/cache/corruption/locking algorithm;
- queue, buffer, byte, snapshot, mailbox, and daemon-wide concurrency limits;
- overload and overflow behavior;
- portable reply receipt/error/retry policy beyond native backing behavior;
- local authentication, hostile-host defense, remote administration, replay, and resumable delivery;
- exact production registration credential mechanics and production migration, which remain `main`-owned.

These are consistently marked `Explicitly deferred`, “unassigned,” or “waits for owner.” Implementing those portions now would require guessing and is expressly prohibited. Their presence does not make the admitted boundary internally ambiguous.

Isolation attestation: fresh reviewer context; no inherited author discussion, summary, hints, or interventions. I did not open, read, or search the contents of any quarantined `*-cold-review.md` or invalid-review record. Their filenames appeared in an initial repository path listing only.

Discovery trail: `docs/decisions/README.md` → four 2026-08-01 ADRs → shared trajectory → normative Harness/management specs → `v2/VISION.md` → Gate 1 traceability inventory → superseded ADR sections → package/interface spec → implementation plan → current scaffold/package manifests.
