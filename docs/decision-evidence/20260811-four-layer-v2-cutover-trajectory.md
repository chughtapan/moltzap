# Four-layer v2 cutover decision trajectory

This is a non-normative, source-faithful event ledger. It records the public
exchange that initiated the four-layer cutover, the execution plan adopted as
a goal, and the later Registry-recovery deferral. It does not admit an ADR,
make the proposed interface binding, or reconstruct rationale that the source
does not state. Current contracts remain in the authority sources identified
by `AGENTS.md` until a replacement candidate lands and passes its review gate.

## Source record and compaction method

- Source system: Codex CLI rollout JSONL, recorded with source `cli` and
  originator `codex-tui`.
- Source session:
  `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Source file:
  `rollout-2026-08-06T12-42-44-019fd899-779c-7e70-a8e4-338727b13e6c.jsonl`.
- Session metadata event: event kind `session_meta`, UTC
  `2026-08-11T17:56:36.570Z`; the payload records session creation time
  `2026-08-06T19:42:44.352Z`, branch
  `agent/v2-identity-foundation`, commit
  `a534a3243ef019ce8616b059fdf86d04b2c26102`, and repository
  `https://github.com/chughtapan/moltzap.git`.
- The session metadata event has no native message ID, enclosing turn, parent
  locator, or stored actor role. It does not identify the human using the
  session.

Quoted message text is literal; paragraph wrapping is normalized for Markdown
without changing words or punctuation. `[omitted: ...]` marks text removed
from a retained message. System and developer instructions, hidden reasoning,
private research, non-public tool payloads, automatic goal-continuation
events, and unrelated workflow detail were omitted. Material planning-UI
questions, options, and stored selections are retained below as literal JSON.
No secret, personal data,
authentication-bound session URL, or machine-local absolute source path is
retained. Every retained response item supplies an enclosing turn in its
stored metadata and lacks a parent-message field; parent locators are stated
as absent rather than invented.

The assistant's plan is retained as an agent proposal. The human instruction
to make it the goal authorizes the recorded execution plan and its durable
preparation work. The exchange does not say that every proposed interface
detail is already a normative decision; the initial human request expressly
asks to discuss the final interface, and the retained plan puts authority and
blind review before implementation.

<a id="four-layer-reduction-and-recursive-trust"></a>

## Four layers and recursive trust features

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator: `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T17:56:38.308Z`.
- Stored actor role: `user`.

Literal excerpt:

> I want to do something: can you fetch
> https://github.com/chughtapan/moltzap/pull/974 into a new worktree and I
> want you to start doing altitude and readability passes over the codebase.
> Look at how the whole codebased is organized now and lets discuss the final
> interface. The other thing I want to do is to refactor our more complex
> proposed design for v2; instead of it being an 8 layer stack, lets try to do
> something shorter. We get rid of the ledger, monitoring, and the revocable
> credentials as large layers and instead things we can build recursively on
> top of the new design later. so the simplified version means everyone will
> maintain their own copy of the conversation history and the ledger, and then
> special institutions and governance become just antoher agent. querying an
> agents private ledger and reconcilling against multiple things becomes
> another type of task. all of that.

This source uses “ledger” both for the large layer to remove and for the copy
each participant maintains. It does not name the final record type, storage
threshold, public API, or disclosure protocol. Those details remain proposals
or open interface work unless a later retained human event selects them.

<a id="planning-ui-decisions"></a>

## Planning UI questions and selections

The events in this section are public planning-UI exchanges stored as paired
`request_user_input` function calls and outputs. The source stores no actor
role or parent-message field on either event type. The prompts are agent
events; the result objects contain the human's selections and literal notes.
Selection here is source evidence for the execution goal, not a substitute for
admitting the resulting contract through the repository authority gate.

### Simplify the existing model rather than replace its semantics

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b62f6d1fc8193bdf9d9e0b4554507`; UTC
  `2026-08-11T17:59:26.002Z`.
- Result locator: `fco_019ff1fd-87dc-7d03-b333-6f3bedf1e0d0`; UTC
  `2026-08-11T18:02:32.284Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Core shape","id":"core_shape","question":"What should replace the eight-layer model as the primary architecture vocabulary?","options":[{"label":"Three capabilities (Recommended)","description":"Identity, delivery, and agent; conversations, tasks, trust, institutions, and governance are recursive agent protocols."},{"label":"Two tiers","description":"Treat identity plus delivery as one network substrate and everything interpretive as agents/endpoints."},{"label":"Four capabilities","description":"Keep conversation/history as an explicit base capability between delivery and higher agent protocols."}]},{"header":"History","id":"history_semantics","question":"Without a central Ledger, what shared-history guarantee should the base system make?","options":[{"label":"Private signed views (Recommended)","description":"Each agent persists its own signed view; comparison and reconciliation expose divergence but no global canonical commit exists."},{"label":"Router-ordered replicas","description":"The Router defines a common order for online recipients, while agents persist independent copies and reconcile missed ranges."},{"label":"Peer-certified commits","description":"Agents persist locally but require member signatures to establish shared committed conversation facts."}]},{"header":"Interface","id":"runtime_interface","question":"How should #974’s runtime-facing interface influence v2?","options":[{"label":"Keep tiny harness (Recommended)","description":"Retain start conversation plus reply-bound turn stream; ledger queries and reconciliation are ordinary higher-level tasks."},{"label":"General task surface","description":"Replace start/reply with submit-task plus event stream so conversation, query, and reconciliation are all task types."},{"label":"Expose local history","description":"Keep start/reply/listen and add explicit local-history and reconciliation methods to the runtime capability."}]}]}
