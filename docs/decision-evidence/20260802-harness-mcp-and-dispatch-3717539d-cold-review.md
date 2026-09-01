# Harness MCP and dispatch blind teammate review

## Candidate identity

- Candidate repository root: `/home/tapanc/moltzap-harness-adr`
- Candidate commit: `3717539d2b0499fa31a20a9f686770b874d0b2b4`
- Candidate tree: `6d80d689ec4bb8250fd8ddc6d6e28265ddb72518`
- Candidate branch as observed: `agent/harness-adr`, one commit ahead of
  `origin/agent/harness-adr`
- Candidate subject: `WIP: reconcile Harness authority references`
- Worktree at answer freeze: clean
- Review started: `2026-08-02T00:21:08Z`
- Answers frozen: `2026-08-02T00:28:09Z`
- Duration: 7 minutes 1 second

## Exact prompt

> 1. What decision does this candidate make current, what problem does it
> resolve, and which statements are binding versus context or
> non-normative explanation?
> 2. What earlier outcomes does it replace, retain, or leave untouched,
> and where does the current normative contract live?
> 3. What must an implementer now do or avoid, which layers or consumers
> are affected, and under what fault, trust, safety, liveness, and
> compatibility assumptions?
> 4. Which humans are named as decision-makers, which source events does
> the compacted trajectory cite for their calls, alternatives,
> reversals, and deferrals, and what source gaps does it explicitly
> record? Report only what the event ledger states; do not infer
> motives, confidence, urgency, or rationale.
> 5. Find the strongest apparent contradiction, stale instruction, or
> broken lineage elsewhere in the repository. Resolve it using the
> authority order or report it as a blocker.
> 6. Could a teammate implement the decision without chat or guessing?
> List every missing link or unresolved choice and classify each as a
> deliberate deferral or an accidental gap.

## Reviewer identity and isolation attestation

Reviewer: Codex isolated teammate-review agent `/root/adr_blind_review`.

I did not author or reconcile this candidate. I received only the candidate
repository root and the six fixed questions above. I received no inherited
conversation, compaction, memory, private state, design summary, diff tour,
ADR or file pointer, search term, expected answer, out-of-band index, earlier
blind-review output, or author help. I independently discovered the decision
index, candidate history, relevant ADRs, provenance, normative owners, and
implementation files through normal repository navigation.

I did not open, read, or search the contents of any earlier `*-cold-review.md`
or invalid-review record. A directory listing exposed quarantined artifact
filenames, which the gate permits. Repository history exposed the subject of a
commit that records a prior Harness review, but no command returned an answer
or verdict from that artifact. I did not inspect that commit or artifact.

No author intervention occurred. I asked the author no questions and received
no coaching, correction, hint, or out-of-band material during the run.

## Independently discovered paths and headings

- `AGENTS.md` — Project; Constitution; Architecture decision records; Blind
  teammate review gate; Docs
- `docs/decisions/README.md` — Canonical reading guidance; Records
- `v2/AGENTS.md` — Authority and reading order; Structure; Implementation
  rules; Simulator provenance gate
- `v2/VISION.md` — Authority; The constitution; Gate 1 profile; Local runtime
  surface; Open-question register
- `docs/decisions/20260801-harness-is-one-profile-slot-daemon.md` — Decision
  Outcome; Consequences
- `docs/decisions/20260801-harness-client-owns-runtime-context.md` — Decision
  Outcome; Consequences
- `docs/decisions/20260801-inbound-notifications-separate-content-from-grants.md`
  — Decision Outcome; Consequences
- `docs/decisions/20260801-model-output-is-start-or-bound-reply.md` — Decision
  Outcome; Consequences
- `docs/decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md` —
  Source record and compaction method; the four decision headings; Source
  gaps, inherited mechanics, and excluded candidate detail
- `docs/decisions/20260728-gate-1-architecture-freeze.md` — Supersession;
  Normative owner; Gate 1 traceability inventory; Harness daemon, client,
  model surface, and MCP; Packages, implementation substrate, and simulator;
  Explicit deferrals
- `docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md` —
  Supersession; Decision Outcome
- `docs/decisions/20260728-model-surface-is-start-reply-listen.md` —
  Supersession; Decision Outcome
- `docs/decisions/20260728-six-deep-packages-one-version.md` — Supersession;
  Decision Outcome
- `docs/decisions/20260728-simulator-is-the-system-driver.md` — Supersession;
  Decision Outcome
- `docs/decisions/20260726-the-engine-dispatches.md` — Supersession; Decision
  Outcome
- `docs/decisions/20260724-firewall-two-directions.md` — Supersession;
  Decision Outcome
- `docs/decisions/20260727-registration-is-out-of-band.md` — Supersession
- `docs/spec/README.md` — Authority and reading order; Implementation
  readiness; Implementation decision ownership
- `docs/spec/harness/daemon.md` — Purpose and ownership; Profile and process;
  Retained clean-slate engine mechanics; MCP transport; Paths and tools;
  Fault and trust assumptions; Explicitly deferred
- `docs/spec/harness/client.md` — Purpose and compatibility boundary; Consumer
  port; Listen and bound reply; Context ownership; Local presentation
  checkpoints; Explicitly deferred
- `docs/spec/harness/ingress.md` — Content and reply authority;
  Same-conversation exclusion; Delivery law; Explicitly deferred
- `docs/spec/harness/output.md` — Conversation start;
  Established-conversation reply; Generic send removal; Explicitly deferred
- `docs/spec/management.md` — Registration and status; Search; Conversation
  history; Explicitly deferred
- `docs/spec/layer-interfaces.md` — Package graph; Type ownership; Harness;
  Simulator and testbed; Harness daemon and client; StackProvider; Trust,
  safety, and progress; Harness inbound context and reply authority
- `docs/architecture/harness-implementation-slate.md` — Outcome; Scope rule;
  Local MCP and management; HarnessClient boundary; two runtime slices;
  Delivery order
- `docs/architecture/first-implementation.md` — Non-negotiable boundaries;
  Gate 4 — Harness implementation boundary
- `docs/architecture/components.md` — Runtime topology; Six deep packages;
  Product state and simulation evidence are different
- `v2/inputs/simulator-handoff-20260728.md` — Adapt for v2
- `v2/simulator/src/adapter.ts` — runtime-subject adapter file comment

## Discovery trail

1. Confirmed the supplied repository root, UTC start time, clean worktree,
   branch, and candidate commit, then read root `AGENTS.md` in full.
2. Listed the repository only to discover its top-level structure, found and
   read the human-maintained decision index, and identified the four accepted
   2026-08-01 Harness records from that index.
3. Used repository history after that independent discovery to bind the exact
   candidate and list its three touched paths. No prior review content was
   opened.
4. Read `v2/AGENTS.md` and all of `v2/VISION.md` before relying on lower v2
   sources.
5. Read the four accepted Harness ADRs, followed every provenance link, and
   read the complete 2,614-line compacted trajectory.
6. Read the Harness and management normative chapters, `docs/spec/README.md`,
   the relevant `layer-interfaces.md` ownership and cross-layer sections, and
   the current traceability rows in the architecture freeze.
7. Read every earlier ADR whose visible Supersession section is named by the
   new records or decision index, then checked the current package, runtime,
   simulator, and branch handoffs in architecture and source files.
8. Searched current law, specifications, architecture pages, and v2 source for
   stale Endpoint/CLI/send/profile-reference vocabulary while excluding
   quarantined review contents and historical drafts from authority.
9. Independently inspected the candidate diff only after reconstructing the
   current authority set. It reconciles local registration in trace row
   `G1-DEC-209` and replaces the stale simulator `EndpointProfileRef` handoff
   with `HarnessClient` in both the source handoff and adapter comment.
10. Ran the checked-in broken-link and formatting checks and `git diff
    --check`; all passed.

## Unedited answers

### 1. Current decision, problem, and authority classification

The candidate makes a four-part Harness boundary current for the clean-slate
v2 track:

1. `Harness` is the endpoint-local interpretive subsystem and `v2/harness`
   deep package, not a public Effect service. One `moltzapd` owns one named
   local profile slot. The slot exists before registration and represents
   exactly one AgentId after Registry commit. One fixed loopback listener
   serves registration at `/register/mcp` and registered operations at `/mcp`.
   Registry retains admission authority. Generic MCP tools replace the bespoke
   MoltZap CLI, Unix RPC socket, stdio bridge, second MCP process, and generic
   send surface. Each build statically composes one backing; it does not
   discover or select a backing at runtime.
2. `HarnessClient` is the sole runtime-adapter-facing Effect capability. It
   presents conversation start and one scoped listen stream whose turns carry
   a bound `reply(payload)` closure. It owns current- and cross-conversation
   context plus stable local presentation checkpoints. OpenClaw and NanoClaw
   do not consume raw backing messages or construct daemon/protocol services.
3. Inbound content and reply authority are independent facts. Every observed
   content item is labelled by its source ConversationId. Content without a
   grant updates context but does not invoke the model; a later grant is not
   discarded merely because its content was already seen. ConversationId
   groups context but is not reply authority. The clean-slate backing retains
   its existing per-conversation grant serialization and at most one live
   reply authority per ConversationId.