```

Literal result:

```json
{"answers":{"core_shape":{"answers":["None of the above","user_note: I think we should keep the layering but just simplify it"]},"runtime_interface":{"answers":["None of the above","user_note: simplify but don't change too much. we still need all those things"]},"history_semantics":{"answers":["None of the above","user_note: again don't change too much. so the semantics should not change"]}}}
```

### Five layers selected before the later four-layer merge

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b63d625988193baa357dc6a96d425`; UTC
  `2026-08-11T18:03:11.643Z`.
- Result locator: `fco_019ff200-fdb0-74b0-8757-b52ea4edd1f3`; UTC
  `2026-08-11T18:06:19.056Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Layers","id":"layer_compression","question":"Is the intended simplified stack the four-layer communication stack, with all former trust layers expressed recursively on top?","options":[{"label":"Four layers (Recommended)","description":"L1 identity, L2 messaging, L3 conversations/private transcripts, and L4 tasks/norms; former L5–L8 become agent roles and protocols."},{"label":"Five layers","description":"Keep personal endpoint trust as L5, but collapse monitoring, institutions, and governance into agents and tasks."},{"label":"Six layers","description":"Keep personal trust and social oversight as named layers, collapsing only institutions and governance."}]},{"header":"Durability","id":"durability_success","question":"When an action succeeds without a central Ledger, what must be durably true?","options":[{"label":"All members persisted (Recommended)","description":"Preserve current shared-success semantics by acknowledging only after every fixed member confirms its private transcript append."},{"label":"Local persist plus delivery","description":"A caller succeeds after its own append and Router acceptance; peer copies may lag and reconcile later."},{"label":"Norm-defined quorum","description":"Each task norm decides which members must confirm persistence before success."}]},{"header":"MCP surface","id":"mcp_surface","question":"Should the existing daemon/runtime surface remain structurally intact during this redesign?","options":[{"label":"Preserve split (Recommended)","description":"Model-facing start/reply/listen remain; registration, status, search, and history stay daemon management operations; reconciliation is a task."},{"label":"Add task tool","description":"Keep existing tools and add a general task operation for ledger queries and reconciliation."},{"label":"Broaden runtime","description":"Expose search, history, and reconciliation directly to the agent runtime in addition to start/reply/listen."}]}]}
```

Literal result:

```json
{"answers":{"layer_compression":{"answers":["Five layers"]},"durability_success":{"answers":["None of the above","user_note: shared quorum? basically BFT like thing to nesure delivery and failures will catch up or reconcile"]},"mcp_surface":{"answers":["Preserve split (Recommended)"]}}}
```

The five-layer selection is retained because the later four-layer selection
replaces it after the human suggests merging messaging and conversations.

### Router assumption, fixed one-third threshold, and any-member finalization

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b64c1c3e48193b79637c3edf767ee`; UTC
  `2026-08-11T18:07:05.572Z`.
- Result locator: `fco_019ff202-7769-7af0-9a5e-d60e38fd8567`; UTC
  `2026-08-11T18:07:55.753Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Router trust","id":"router_fault_model","question":"Should v2 keep the current trusted, non-equivocating Router while L3 handles Byzantine endpoints and replica catch-up?","options":[{"label":"Keep trusted Router (Recommended)","description":"Minimizes change: Router orders opaque messages; endpoint quorum certificates establish durable conversation facts."},{"label":"Tolerate bad Router","description":"Endpoints must also detect or survive Router equivocation, requiring a substantially broader consensus design."},{"label":"Defer BFT proof","description":"Implement signed replica acknowledgements and reconciliation first without claiming a formal Byzantine threshold yet."}]},{"header":"Fault budget","id":"conversation_quorum","question":"How should a conversation declare its Byzantine quorum assumption?","options":[{"label":"Declare f at creation (Recommended)","description":"Fixed membership records an explicit fault budget, requires n ≥ 3f+1, and commits with 2f+1 signatures."},{"label":"Norm chooses quorum","description":"Each L4 norm supplies a quorum rule, with L3 validating only that the rule has safe intersection."},{"label":"Fixed one-third","description":"Every eligible conversation automatically uses the largest f satisfying n ≥ 3f+1."}]},{"header":"Finalization","id":"commit_finalization","question":"Who may finish and disseminate a quorum-certified record if its author fails?","options":[{"label":"Any member (Recommended)","description":"Any member holding the certificate can finalize and rebroadcast it; lagging peers catch up from valid certified chains."},{"label":"Author only","description":"Preserves current authorship but an author crash can leave a fully signed action uncommitted."},{"label":"Elected successor","description":"A norm-defined successor may take over after a timeout, adding explicit leader and view-change semantics."}]}]}