4. Portable model output is only conversation start with initial content or
   the live turn's bound payload reply. There is no generic write into an
   established conversation. The portable closure hides TxnId, actionId,
   dispatch lease, reply token, ConversationId correlation, and backing
   generation. The clean-slate raw call remains
   `reply(TxnId, actionId, payload)` with its existing ReplyFingerprint,
   validation, Ledger result, receipt, retry, reconciliation, and errors.

The problem resolved is the incompatible local/runtime boundary between the
production and clean-slate backings: adapters otherwise have to know raw MCP,
dispatch-lease versus TxnId/action mechanics, daemon-side versus runtime-side
context state, and separate CLI/control transports. The decision establishes
one semantic client boundary and one local process shape without falsely
standardizing the backings' wire or protocol internals.

Binding statements are the root agent law and `v2/VISION.md`, then the
`Decision Outcome` of each accepted 2026-08-01 ADR and the explicitly retained
scope in partially-superseded ADR `Supersession` sections, followed by the
normative `docs/spec/` chapters. The freeze's current trace rows are the
repository-native decision-to-owner inventory. ADR Context, Considered
Options, historical bodies outside retained scope, and Consequences are
explanation and effects, not competing contract text. The compacted trajectory
is non-normative evidence. `docs/architecture/harness-implementation-slate.md`
is explicitly non-normative ordering guidance, architecture pages are
orientation/execution material, and `v2/inputs/` is evidence. Chat, issues,
drafts, and prior blind-review artifacts are not authority.

### 2. Replaced, retained, untouched, and current normative locations

Replaced outcomes:

- `endpoint`, `@moltzap/v2-endpoint`, `moltzap-agentd`, the bespoke CLI, and
  the old per-registered-AgentId-only process vocabulary are replaced by
  `harness`, `@moltzap/v2-harness`, one profile-slot `moltzapd`, and one MCP
  listener with separate registration and active paths.
- The fully superseded claim that registration is wholly out of band is
  replaced by Registry-owned HTTP bootstrap admission presented locally by
  `moltzapd`; admission authority does not move to Harness.
- A public `EndpointProfileRef` simulator/runtime handoff is replaced by the
  public `HarnessClient` capability. Runtime subjects no longer receive
  profile, daemon, transport, key, or platform internals.
- Daemon-owned runtime-context projection and the indivisible
  content-plus-grant turn are replaced by conversation-labelled observations,
  client-owned checkpoints/context, and independent grant admission.
- The adapter-facing raw `start_conversation`/`reply` projection is replaced
  by `HarnessClient.startConversation(...)` and a turn-bound
  `reply(payload)`. Generic established-conversation send remains absent and
  is explicitly removed from the production target rather than renamed.
- Public `EndpointRuntime`, `V1EndpointAdmin`, `Harness`,
  `HarnessApplication`, `HarnessBootstrap`, `HarnessManagement`, shared raw
  turn wire, and public `turnId` proposals are not current.

Retained outcomes:

- The pinned MCP `2026-07-28` core, official TypeScript SDK boundary, fixed
  loopback port, modern Streamable HTTP POST/SSE framing, Origin validation,
  exact discovery metadata, `xyz.moltzap/events-v1` grant extension, sole
  listener, acknowledgment-first order, listener-conflict errors, transient
  at-most-once delivery, raw pre-write watermarks, and consumer-specific
  supervision remain current.
- Clean-slate START retains stable OperationId, deterministic identifiers,
  atomic commit, durable result, and existing recovery. Raw reply retains
  `(TxnId, actionId, payload)`, its canonical fingerprint, exact accepted
  failures, completed receipt, Ledger reconciliation, and identical-retry or
  changed-input-conflict behavior.
- Registry, Router, Ledger, SharedCore, OpenFloorV1, certificate, persistence,
  restart fencing, grant, and L3/L4 semantics are untouched except for the
  explicitly changed local presentation boundary. No L1 or L2 representation
  changes.
- The simulator still owns `Simulator.define`, EventCatalog, runtime roster,
  RunLedger, and `StackProvider`; only the runtime capability handoff changed.
- Production implementation details and adoption remain owned on `main`; the
  v2 records state a common target but do not amend the production wire or
  recovery contract.

Current normative locations are:

- `docs/spec/harness/daemon.md` for one profile-slot `moltzapd`, paths,
  retained raw MCP, process, trust, and recovery;
- `docs/spec/harness/client.md` for the semantic consumer port, context,
  checkpoints, and bound replies;
- `docs/spec/harness/ingress.md` for content/grant separation,
  same-conversation exclusion, and transient delivery;
- `docs/spec/harness/output.md` for start, raw reply retention, portable reply,
  and generic-send absence;
- `docs/spec/management.md` for registration/status/search/history ownership,
  names, pagination, and representation blockers;
- `docs/spec/layer-interfaces.md` for package/type ownership, `HarnessClient`,
  `StackProvider`, trust laws, and the package DAG; and
- `docs/spec/harness/tasks.md` plus retained prior ADR scope for OpenFloor and
  raw action semantics.

The stable inventory is in architecture-freeze rows `G1-DEC-209`,
`G1-DEC-600` through `G1-DEC-642`, and `G1-DEC-700` through
`G1-DEC-720`, with explicit deferrals in the `G1-DEC-800` family.

### 3. Implementer obligations, affected layers/consumers, and assumptions

An implementer must:

- use exactly six v2 packages and the current `harness` package/binary names;
- run one `moltzapd` per named profile slot, bind its fixed nonzero port only
  on `127.0.0.1`, present `/register/mcp` and `/mcp` on one listener, and leave
  Registry as the registration authority;
- compose exactly one backing at build time through imports and Effect Layers;
- keep Registry, Router, Ledger, and each daemon independent, with Router and
  Ledger as siblings coordinated only by endpoint Harness code;
- retain the official MCP SDK and raw clean-slate discovery, subscription,
  grant, START, reply, receipt, Ledger, and recovery contracts;
- expose only `HarnessClient` to runtime adapters after its exact owner admits
  the service types, keep all backing correlation private, and eventually run
  the bidirectional positive type canary after both branch-owned exact
  contracts exist;
- label every content observation with ConversationId, treat content and
  authority independently, prevent content-only observations from invoking a
  model, and retain a later grant even when content was deduplicated;
- let `HarnessClient` group current/cross-conversation context, persist stable
  per-target/source presentation checkpoints, advance them immediately before
  runtime emission, and rebuild content from search/history without rebuilding
  authority;
- preserve at most one live clean-slate authority per ConversationId and
  preserve independent progress across conversations under the retained
  backing laws;
- expose portable conversation start and a turn-bound payload reply, while
  retaining raw clean-slate OperationId and
  `reply(TxnId, actionId, payload)` behavior below that projection; and
- omit generic established-conversation send from the clean-slate surface and
  treat complete production removal as separately `main`-owned work.

An implementer must avoid a public Harness service, CLI/socket/stdio/second
MCP process, runtime backing discovery, shared production implementation,
cross-track import, shared replacement raw event, public provider token,
ConversationId-as-authority, invented agent/conversation wrapper, invented
management wire, inferred plural-action mapping, replay/acknowledgment, or any
new queue, timeout, byte limit, retry, persistence, configuration, lifecycle,
or error contract not already owned.

Affected layers and consumers are primarily the endpoint Harness subsystem
across L3/L4 interpretation plus the local runtime boundary. L1 Registry gains
only the local Harness presentation of its existing bootstrap operation; its
network representation is unchanged. L2 Router remains opaque and unchanged.
L3 raw conversation, certificate, Ledger, and recovery laws remain intact.
L4 OpenFloor remains the action/grant owner and must later own the unresolved
plural-action mapping. OpenClaw, NanoClaw, simulator runtime subjects, generic
MCP management clients, and the `StackProvider` handoff consume the changed
boundary. Production consumers are a `main`-owned migration target.

Fault/trust/safety/liveness assumptions:

- Gate 1 assumes one correct non-equivocating Registry, one correct
  non-equivocating Router, one correct durable Ledger, trusted same-host MCP
  clients, and potentially Byzantine remote endpoints. A malicious or
  equivocating Registry and hostile local-process defense are outside the
  guarantee.
- Registry/Router/Ledger outage or a required member's unavailability may halt
  progress. Safety is timing-independent; timely OpenFloor progress requires
  all fixed members to observe and act within the 90-second TTL.
- Service outage or local crash cannot weaken committed-state safety or create
  reply authority, but transient attention or reply opportunity may be lost.
  A failed/ambiguous SSE write is at most once with no replay. A crash after a
  client checkpoint advances and before runtime receipt may lose presented
  context. History never recreates a grant.
- One honest required member may prevent invalid certification. If every
  required member signs an illegal proposal, semantic validity is outside the
  guarantee.
- Compatibility is semantic and compile-time only. Backings may have different
  MCP wires, Tags, Layers, errors, and recovery mechanics. There is no runtime
  generation detection, shared implementation package, protocol proxy, or v2
  import of production packages. V2 has no internal v1 compatibility
  obligation; production adoption remains `main`-owned until its exact
  contract is admitted.

### 4. Decision-maker, source events, alternatives, reversals, deferrals, and gaps