```

Literal result:

```json
{"answers":{"commit_finalization":{"answers":["Any member (Recommended)"]},"conversation_quorum":{"answers":["Fixed one-third","user_note: fixed one third in each conv. for n<4 it should be all obv"]},"router_fault_model":{"answers":["Keep trusted Router (Recommended)"]}}}
```

### Local record proof, automatic catch-up, and the L2/L3 merge suggestion

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b653f727c81938c108ca73627c1d2`; UTC
  `2026-08-11T18:09:10.928Z`.
- Result locator: `fco_019ff204-876c-71f0-aac3-361b40a1bd51`; UTC
  `2026-08-11T18:10:10.924Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Commit result","id":"commit_result","question":"What should successful start/reply return once there is no global LedgerOffset?","options":[{"label":"Local record proof (Recommended)","description":"Return ConversationId, TxnId, conversation-local RecordHash, and a verifiable quorum certificate; remove global LedgerOffset."},{"label":"Hide proof details","description":"Return ConversationId and TxnId only; callers can inspect certified history through management operations."},{"label":"Local offset","description":"Replace LedgerOffset with a conversation-local offset plus RecordHash and certificate reference."}]},{"header":"Catch-up","id":"catchup_boundary","question":"Should normal replica catch-up be automatic below the task layer?","options":[{"label":"Automatic L3 (Recommended)","description":"Members automatically reconcile their shared conversations; explicit cross-ledger audits and disclosures remain L4 tasks."},{"label":"All reconciliation tasks","description":"Even ordinary missed-history recovery is modeled as an explicit task between agents."},{"label":"Automatic only","description":"Provide automatic member catch-up but no first-class task pattern for cross-ledger comparison yet."}]},{"header":"PR staging","id":"pr974_staging","question":"How should the #974 readability work relate to its current conflict with main?","options":[{"label":"Merge main first (Recommended)","description":"Create a fresh local worktree at PR tip, merge latest main, resolve conflicts, then make altitude/readability edits against the real combined codebase."},{"label":"Review exact tip first","description":"Audit and refactor the exact PR head before resolving its main-branch conflicts."},{"label":"Report then follow-up","description":"Keep #974 untouched, produce a readability report, and implement cleanup only after it lands."}]}]}
```

Literal result:

```json
{"answers":{"commit_result":{"answers":["Local record proof (Recommended)"]},"catchup_boundary":{"answers":["Automatic L3 (Recommended)","user_note: I'd maybe even merge L2 and L3 now that there is no reason. it"]},"pr974_staging":{"answers":["Merge main first (Recommended)"]}}}
```

The note is retained literally, including its unfinished final word. The next
prompt asks whether to adopt the suggested merge.

### Four layers, API cleanup, and authority before implementation

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b65c1e660819395c7eecd5b191af4`; UTC
  `2026-08-11T18:11:21.412Z`.
- Result locator: `fco_019ff206-4451-78f3-8be3-30888ac565c7`; UTC
  `2026-08-11T18:12:04.817Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Final stack","id":"final_stack","question":"Should I lock the redesign to four layers, merging former L2 and L3 while preserving the Router/endpoint ownership seam inside the communication layer?","options":[{"label":"Four layers (Recommended)","description":"Identity; communication; tasks/norms; personal trust, with institutions and governance built recursively as agents."},{"label":"Keep five","description":"Retain ordered messaging and conversations as separately numbered layers despite removing the central Ledger."},{"label":"Three layers","description":"Also fold tasks and norms into communication, leaving identity, coordination, and personal trust."}]},{"header":"Readability","id":"readability_scope","question":"How aggressive should the #974 altitude/readability pass be after merging main?","options":[{"label":"Behavior-preserving (Recommended)","description":"Clarify module ownership, split large orchestration files, align imports/exports, and improve names without changing public or wire behavior."},{"label":"Allow API cleanup","description":"Also change the v1 public package surface where the pass finds confusing or redundant exports."},{"label":"Audit only","description":"Produce findings and a prioritized refactor map without changing #974 code."}]},{"header":"V2 delivery","id":"v2_delivery_scope","question":"What should the first v2 redesign change contain?","options":[{"label":"Authority and spec (Recommended)","description":"Land the replacement ADR, VISION/AGENTS constitution, normative specs, package graph, traceability, and implementation handoff before code."},{"label":"Authority only","description":"Land decisions and normative specs, leaving package graph and implementation sequencing for a later change."},{"label":"Docs plus scaffold","description":"Include authority updates and immediately remove/scaffold v2 packages in the same candidate."}]}]}
```

Literal result:

```json
{"answers":{"readability_scope":{"answers":["Allow API cleanup"]},"final_stack":{"answers":["Four layers (Recommended)"]},"v2_delivery_scope":{"answers":["Authority and spec (Recommended)"]}}}
```

This is the later selection that replaces the earlier five-layer answer.

### Separate action and durability certificates; remove profiles and old client

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b6627e62c81938dab3c1f7cfcff89`; UTC
  `2026-08-11T18:13:04.925Z`.