All four new ADR frontmatter blocks name one accountable human:
`Tapan Chugh`.

The trajectory does not establish that the session account is Tapan Chugh. Its
source metadata names Codex CLI session
`019fba0c-9f1e-7911-9496-45b305a00cb5`, but explicitly says the metadata does
not identify the human account holder. The ADR `decision-makers` field is the
accountability record, not proof that the session account authored every ADR
rationale.

The trajectory cites these material event groups:

- Topology and MCP-only local control: the initial MCP compatibility request
  (`msg_019fba1a-652a-7431-b15d-8a6ad99258c9`), per-AgentId daemon/MCP-only
  adapters (`msg_019fba20-fa77-7382-883d-eac56b1fbde6`), initial CLI-through-MCP
  request (`msg_019fba28-c685-7a62-95a8-9034bf601391`), separate registration
  path/removing the CLI (`msg_019fba2e-63df-73c0-af5b-d2016097d12e`), and all
  former CLI features as MCP tools
  (`msg_019fba32-28f6-79b2-bef8-c42d47b36b9f`).
- MCP implementation alternatives: assistant D5 offered official SDK versus
  custom server
  (`msg_071e099ee77164a6016a6d1fe7b70881958a0e47fc87a150e1`); human `A`
  selected the official SDK
  (`msg_019fba44-f4b7-7d01-ae51-72b67db93e26`). Assistant D6 offered three
  FastMCP positions
  (`msg_071e099ee77164a6016a6d214a5e508195b5383abdfa5a7fe9`); human `C`
  selected no FastMCP (`msg_019fba4a-f475-7261-bdfc-3b8d7c97993f`). Compile-time,
  not runtime, interoperability is stated in
  `msg_019fba4d-d5b1-7fe3-a7bd-757b1c6c2af1`.
- One process and native backing mechanics: one MCP server
  (`msg_019fba99-8166-7972-9c7c-6419c6ed7e7e`), one daemon handling both
  responsibilities (`msg_019fba9b-e490-75a0-b0a6-d5496e090c4d`), production
  dispatch leases plus clean-slate Ledger mechanics
  (`msg_019fbaa3-7017-7fb1-bfb3-e1f829f685c9`), and clients looking identical
  (`msg_019fbaa4-0194-7173-892b-018f4c4cb2cb`).
- Raw-wire reversal: assistant offered shared contract, shared package, or one
  shared raw extension
  (`msg_071e099ee77164a6016a6d55b06f148195a789ba6017a10e27`); human initially
  chose `C` (`msg_019fbb18-5225-7571-8850-9e542d059bd1`). After the human
  corrected that compatibility belongs on the client side
  (`msg_019fbb35-b27d-7cb0-9ff8-3530ccf5a252`), the assistant stated the
  different-wires/identical-client versus shared-wire fork
  (`msg_071e099ee77164a6016a6d5db534c08195968f487cb44d1d3b`) and the human chose
  `A for now` (`msg_019fbb36-cbcc-7df2-9f56-0c75af07ca60`). The earlier shared
  raw extension choice is therefore expressly replaced, with the qualifier
  retained.
- Correlation alternatives: assistant proposed public `turnId`, one
  outstanding turn, or generation-specific raw correlation
  (`msg_071e099ee77164a6016a6d569b2c848195a59055f32ac56b6e`); the human rejected
  `turnId` and only questioned ConversationId
  (`msg_019fbb1c-15c1-7a52-a45c-dcd5cf1c9abe`). No replacement shared raw
  correlation was accepted.
- Client boundary and independent ownership: the assistant clarified the
  client as the library inside OpenClaw/NanoClaw
  (`msg_071e099ee77164a6016a6d5f22f798819591eab8caffc81b83`), and the human
  approved it (`msg_019fbb3c-2311-77b0-a980-719ce4e433cc`). Assistant D9 offered
  independent owner implementations, a shared package, or v2 imported by v1
  (`msg_071e099ee77164a6016a6d69f877fc8195b9f67746b32c8c42`); human `A` selected
  independent ownership and rejected `v1`/`v2` as public names
  (`msg_019fbb66-804c-70f3-844a-5d0f056699a3`).
- Final vocabulary: the human requested `v2/endpoint` to `v2/harness`
  (`msg_019fbba9-30b7-74f0-899c-73896c527e86`) and a deep replacement
  (`msg_019fbbae-51c3-7803-abfd-71b4c01c112b`). A public `Harness` service was
  rejected as confusing (`msg_019fbbbc-4fe9-7d52-886f-2ff092539d50`). The
  assistant proposed Harness-as-subsystem, public `HarnessClient`, `moltzapd`,
  and no umbrella service
  (`msg_071e099ee77164a6016a6d802ed0588195a50e44b7257c390f`); the human approved
  it (`msg_019fbbc8-8810-7670-a0ba-6a02d6b08e53`).
- Client context: the human requested a custom client and cross-conversation
  context (`msg_019fba76-81b9-7481-a39f-2b50c544bcdd`), corrected context to
  the client rather than an SSE write
  (`msg_019fbb68-fe7b-7103-a5d3-ac5ca1e8b626`), and required notifications to
  identify their conversation
  (`msg_019fbb70-7315-7b32-b6fd-f2df0c84426d`).
- Checkpoint reversals and choices: assistant D13 offered empty restart,
  persisted buffer, or history rebuild
  (`msg_071e099ee77164a6016a6d77f8520c8195bc15eea39fbfc01a`). Human `A` first
  chose empty restart (`msg_019fbb9d-03e4-7511-bfa1-1f273eb0865a`), then
  explicitly reversed it to local cursor storage and `C`
  (`msg_019fbb9d-59cc-7683-a137-4c9c8abe48c8`). The human chose checkpoint
  advancement immediately before runtime emission after D14
  (`msg_071e099ee77164a6016a6d7851b37481958d31718145f6ac38` and
  `msg_019fbb9e-4488-7573-a2ac-937b951dd411`) and stable per-conversation
  checkpoints rather than page cursor or MessageId after D15
  (`msg_071e099ee77164a6016a6d788a30988195a02201507124486f` and
  `msg_019fbba1-47b7-7f22-9b2d-e30a36011bc5`).
- Search/result gaps: the human required paginated `search_*` names and posed
  empty-query behavior as a question
  (`msg_019fbab4-3642-7811-88ab-f3e61e4619a1`). The human rejected a redundant
  Harness conversation wrapper
  (`msg_019fbe13-4e72-7311-a85a-f21aea703e3d`) but only questioned whether
  results should be `Conversation[]`
  (`msg_019fbe14-008c-7b92-a9f5-6174dc3a84a2`). The following
  `Conversation[]` answer was assistant text
  (`msg_071e099ee77164a6016a6e19a67bc88195860a7be701bab483`) with no later human
  acceptance.
- Transient ingress: an assistant explanation of the existing listen mechanics
  (`msg_071e099ee77164a6016a6d2668b96081958b7d99af358aad67`) was followed by the
  human saying that contract should be fixed
  (`msg_019fba5e-6b12-7103-b529-1e8c84e6bbeb`). The assistant offered transient
  versus reliable delivery
  (`msg_071e099ee77164a6016a6d4d9688448195aed7fb139cac595b`); the human retained
  transient at-most-once delivery
  (`msg_019fbaff-641a-7db0-81e3-e5119af5b3a0`).
- Content/grant separation: assistant D12 proposed notifying content without a
  grant (`msg_071e099ee77164a6016a6d775244888195b6cd27dbf8a7026a`); the human
  answered yes (`msg_019fbb9b-6c03-7840-a79c-efbebcfbe608`).
- Production same-conversation target: the human rejected simultaneous leases
  in one conversation (`msg_019fbb3e-d7cc-7322-9b78-97b290060a8b`), selected
  `conversation_busy` with no second lease after D6
  (`msg_071e099ee77164a6016a6d605b05b48195a5fb2c38ecaa8ab7` and
  `msg_019fbb43-0d32-77f0-8f4f-b51e3582614c`), then first chose drop for local
  retry D7 and reversed to park/retry A
  (`msg_071e099ee77164a6016a6d6169f8708195a000fca378cbaedf`,
  `msg_019fbb63-155b-7fc3-b84d-bad989c0bf72`, and
  `msg_019fbb63-f985-79a1-abb2-3ce77adb2512`). The ledger explicitly classifies
  this as `main`-owned production work, not a v2 guarantee.
- Output: the human questioned payload-only reply with the `for now` qualifier
  (`msg_019fba74-fd35-78a1-9b93-b9df0cf50989`) and explicitly removed generic
  send from production, then clarified complete removal
  (`msg_019fbaa1-1e06-7cb3-8011-92d5de109a9a` and
  `msg_019fbaa2-8c81-7f51-a106-7b92d66c1679`). The later stable-contract prompt
  included turn-bound `reply(payload)` and no generic send
  (`msg_071e099ee77164a6016a6e414afbcc81959d6b578760fdb360`); the human approved
  that boundary (`msg_019fbeaf-8633-7e42-bf60-c9db136f911b`).