- Result locator: `fco_019ff209-a6a4-7d93-b543-45caf6a9445a`; UTC
  `2026-08-11T18:15:46.596Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Two quorums","id":"quorum_separation","question":"Should action approval and transcript durability remain separate certificates?","options":[{"label":"Separate them (Recommended)","description":"OpenFloorV1 remains unanimous for semantic validity; the n−f BFT quorum only proves durable replicated storage."},{"label":"One quorum","description":"The n−f quorum both approves the action and proves persistence, changing current norm semantics."},{"label":"Norm controls both","description":"Each norm chooses both semantic approval and durability thresholds."}]},{"header":"Harness API","id":"harness_api_path","question":"How should the v1 harness API be exposed after the readability pass?","options":[{"label":"One subpath (Recommended)","description":"Move all adapter-facing acquisition, types, Layer, and service exports to @moltzap/client/harness-client; remove duplicate root exports."},{"label":"Keep root aliases","description":"Make the subpath canonical but retain deprecated root re-exports for compatibility."},{"label":"Keep current split","description":"Leave profile acquisition at the root and client types/acquisition on the subpath."}]},{"header":"Acquisition","id":"acquisition_names","question":"Should the scoped profile factory be renamed for lifecycle clarity?","options":[{"label":"Rename explicitly (Recommended)","description":"Use acquireHarnessClientForProfile for daemon-owning scoped acquisition and keep acquireHarnessClient for connecting to a supplied MCP URL."},{"label":"Keep current name","description":"Keep harnessClientForProfile and document that its Effect is scoped and owns the daemon lifecycle."},{"label":"Single factory","description":"Expose one acquireHarnessClient overload accepting either profile or URL."}]}]}
```

Literal result:

```json
{"answers":{"quorum_separation":{"answers":["Separate them (Recommended)"]},"acquisition_names":{"answers":["None of the above","user_note: simplify and cleanup. why are we even keeping profiles now"]},"harness_api_path":{"answers":["None of the above","user_note: move to @moltzap/harness or @moltzap/client but basically old client code should die or be refactored away right"]}}}
```

### Explicit daemon configuration, `@moltzap/client`, and all-v1 cutover

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b6746dd74819386b22a7bcd6b2bde`; UTC
  `2026-08-11T18:17:49.984Z`.
- Result locator: `fco_019ff20c-30c7-75d3-894f-9c03246acaee`; UTC
  `2026-08-11T18:18:33.060Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Package name","id":"harness_package_name","question":"What package identity should the cutover use?","options":[{"label":"v2-harness then harness (Recommended)","description":"Keep @moltzap/v2-harness while v2 is private, then publish it as @moltzap/harness at production cutover."},{"label":"Rename to harness now","description":"Use @moltzap/harness immediately on the v2 branch even while other clean-slate packages retain the v2 prefix."},{"label":"Use client","description":"Keep the generic @moltzap/client name and replace its internals with the v2 implementation."}]},{"header":"First wave","id":"first_cutover_wave","question":"What should the first executable cutover wave retire on the v2 branch?","options":[{"label":"Core trio (Recommended)","description":"Implement enough identity/router/harness behavior, migrate OpenClaw and NanoClaw, then delete v1 client, protocol, and server together."},{"label":"Client only","description":"Replace and delete packages/client first while temporarily retaining v1 protocol and server behind adapters or tests."},{"label":"All v1 packages","description":"Replace core, simulator, evals, and integrations in one branch-wide cutover."}]},{"header":"Daemon config","id":"daemon_configuration","question":"What replaces named profiles for one-agent-per-daemon configuration?","options":[{"label":"Explicit process config (Recommended)","description":"Supervisor supplies state directory, MCP bind/port, Registry origin/key, and Router origin; registration commits identity into local state."},{"label":"One config file","description":"Daemon reads a single per-agent config file path containing process settings and local identity state."},{"label":"Environment only","description":"Every process setting is supplied through environment variables, with identity persisted separately after registration."}]}]}
```

Literal result:

```json
{"answers":{"daemon_configuration":{"answers":["Explicit process config (Recommended)"]},"harness_package_name":{"answers":["Use client"]},"first_cutover_wave":{"answers":["All v1 packages"]}}}
```

### Final package homes, names, and adapter-facing capability

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b67c36258819396b8f765476e50a3`; UTC
  `2026-08-11T18:19:53.811Z`.
- Result locator: `fco_019ff20f-00b2-77c1-952d-01680dbfbf52`; UTC
  `2026-08-11T18:21:37.330Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Workspace","id":"workspace_layout","question":"How should surviving non-core consumers be organized after deleting packages/* on v2?","options":[{"label":"Core + integrations (Recommended)","description":"Keep five core v2 packages; move OpenClaw/NanoClaw to integrations/* and eval tooling to tools/evals."},{"label":"Everything under v2","description":"Place core, adapters, and eval tooling as sibling packages under v2/*."},{"label":"Keep packages folder","description":"Delete v1 core but retain packages/* for migrated adapters and eval tooling."}]},{"header":"Package names","id":"package_renaming","question":"Should this cutover adopt final non-v2 npm names for every surviving package now?","options":[{"label":"Rename all now (Recommended)","description":"Use @moltzap/identity, router, client, simulator, and testbed during the v2 cutover so no later naming migration remains."},{"label":"Only client now","description":"Use @moltzap/client but keep v2 prefixes on identity, router, simulator, and testbed until production cutover."},{"label":"Keep all v2-prefixed","description":"Use @moltzap/v2-client and defer every public package rename."}]},{"header":"Client type","id":"client_type_name","question":"What should the sole adapter-facing Effect capability be called inside @moltzap/client?","options":[{"label":"HarnessClient (Recommended)","description":"Keep the precise existing concept while removing all older client/service surfaces."},{"label":"MoltZapClient","description":"Use the product name for the one surviving client capability."},{"label":"Client","description":"Use the shortest name and rely on the package namespace for context."}]}]}
```

Literal result:

```json
{"answers":{"workspace_layout":{"answers":["None of the above","user_note: move everything into packages? just delete old code wholesale"]},"client_type_name":{"answers":["HarnessClient (Recommended)"]},"package_renaming":{"answers":["Rename all now (Recommended)"]}}}
```

The package list still included a testbed in the option description. The later
human testbed statement and adopted plan remove that package; the old wording
is retained here rather than repaired.

### Aborted first cutover-policy prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b68723cb08193866b8a1589f44928`; UTC
  `2026-08-11T18:22:50.743Z`.
- Result locator: `fco_019ff210-2654-71b3-b959-34c93e655183`; UTC
  `2026-08-11T18:22:52.500Z`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Main merges","id":"forward_merge_policy","question":"What should happen to main→v2 forward merges once the deletion cutover starts?","options":[{"label":"Freeze forward merges (Recommended)","description":"Stop routine merges at the cutover base; manually port only relevant production fixes until v2 becomes main."},{"label":"Resolve deletions","description":"Continue merging main and repeatedly preserve v2 deletions during conflict resolution."},{"label":"Cut over branch now","description":"Make v2 the production authority/main replacement before beginning package deletion."}]},{"header":"PR 974 role","id":"pr974_role","question":"What role should PR #974 play now that v1 code will be deleted on v2?","options":[{"label":"Behavioral oracle (Recommended)","description":"Merge main into a fresh local #974 worktree, extract accepted interface/tests and readability lessons, but implement cleanup only in the new packages."},{"label":"Still improve PR","description":"Continue API/readability edits on #974 for main while independently rebuilding the v2 branch."},{"label":"Land before cutover","description":"Treat landing #974 on main as a prerequisite, then freeze/branch the cutover from the merged result."}]},{"header":"ACG rules","id":"acg_readability","question":"Should the 0.0.21 vertical-readability rules become blocking immediately?","options":[{"label":"Enable all now (Recommended)","description":"Turn on stable file shells, step-down function order, and non-vacuous JSDoc for every surviving/new package and migrate until green."},{"label":"New code only","description":"Enable them only for newly replaced packages, leaving identity/router migration for a later pass."},{"label":"Upgrade only","description":"Bump ACG to 0.0.21 but leave its new readability rules disabled."}]}]}
```

Literal result:

```text
aborted by user after 1.7s
```

No selection is inferred from the aborted result. The merge and PR questions
were asked again in the next turn. The direct ACG recommendation and human
“enable” response are retained under
[Readability ratchet and testbed removal](#readability-ratchet-and-testbed).

### Freeze forward merges, land #974 first, preserve the simulator API

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b6890ab4481938e5fa766cb103d98`; UTC
  `2026-08-11T18:23:18.465Z`.
- Result locator: `fco_019ff211-9d26-7051-986b-267c722b6286`; UTC
  `2026-08-11T18:24:28.454Z`.