- Scope correction and deferral: the same stable-contract prompt excludes
  premature buffering, serialization, reconciliation-marker, configuration,
  and overflow mechanisms, and the human answered yes. The human then stated
  that implementation had already been decided
  (`msg_019fbeaf-deea-73a0-9e4e-383182d74ab0`) and made actual transcript
  coverage the implementation scope boundary
  (`msg_019fbeb3-0e41-7e62-89a4-5b543e31c546`).
- Execution-shape reversals preserved by the ledger: atomic-cutover `B` and
  mega-PR `C` were later replaced by the human's “actually lets do two
  slices” event (`msg_019fbb0e-73c5-7b13-8d10-529103db8952`). These are
  implementation ordering, not an extra runtime contract.

The explicit source gaps and exclusions are:

- the session metadata does not identify the human account holder;
- empty-query behavior and exact search matching, normalization, ordering,
  paging, cursor, and errors were not decided;
- `Conversation[]` versus `ConversationId[]` and exact agent/conversation
  result projections have no later human answer;
- complete `HarnessClient` Effect signatures, stream/result/error types, the
  exact structural canary, and complete management MCP Schemas/errors are not
  present;
- plural-legal-action mapping for payload-only clean-slate reply is not
  selected;
- atomic START wording appears only in assistant plan text, so the session does
  not create a new START contract; retained owners govern it;
- no shared replacement event identifier, method, filter, field set, terminal
  result, correlation field, or error envelope was selected;
- content-only event method/schema is backing-owned and absent for the
  clean-slate backing;
- checkpoint file/layout/fsync/locking/quota/corruption/encoding and
  rescan/backfill algorithms were not selected;
- retry intervals, timers, queues, limits, overload behavior, exact Effect
  Config keys, profile fields, lifecycle states, activation deadlines, and
  exhaustive error matrices were not selected;
- production registration chose stable OperationId, client-owned recoverable
  credential, pre-call persistence, and identical-retry recovery, but exact
  credential generation, staging/storage, receipt, verifier, fingerprint, and
  changed-input behavior were not selected and remain `main`-owned; and
- the finite ingress profile was assistant-proposed and never human-accepted.

No motive, rationale, confidence, urgency, or mental state is inferred from
those events or gaps.

### 5. Strongest apparent contradiction or stale lineage

The strongest apparent stale instruction is in the historical body of
`docs/decisions/20260728-gate-1-architecture-freeze.md`: its original Decision
Outcome and closing Gate 0 prose say the freeze must merge on `main`. That
appears to conflict with root `AGENTS.md`, `v2/VISION.md`, the current V2
authority ADR, and freeze row `G1-DEC-002`, which say pre-cutover v2 authority
lives on the v2 track and needs no duplicate main-branch copy.

This is resolvable, not a blocker. The record is `partially-superseded`, its
visible Supersession section explicitly says
`20260729-v2-authority-lives-with-v2.md` replaces the main-first requirement,
and the decision index warns that a partially-superseded historical body may
retain old vocabulary. Under the authority order, root law and `v2/VISION.md`
govern, then the replacement ADR/current Supersession scope; the old body is
historical explanation only.

The simulator handoff's separate requirement that its production-line source
baseline land on `main` does not restore main as the owner of v2 ADR/spec
authority. It is a source-provenance gate for a source rewrite that will merge
forward into v2, and the handoff is explicitly evidence rather than normative
architecture authority.

The candidate also closes the most direct current Harness lineage mismatches:
trace row `G1-DEC-209` now distinguishes Registry network authority from local
`/register/mcp` presentation, and the simulator handoff and adapter comment now
use `HarnessClient` instead of the superseded `EndpointProfileRef`. The
decision index, ADR statuses/Supersession sections, normative specs, freeze
rows, architecture pages, and current source handoff agree after those
changes. No unresolved contradiction or broken current lineage was found.

### 6. Implementability and classification of every unresolved choice

A teammate can implement the decisions that are marked ready without chat or
guessing: package/process rename, profile-slot topology, local paths, retained
raw MCP/grant/START/reply mechanics, content-versus-authority semantic split,
client checkpoint law, output restriction, absence of generic send in the
clean-slate surface, and simulator/runtime use of `HarnessClient` are all
discoverable.

A teammate cannot yet implement the entire Harness/runtime-client surface.
The repository says so explicitly in `docs/spec/README.md` and blocks the
corresponding slices. Every non-ready item below is a deliberate deferral or
owner dependency, not an accidental gap:

- **Deliberate deferral — L3 representation:** Transcript/Ledger semantics are
  ready, but the L3 representation owner has not been admitted. Full Harness
  product implementation cannot infer it.
- **Deliberate deferral — exact HarnessClient port:** complete Effect method,
  scoped stream, result, and portable error signatures plus the exact
  bidirectional structural canary are unassigned. The semantic shape alone
  does not authorize types.