- Enclosing turn: `019ff210-3e63-7a52-9476-580e86e0f010`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Main merges","id":"forward_merge_policy","question":"What should happen to main→v2 forward merges once old packages are deleted?","options":[{"label":"Freeze forward merges (Recommended)","description":"Stop routine merges at the cutover base and manually port only relevant production fixes until v2 replaces main."},{"label":"Preserve deletions","description":"Continue merging main and resolve each merge so removed v1 packages stay deleted."},{"label":"Make v2 main first","description":"Promote v2 to production authority before beginning the deletion wave."}]},{"header":"PR 974","id":"pr974_role","question":"What role should PR #974 play in the cutover?","options":[{"label":"Behavioral oracle (Recommended)","description":"Create the fresh merged worktree, extract its accepted behaviors/tests and readability lessons, then implement only in the replacement packages."},{"label":"Improve both tracks","description":"Continue API/readability work on #974 for main while separately rebuilding v2 packages."},{"label":"Land first","description":"Require #974 to land on main before freezing and beginning the v2 package cutover."}]},{"header":"Simulator","id":"simulator_ownership","question":"Should simulator absorb the former testbed responsibilities?","options":[{"label":"Absorb them (Recommended)","description":"Simulator owns StackProvider, real process/container acquisition, supervision, substitutes, and fault controls."},{"label":"Drop live testbed","description":"Keep only a portable in-process simulator and remove real-stack acquisition and fault infrastructure."},{"label":"Client owns processes","description":"Move daemon/process supervision into @moltzap/client and leave simulator as a pure run kernel."}]}]}
```

Literal result:

```json
{"answers":{"simulator_ownership":{"answers":["None of the above","user_note: look at the latest main? the simualtor has a lot of things which are stable. you should make the miniaml changes to work for v2. simualtor API should not change"]},"pr974_role":{"answers":["Land first"]},"forward_merge_policy":{"answers":["Freeze forward merges (Recommended)"]}}}
```

The simulator note is retained with its spelling and question mark. It states
a preservation direction; the later repository audit found specific
authority-bearing simulator contracts that cannot keep their old semantics,
which the final authority still has to resolve explicitly.

### Router re-anchoring, long-lived branch, and blockers-only #974 cleanup

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Request locator:
  `fc_0fe7c1dd2e31cd97016a7b692b46b8819390fad670bd984ca3`; UTC
  `2026-08-11T18:25:54.702Z`.
- Result locator: `fco_019ff213-9fe0-7ea0-8e57-458b9727fc70`; UTC
  `2026-08-11T18:26:40.224Z`.
- Enclosing turn: `019ff210-3e63-7a52-9476-580e86e0f010`.
- Parent locator: absent from both stored events.
- Stored actor role: absent from both stored events.

Literal request arguments:

```json
{"questions":[{"header":"Router restart","id":"router_restart_recovery","question":"After Router restart, should an existing conversation continue after quorum reconciliation?","options":[{"label":"Quorum re-anchor (Recommended)","description":"Members reconcile the latest certified head and sign a new Router-instance epoch certificate, then continue the same conversation."},{"label":"Keep fencing","description":"Preserve current behavior: old conversations stay readable but cannot accept new actions on the new Router instance."},{"label":"New conversation","description":"Reconcile old history, then create a replacement conversation rather than re-anchoring the existing ID."}]},{"header":"Cutover PRs","id":"cutover_pr_shape","question":"How should the all-v1 deletion cutover land after #974?","options":[{"label":"Stacked green PRs (Recommended)","description":"Land authority, package relocation, communication/client, adapters, and simulator/evals as ordered PRs; delete each old surface as its replacement lands."},{"label":"One atomic PR","description":"Keep all replacements and deletions in one large candidate so no intermediate mixed tree lands."},{"label":"Long-lived branch","description":"Accumulate the full cutover on one branch and merge it only after end-to-end parity."}]},{"header":"PR cleanup","id":"pr974_cleanup","question":"Before landing #974, should its scope stay narrow now that v1 will soon be deleted?","options":[{"label":"Land blockers only (Recommended)","description":"Resolve latest-main conflicts, review correctness/readability, and fix landing blockers; move broad cleanup into replacement packages."},{"label":"Full readability pass","description":"Refactor #974’s v1 implementation and public API extensively before landing it."},{"label":"No code changes","description":"Resolve conflicts only and rely on existing behavior/tests before landing."}]}]}
```

Literal result:

```json
{"answers":{"router_restart_recovery":{"answers":["Quorum re-anchor (Recommended)"]},"cutover_pr_shape":{"answers":["Long-lived branch"]},"pr974_cleanup":{"answers":["Land blockers only (Recommended)"]}}}
```

<a id="v1-retirement-and-cutover-goal"></a>

## v1 retirement and the adopted cutover goal

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator: `msg_019ff209-a6b4-7660-bb73-0d7fc7fa1938`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T18:15:46.612Z`.
- Stored actor role: `user`.

Literal excerpt:

> I also want to start cutovers now. lets start getting rid of v1 in the v2
> branch now.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator:
  `msg_0fe7c1dd2e31cd97016a7b698cc8448193a837b65a5efb21f9`.
- Enclosing turn: `019ff210-3e63-7a52-9476-580e86e0f010`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T18:28:01.929Z`.
- Stored actor role: `assistant`.

Literal excerpt, with implementation detail and the test matrix compacted:

> <proposed_plan>
> # Four-Layer v2 Cutover and v1 Retirement
>
> ## Summary
>
> Land PR #974 first, then take one final `main → v2` merge and freeze routine
> forward merges. Replace the repository’s implementation wholesale on a
> long-lived cutover branch: final code lives under `packages/*`, old v1 core
> disappears, and the system uses four conceptual layers with
> endpoint-replicated conversation records instead of a central Ledger.
>
> ## Architecture and Interfaces
>
> - Replace the eight-layer model with:
>
>   1. Identity
>   2. Communication: content-blind Router plus endpoint-owned conversations,
> durability, and reconciliation
>   3. Tasks and norms
>   4. Personal trust
>
> - Monitoring, institutions, credentials, and governance become ordinary
> agents, signed claims, and task protocols recursively built on these layers.
> - Retain the correct, non-equivocating Registry and Router assumptions.
> Remove the Ledger process, `moltzap-ledger`, Transcript service, and product
> `LedgerOffset`.
>
> [omitted: proposed action-validity, endpoint-durability, catch-up, Router
> restart, MCP, daemon configuration, and HarnessClient details]
>
> ## Repository and Cutover Sequence
>
> 1. **Land PR #974**
>
> [omitted: PR worktree, merge, landing-blocker, verification, and blind-review
> steps]
>
> 2. **Freeze and establish authority**
>
> - Merge the resulting `main` into `v2` once, record the cutover base, and stop
> routine forward merges. Manually port only relevant production fixes until
> v2 replaces main.
> - Admit a replacement ADR covering the four-layer model, replicated
> durability, package graph, profile removal, and Router re-anchoring.
> - Update `AGENTS.md`, `v2/VISION.md`, normative specifications, architecture
> pages, decision index, Gate 1 traceability, and implementation handoff
> atomically.
> - Explicitly supersede affected eight-layer, Ledger atomic-commit,
> fault-model, monitor, package-count, and profile-slot outcomes without
> rewriting their history.
> - Capture this conversation as provenance where native locators are
> available; otherwise record the required source gap.
> - Freeze the exact authority candidate and pass the six-question isolated
> blind review before implementation work begins.
>
> 3. **Replace the workspace on one long-lived cutover branch**
>
> - Final package set:
>
>   - `@moltzap/identity`
>   - `@moltzap/router`
>   - `@moltzap/client`
>   - `@moltzap/simulator`
>   - `@moltzap/evals`
>   - `@moltzap/openclaw-channel`
>   - `@moltzap/nanoclaw-channel`
>
> [omitted: package relocation, adapter, simulator, eval, deletion, and
> workspace-metadata steps]
>
> 4. **Readability ratchet**
>
> - Pin `eslint-plugin-agent-code-guard` to `0.0.21` and update the lockfile.
> - Enable `no-vacuous-jsdoc`, `require-stable-file-shell`, and
> `prefer-stepdown-function-order` as blocking errors for every package.
>
> [omitted: remaining readability guidance, test plan, and assumptions]
> </proposed_plan>

This is an assistant-authored execution proposal. Its own sequence requires a
replacement authority candidate and blind review before implementation.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator: `msg_019ff231-e57a-7323-a0a3-c98c9b10ff22`.
- Enclosing turn: `019ff231-e1b9-72e1-a31a-91fc29e7443b`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T18:59:44.122Z`.
- Stored actor role: `user`.

Literal excerpt:

> set this plan as your goal. write it to durable storage first and then start
> shipping.

The reply refers to the directly preceding retained plan. It selects that
plan as the execution goal and orders durable storage before shipping. It
does not mention acceptance of an ADR, blind-review result, or final public
interface.

<a id="readability-ratchet-and-testbed"></a>

## Readability ratchet and testbed removal

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator: `msg_019ff20f-0112-7c11-820b-8b4933270d85`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T18:21:37.426Z`.
- Stored actor role: `user`.

Literal excerpt:

> also update to latest acg which might have better readability rules

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator:
  `msg_0fe7c1dd2e31cd97016a7b6852085c81938648c56d41d8b0c3`.
- Enclosing turn: `019ff1f8-149f-7330-837b-eabd1a33c73d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T18:22:13.441Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> ACG resolves to `eslint-plugin-agent-code-guard`. The repo pins `0.0.20`;
> npm’s current `latest` is `0.0.21`, published August 5, 2026. The release
> adds exactly the readability-oriented vertical-organization rules we want:
>
> - `no-vacuous-jsdoc`
> - `require-stable-file-shell`
> - `prefer-stepdown-function-order`
>
> They ship disabled in the preset, so merely bumping the package would not
> change the codebase. I recommend enabling all three as errors in the shared
> package config and making the new `packages/*` cutover satisfy them from its
> first commit. The old v1 violations disappear with wholesale deletion;
> surviving identity/router code gets a focused migration rather than an
> allowlist. ([package registry
> metadata](https://www.npmjs.com/package/eslint-plugin-agent-code-guard))

This is an agent recommendation and reported registry lookup. The next human
event supplies the selection.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator: `msg_019ff210-429e-7912-8d33-b80c7b409d53`.
- Enclosing turn: `019ff210-3e63-7a52-9476-580e86e0f010`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T18:22:59.743Z`.
- Stored actor role: `user`.

Literal excerpt:

> enable
> I don't think we have testbed anymore

“enable” answers the directly preceding recommendation to enable all three
named rules. The testbed sentence records the human's wording without
silently converting “I don't think” into a stronger standalone deletion
decision. The later adopted plan expressly includes removal of the testbed
package.

<a id="registry-recovery-deferred"></a>

## Registry recovery correction and deferral

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator:
  `msg_0fe7c1dd2e31cd97016a7b7b2459ec8193b5a323d95381cef6`.
- Enclosing turn: `72e7f912-4b99-40c2-9e44-10235a3cf32c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T19:42:29.963Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> One ADR-sensitive behavior needs your explicit sign-off before I freeze the
> candidate: if Registry commit and local persistence succeed but the daemon’s
> first network activation fails, I recommend that a repeated `register` call
> resume activation and return the already-committed identity without a second
> Registry call. A lost Registry response before local persistence remains
> non-idempotent. I’ve implemented the narrow retry with a fault test; tell me
> if you want the stricter alternative instead.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator: `msg_019ff259-becc-7400-9b3f-243c73c30dd4`.
- Enclosing turn: `72e7f912-4b99-40c2-9e44-10235a3cf32c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T19:43:15.660Z`.
- Stored actor role: `user`.

Literal excerpt:

> I accept that

The terse reply is limited to the immediately preceding retained activation
retry proposal. It is not acceptance of PR #974's blind-review result, the
four-layer authority, or the final interface.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator:
  `msg_0fe7c1dd2e31cd97016a7b8d1ac4b88193bbf270f9c112120a`.
- Enclosing turn: `72e7f912-4b99-40c2-9e44-10235a3cf32c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T20:59:09.371Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> The provenance check is now exact and it confirms the boundary we need from
> you. To freeze #974, please confirm both statements together:
>
> 1. Once the Registry returns successfully, the live daemon retains that
> result and retries any failed local profile write, then activation, without
> a second Registry call; a crash before the write succeeds remains
> unrecoverable.
> 2. If a recovery call supplies a different `inviteCode` or `description`,
> the daemon ignores those changed arguments and resumes the first result
> rather than rejecting the call.
>
> That is my recommended/current implementation. A simple “accept both” is
> enough; otherwise tell me which one to change.

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator: `msg_019ff2a0-6576-7172-8c6b-e32415d4ede2`.
- Enclosing turn: `72e7f912-4b99-40c2-9e44-10235a3cf32c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T21:00:25.847Z`.
- Stored actor role: `user`.

Literal excerpt:

> 2. If a recovery call supplies a different inviteCode or description, the
> daemon ignores those changed arguments and resumes the first result rather
> than rejecting the call.? failure

The event repeats item 2 and answers it with “failure.” It rejects silent
argument mismatch for that recovery call. It does not answer item 1.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator:
  `msg_0fe7c1dd2e31cd97016a7b8d851e248193b99dcf4c05f1dccd`.
- Enclosing turn: `72e7f912-4b99-40c2-9e44-10235a3cf32c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T21:00:54.627Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Understood: a changed `inviteCode` or `description` is a recovery failure.
> I’m switching the handler to reject the mismatch without re-calling
> Registry, rewriting the tests and docs accordingly.
>
> I still need your separate acceptance of item 1: retain a successfully
> returned Registry result in memory and retry a failed profile write; a crash
> before persistence remains unrecoverable.

This is an agent interpretation and implementation statement. It preserves
item 1 as a separate unanswered request.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator: `msg_019ff2a1-23e6-7f90-b627-7df2faa176b6`.
- Enclosing turn: `019ff2a1-2154-7c82-8d4c-e4dbf37a7342`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T21:01:14.598Z`.
- Stored actor role: `user`.

Literal excerpt:

> just skip fighting the registry; continue making progress towards the
> cutover. just open this as an issue and proceed

This event directs the agent to move the unresolved Registry work into an
issue and continue the cutover. It does not revoke the mismatch-failure
answer, resolve item 1, or admit a public recovery contract.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Native locator:
  `msg_0fe7c1dd2e31cd97016a7b8dea65c48193bf40bb1ce6b39370`.
- Enclosing turn: `019ff2a1-2154-7c82-8d4c-e4dbf37a7342`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-11T21:02:35.923Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Got it. I’m deferring the Registry recovery design instead of spending more
> cutover time on live-process edge semantics. I’ll open a focused issue,
> remove that new recovery contract from PR 974, keep the unrelated
> lifecycle/readiness/restart hardening, land the prerequisite, and move into
> the four-layer cutover.

This is an agent response to the deferral instruction, not another human
decision.

<a id="mechanical-effects"></a>

## Mechanical repository and issue effects

These are effects of the exchange, not additional human rationale or
normative authority.

- Git commit `bcc3911ed99ed35060bb6eec77a8145e01ab2ee4`, with author
  timestamp `2026-08-11T19:06:59Z`, added the non-normative durable execution
  plan at `docs/architecture/four-layer-v2-cutover.md` on branch
  `cutover/four-layer-v2`.
- Source system: Codex CLI rollout JSONL invoking GitHub CLI; source session
  `019fd899-779c-7e70-a8e4-338727b13e6c`; native call locator
  `ctc_0fe7c1dd2e31cd97016a7b8df3cc6881938a183d433101a326`; native result
  locator `ctco_019ff2a2-a56b-7571-a3e6-996b72915aba`; enclosing turn
  `019ff2a1-2154-7c82-8d4c-e4dbf37a7342`; parent locator and stored actor role
  absent from both tool events. The call at `2026-08-11T21:02:52.043Z` created
  GitHub issue #984, “Define Registry registration recovery and idempotency
  semantics”; the result at `2026-08-11T21:02:53.291Z` returned its URL. The
  initial body listed changed recovery arguments as a question, and the issue
  had no label at creation.
- Source system: Codex CLI rollout JSONL invoking GitHub CLI; the same source
  session and enclosing turn; native call locator
  `ctc_0fe7c1dd2e31cd97016a7ba0a2c2008193917cb95d83381071`; native result
  locator `ctco_019ff2eb-8842-7b31-9fc2-46b3abe1a0d2`; parent locator and
  stored actor role absent. The call at `2026-08-11T22:22:28.152Z` added the
  `v2` label; the result at `2026-08-11T22:22:29.955Z` confirmed it.
- Source system: Codex CLI rollout JSONL invoking the GitHub connector; the
  same source session and enclosing turn; native call locator
  `ctc_0fe7c1dd2e31cd97016a7bb48c465c8193a72924d07b49e50d`; native result
  locator `ctco_019ff339-650e-7d82-8342-aea6fe6a336b`; parent locator and
  stored actor role absent. The call at `2026-08-11T23:47:31.761Z` updated the
  issue body to record changed `inviteCode` or `description` as a decided
  failure, retain the other recovery questions, and state that #984 does not
  block the cutover. The result at `2026-08-11T23:47:32.750Z` returned the
  updated issue.
- Git commit `90543f2faf9df1578df414b50ead53ba55dad5c9`, with author
  timestamp `2026-08-12T01:25:49Z`, added non-normative authority,
  interface, package, and forward-merge handoffs. Those handoffs prepare the
  future candidate and do not change current architecture authority.