- **Deliberate branch dependency — production client:** production
  `HarnessClient` adoption and its exact contract remain `main`-owned. The
  canary waits for both owners; v2 cannot import or invent production code.
- **Deliberate deferral — management wires:** closed registration/status/
  search/history request/result Schemas and errors are backing-owned and
  missing where not already admitted. `status` fields/lifecycle, exact agent
  and conversation projections, and the history stable-position
  representation must be owned before implementation.
- **Deliberate deferral — search semantics:** omitted/empty-query behavior,
  `Conversation` versus `ConversationId` projection, identity result
  projection, matching/ranking/ordering/normalization, page size, cursor
  encoding/authentication/binding, totals, metadata, and failure behavior are
  explicitly unresolved. Harness must not create a wrapper to fill them.
- **Deliberate deferral — content-only wire:** the semantic separation is
  binding, but the clean-slate content-only MCP method and Schema are not
  assigned. Only the retained grant event is ready.
- **Deliberate deferral — plural-action reply:** when a clean-slate grant has
  several legal actions, the payload-to-action mapping is unselected. The
  OpenFloor/task owner must decide it; the client may not infer/default/order
  or expose actionId.
- **Deliberate deferral — context projection details:** the exact backing-owned
  context-entry value is unselected; no second serializable Harness turn DTO
  may be invented.
- **Deliberate deferral — checkpoint mechanisms:** storage format, exact
  encoding, file/shard layout, fsync/rename/locking, cache algorithm, quota,
  corruption handling, rescan/backfill marker, and overflow behavior are
  intentionally outside this interface decision.
- **Deliberate deferral — daemon/registration presentation details:** exact
  configuration keys/profile DTO, whether the absolute key path is daemon
  configuration or a registration-tool input, lifecycle/readiness states,
  activation deadlines, concurrency caps, and exhaustive per-tool errors are
  unassigned.
- **Deliberate deferral — delivery and resource policy:** content/event replay,
  runtime acknowledgment, resumable cursor, shared raw wire, queue/buffer/
  frame/context limits, byte budgets, overload behavior, retry schedules,
  daemon-wide concurrency, bounded cross-conversation snapshots, dynamic
  ports, hostile-local authentication, remote administration, and universal
  supervision are explicitly deferred.
- **Deliberate branch dependency — production registration mechanics:** the
  selected recoverable outcome is `main`-owned, while exact credential
  generation, persistence/staging, fingerprint, changed-input behavior, and
  storage algorithm remain undecided under that owner.
- **Deliberate branch work — production send removal:** the target has no
  generic send, but removing production server/protocol/client/CLI/callers is
  work on `main`; the v2 ADR does not pretend it is already implemented.
- **Deliberate procedural gate — simulator baseline:** the simulator handoff
  SHA, verification evidence, and run evidence remain unset, so simulator port
  consumption is blocked until that separate provenance gate is satisfied.

There is no accidental missing authority link or unresolved choice presented
as implementation-ready. A duplicated `are:` in
`docs/spec/layer-interfaces.md` under “Identity and Router construction
handoffs” is a non-blocking editorial defect; it does not change or obscure a
contract and may be fixed meaning-preservingly without changing this reviewed
candidate.

## Per-question verdicts

| Question | Verdict | Basis |
|---|---|---|
| 1 | PASS | The four current outcomes, problem, and authority classes are discoverable from root law, the index, accepted ADRs, and normative owners. |
| 2 | PASS | Status, Supersession lineage, retained raw mechanics, untouched L1/L2/L3/L4 scope, and current owners are explicit and consistent. |
| 3 | PASS | Implementer duties, prohibited inventions, affected consumers/layers, and trust/safety/liveness/compatibility assumptions are complete and discoverable. |
| 4 | PASS | The accountable human, native event locators, alternatives, reversals, qualifications, and source gaps are present without inferred rationale. |
| 5 | PASS | The strongest stale instruction is explicitly superseded; current authority, trace rows, specs, architecture, and source handoff are consistent. |
| 6 | PASS | Ready slices are implementable; every non-ready choice is visibly blocked and assigned as a deliberate deferral or branch/procedural dependency. No accidental contract gap was found. |

## Checks observed

- `pnpm docs:check`: PASS, no broken links
- `pnpm format:check`: PASS, 661 files
- `git diff --check`: PASS

## Blockers and overall result

Blockers: none for admitting this exact decision candidate. The explicitly
non-ready implementation surfaces listed in answer 6 remain blockers to those
later implementation slices, as designed; they are not blockers to recording
the narrowed decisions and deferrals.

Overall result: **PASS**.

This reviewer result is evidence, not self-certifying authority. A maintainer
must accept it.
