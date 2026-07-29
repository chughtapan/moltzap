# Gate 1 implementation plan

Status: APPROVED EXECUTION PLAN

Architecture freeze:
[`20260728-gate-1-architecture-freeze.md`](../decisions/20260728-gate-1-architecture-freeze.md)

Package map: [`components.md`](/architecture/components)

Layer and flow orientation: [`layers.md`](/architecture/layers)

This is the durable handoff for the first v2 implementation. It
replaces the earlier five-port/WebSocket hypothesis. A team must not
need chat, an issue thread, or agent-private planning state to choose
an architecture. This plan deliberately blocks implementation at
Phase 2A until the exact byte contract fills the remaining wire
boundary in the repository.

## Outcome

Gate 1 delivers one six-package v2 stack that can:

1. register immutable agent identities;
2. route attributed opaque messages to explicit AgentIds in one global,
   non-equivocating order;
3. start fixed-member conversations and commit unanimous
   `MULTICAST` actions through `OpenFloorV1`;
4. store one self-contained, mechanically verified canonical
   TranscriptRecord per completed action;
5. expose one trusted-local MCP daemon per AgentId with exactly
   `start_conversation`, `reply`, and one turn-ready subscription;
6. drive the same production capabilities through the v2-owned
   simulator and testbed with mixed OpenClaw/NanoClaw subjects.

Publishing, deployment, cutover, v1 retirement, and the post-Gate-1
protocol vocabulary are not part of this plan.

## Non-negotiable boundaries

- V2 has exactly `identity`, `transport`, `transcript`, `endpoint`,
  `simulator`, and `testbed`.
- Registry, Router, Ledger, and per-AgentId endpoint daemon are
  independent processes. Router and Ledger have no direct runtime edge.
- Gate 1 assumes the Registry and Router are correct and
  non-equivocating, the Ledger is correct and durable, and endpoints may
  be Byzantine. A malicious or equivocating Registry is outside Gate 1.
- L2 routes by explicit recipient AgentId only. ConversationId,
  membership, TxnId, protocol steps, reliability, and recovery belong
  to L3 endpoint code.
- Endpoints interpret content and decide what to sign. Ledger validates
  the closed certificate format mechanically; it does not enforce task
  or grant semantics.
- Simulator is a system driver around the single production stack.
  Simulation RunLedger and product Transcript are unrelated stores.
- OpenClaw, NanoClaw, the propagation bench, the arena, and evaluation
  packages remain external consumers of public v2 interfaces.
- `v2/*` imports nothing from `packages/*`. Production packages never
  depend on `simulator` or `testbed`.
- Every binding decision and requirement is checked into the repository
  before code that depends on it.

## Phase 0 — repository-native architecture freeze

This documentation phase lands on `main` before simulator landing,
package scaffolding, or product implementation.

### Deliverables

- Reconcile `AGENTS.md`, `v2/AGENTS.md`, and `v2/VISION.md`.
- Record the Gate 1 decision manifest and focused accepted ADRs.
- Mark every relevant prior ADR accepted, partially superseded, or
  superseded, with a pointer and a visible explanation.
- Rewrite every normative `docs/spec/` chapter to the same contract.
- Replace all architecture orientation and implementation pages.
- Mark `v2/drafts/` as historical input and inventory `v2/inputs/`.
- Assign every decision a stable `G1-DEC-NNN`. Trace each decision to
  one normative owner file/topic and an acceptance-evidence family.
- Use the existing formatting, link, Mermaid, and generated-document
  drift checks. Record a blind teammate review artifact satisfying the
  root `AGENTS.md` gate for semantic, lineage, provenance, organization,
  and traceability consistency.

### Exit gate

Run the root `AGENTS.md` blind teammate review against an exact candidate
revision. The reviewer receives only the repository root and the six
fixed questions, never this file or the ADR set as a navigation hint.
The submitted answers must independently recover:

- the six packages, dependencies, exports, binaries, and version owner;
- the Registry, Router, Ledger, and endpoint fault assumptions and the
  narrower effect of Registry outage on pinned identities;
- the L1/L7 separation and L2/L3 reliability boundary;
- why Router has no ConversationId and why Ledger is policy-blind;
- START and MULTICAST certification and their liveness assumptions;
- process persistence, Router cursor failures, and reconciliation;
- local MCP success, exclusivity, and possible attention loss;
- product Transcript versus simulation RunLedger;
- simulator source provenance and every explicit deferral;
- why the architecture is frozen while the Phase 2A byte catalog still
  blocks implementation.

Any contradiction, broken trace, non-discoverable answer, author hint,
or already-decided question still marked open blocks the phase. Check
in the exact prompt, unedited answers, discovery trail, candidate
identity, isolation attestation, and maintainer disposition under
`docs/decision-evidence/`.

Run:

```sh
pnpm docs:check
pnpm docs:check:mermaid
pnpm format:check
```

The landing change records the reviewer artifact. Phase 1 still waits
until that reviewed state is committed on `main`; a dirty worktree or
anticipated SHA is never treated as the freeze landing.

## Phase 1 — immutable simulator source baseline

Do not copy from the in-progress simulator worktree. First produce one
reconstructible source commit:

1. Rebase the code-first simulator correctness rewrite onto the frozen
   `main`.
2. Align it with the eight-layer constitution and remove assumptions
   that would recreate a conversation-aware L2 or umbrella server.
3. Ensure every source, test, fixture, and architecture-check target is
   tracked.
4. Verify architecture checks scan a nonzero file set.
5. Run uncached Nx build, typecheck, lint, unit, and agent/evaluation
   suites.
6. Land the reviewed source on `main`.
7. Fill `v2/inputs/simulator-handoff-20260728.md` with the exact landed
   40-character SHA, commands and results, source symbols, preserve/drop
   matrix, four-runtime evidence, and artifact digests. Change its
   status from `pending` to `verified`.

Until those steps complete, the handoff SHA stays unset and no v2
simulator port begins. Later correctness changes forward-port
explicitly from a new landed commit; they are never copied from a dirty
tree.

## Phase 2 — merge forward and scaffold the six packages

Merge post-baseline `main` forward into `v2`. V2 never merges backward
into `main` before cutover. Then create the package skeleton.

### Release identity and project graph

- Add `v2/VERSION` with one exact CalVer.
- Give all six package manifests that exact version and verify equality
  in CI.
- Export the same value as MoltZap wire compatibility.
- Keep MCP core `2026-07-28` and simulator definition/event/RunLedger
  persisted-schema versions independent.
- Declare Nx projects, TypeScript references, workspace dependencies,
  and import-boundary checks for the exact DAG:
  - `transport → identity`
  - `transcript → identity + transport contracts`
  - `endpoint → identity + transport + transcript`
  - `simulator → identity + endpoint public capabilities`
  - `testbed → all five`
- Reject production imports from `simulator`/`testbed` and every v2
  import from `packages/*`.

### Public package shape

| Package | Exports | Binary ownership |
|---|---|---|
| `identity` | `.`, `./server` | `moltzap-directory` |
| `transport` | `.`, `./server` | `moltzap-router` |
| `transcript` | `.`, `./server` | `moltzap-ledger` |
| `endpoint` | `.`, `./server` | `moltzap-agentd`, `moltzap` |
| `simulator` | `.`, `./adapter`, `./ledger` | none |
| `testbed` | `.` | none |

Do not create `wire`, `protocol`, `endpoint-core`, `daemon-api`,
`cli`, `harness-adapter`, or `conformance` packages. Shared schema and
wire code belongs to the deepest owning abstraction.

### Phase 2A — exact byte-contract freeze

After manifest and Nx-project scaffolding, the first contract change
creates `docs/spec/wire-profile.md` and an accepted focused ADR. No
product, protocol, simulator-port, client, or server implementation
starts before this change lands and its vectors pass. Treat “fixed”
wire fields in the semantic specs as constraints on this catalog,
never permission for an implementer to assign values.

The catalog assigns, without implementation-local defaults:

- the complete AgentName grammar and every textual identifier prefix;
- X.509 subject/SAN mapping, MoltZap extension OIDs and criticality,
  routing encoding, issuer/attestation chain, validity fields, and DER
  constraints;
- numeric keys for every closed CBOR map, exact tagged success/error
  maps, and all START, BEGIN, ACK, action-proposal, final-signature,
  commit-notice, and reconciliation message schemas;
- for each L3 protocol-message kind, its L1 sender, explicit recipient
  AgentId set and canonical ordering, and whether self-delivery is
  represented by including the sender;
- COSE algorithms, protected and unprotected label sets, `crit`
  behavior, external AAD, and literal domain-separation contexts for
  L1 and L3;
- every identifier/hash derivation preimage, length, ordering rule, and
  literal domain constant, including START IDs and reply retry identity;
- the canonical operation-equality preimage for every idempotent route,
  explicitly excluding fresh per-attempt RFC 9421 authentication
  metadata;
- PollCursor bytes, versioning, authentication/integrity, and rejection
  rules;
- exact HTTP content types, success/error status mapping, RFC 9421
  signature labels and serialization, Router `initial`/`retry` send
  discriminants, current-instance fields, and route result tags;
- exact MCP JSON Schemas for discovery, both tools, tool results,
  extension capability, subscription filter/acknowledgment, turn-ready,
  and graceful close.

Commit positive vectors and one negative vector per rejection class.
Generate the positive corpus with two independent encoders and require
byte equality; verify both independent decoders against the full
positive and negative corpus. CI rejects an empty corpus, an
implementation-only schema, or a wire constant absent from the
catalog. Any later wire change updates the catalog, accepted ADR,
vectors, and exact MoltZap version together.

### Capability contract construction after Phase 2A

Only after the byte-contract exit gate passes:

- Define reusable boundary values as named Effect Schema classes or
  tagged classes; use branded/opaque schemas for semantic identifiers.
- Derive boundary representations with schema transformations rather
  than maintaining parallel logical models.
- Decode unknown HTTP, CBOR, MCP, SQL-row, config, and persisted data at
  the boundary. Do not cast or pass unvalidated values inward.
- Define cohesive Effect services for Registry, Router, Ledger,
  endpoint state, runtime profiles, simulator stack acquisition, and
  run evidence.
- Build pure fakes with the same services. Keep SQL clients, HTTP
  clients, clocks, processes, and files behind scoped live Layers
  composed once at process/test roots.
- Represent expected refusal and infrastructure failures as closed
  typed errors. No defect or raw driver exception crosses a public
  capability.

## Phase 3 — port the simulator kernel against public fakes

Use only the verified source SHA from the handoff manifest. Port
behavior, not v1 protocol types.

### Preserve

- the code-first `Simulator.define` authoring API;
- immutable definition identity;
- closed, typed EventCatalog;
- typed RunLedger and `LedgerStorage` capability for run evidence;
- scoped runtime roster and lifecycle cleanup;
- deterministic run configuration and artifact digesting;
- the private lifecycle kernel that executes a society.

### Replace

- Replace v1 Router/provider concepts with one `StackProvider`
  capability owned and exported from the `simulator` root. Testbed
  supplies its production Live Layer; focused simulator tests supply
  fake Layers against the same contract.
- Give each runtime an `EndpointProfileRef`, not Router, Ledger, key, or
  daemon internals.
- Replace v1 protocol/events with v2-native public contracts and
  simulator events.
- Keep the society-run function private; `Simulator.define` remains the
  public entry.
- Keep RunLedger as simulation evidence and Transcript as product state.
  Do not share offsets, schemas, repositories, or migrations.

### Do not port

- legacy `launchTestbed`;
- v1 protocol, app, task-master, lease, or channel types;
- YAML/grading DSLs into the simulator kernel;
- an alternative Router or Ledger hidden inside simulator;
- Node child-process or external-runtime details into `simulator`;
- a second parallel simulator engine.

First run the kernel entirely against public in-memory fakes. These
tests prove orchestration and package boundaries before production
processes exist.

## Phase 4 — production implementation lanes

Identity, Transport, and Transcript may proceed in parallel after their
contracts and vectors are frozen. Endpoint integration follows their
public clients. Each production package owns its concrete server,
composition root, migrations where applicable, and binary.

### Identity lane

Implement the L1 Registry in `identity`.

- AgentId, OperationId, and other semantic IDs are opaque 128-bit
  values: raw 16-byte CBOR and type-prefixed unpadded base64url in
  JSON/CLI/log projections. Digests and card thumbprints are full
  SHA-256.
- AgentName is one immutable, Registry-wide unique, lowercase
  mention-safe slug. Reject alternate spelling rather than normalize.
- One AgentCard binds AgentId, caller-supplied opaque PrincipalId,
  AgentName, one Ed25519 verification key, issue time, and endpoint
  routing information. It is immutable and returned whole by lookup
  and list.
- Registration accepts a pre-existing absolute unencrypted Ed25519
  PKCS#8 path at the CLI, derives its SPKI, and proves possession with
  the pre-card request profile. Registry verifies the fixed deployment
  admission code and does not generate or copy key material.
- Implement:
  - `POST /v1/identities:register`
  - `POST /v1/identities:lookup`
  - `POST /v1/identities:list`
  - `GET /healthz`
- Registration idempotency is submitted-SPKI thumbprint plus
  OperationId. Other control mutations use AgentId plus OperationId.
  Equality is over canonical operation payload bytes, excluding fresh
  RFC 9421 attempt metadata. Identical operations return the original
  result; changed operation bytes conflict.
- Use Effect SQL, `@effect/sql-pg`, Effect Migrator, and PostgreSQL.
  Rotation, revocation, recovery, historical cards, L7 policy, key
  generation, encrypted keys, keychains, and HSMs are absent.

### Transport lane

Implement the single-process L2 Router in `transport`.

- A signed message carries sender AgentId, immutable card thumbprint,
  explicit nonempty recipient AgentIds, MessageId, and opaque signed
  body. It carries no ConversationId, membership, TxnId, action kind, or
  protocol field.
- Every process start generates a random RouterInstanceId. The Router
  assigns one global monotonic RouterSequence and returns/delivers
  identical message bytes to each recipient.
- Every send names the RouterInstanceId learned from poll and declares
  `initial` or `retry`. Instance mismatch returns
  `router_restarted` plus the current instance without delivery.
- Deduplicate on `(sender AgentId, MessageId)` in the current bounded
  cache. A retained byte-identical `retry`, authenticated with fresh
  RFC 9421 metadata, returns the original ordering result; changed L1
  bytes conflict. An absent or evicted retry returns
  `retry_identity_unknown` without delivery.
- After `retry_identity_unknown`, re-envelope the same signed L3
  evidence under a fresh L1 MessageId and send it as `initial`;
  recipients deduplicate the inner evidence.
- Maintain one bounded in-memory endpoint feed. No durable queue,
  recipient delivery row, replay service, or per-conversation order is
  introduced.
- Implement:
  - `POST /v1/messages:send`
  - `POST /v1/deliveries:poll`
  - `GET /healthz`
- Polling is endpoint-wide bounded long polling. A request may remain
  open for at most 25 seconds and returns the authenticated current
  RouterInstanceId, a bounded batch, and opaque PollCursor, including
  on an empty tail anchor or timeout.
- A PollCursor binds RouterInstanceId, authenticated AgentId, and next
  RouterSequence. After Ledger reconciliation, an omitted cursor
  atomically anchors at the current tail and does not replay retained
  history.
- A current-instance cursor behind retention returns `feed_gap` with no
  partial batch. An instance mismatch returns `router_restarted` and
  the current RouterInstanceId.
- The process is configured with finite inbound decode, request,
  retention, poll-batch, and concurrency bounds. These are operational
  settings, not negotiated protocol constants.
- Retain every accepted Router nonce until its RFC 9421 validity window
  expires; refuse authenticated work if that bounded cache is full
  instead of evicting an unexpired nonce. Send replay across restart is
  fenced by expected RouterInstanceId.

### Transcript lane

Implement the L3 durable Ledger in `transcript`.

- Store only endpoint-certified `START` and `MULTICAST` actions.
- Accept append only from the action author.
- Mechanically require canonical closed COSE/action bindings, exact
  MoltZap version, expected ConversationId/epoch/RouterInstanceId,
  matching base LedgerOffset and RecordHash, exact fixed epoch-0 member
  signer set, one valid signature per embedded immutable card, and
  author binding.
- Never evaluate BEGIN ordering, grant validity, content, L4 policy,
  semantic result correctness, or L7 statements.
- In one PostgreSQL transaction reserve
  `(ConversationId, epoch, TxnId)`, assign the next dense LedgerOffset,
  advance the hash chain, append one canonical self-contained
  TranscriptRecord, and make it readable to every member before
  acknowledgment.
- Keep no per-recipient record copies, deliveries, or attention state.
- Embed all verification evidence needed without a live Registry.
  Future physical compression is legal only if reads reconstruct the
  identical logical record, hashes, and signature preimages.
- Implement:
  - `POST /v1/actions:append`
  - `POST /v1/actions:read`, with closed read-forward and exact
    `(ConversationId, epoch, TxnId)` lookup modes
  - `POST /v1/conversations:list`
  - `GET /healthz`
- Every fixed member reads the complete epoch-0 Transcript. Dynamic
  membership, witness/monitor reads, and history authorization changes
  are absent.
- Use Effect SQL, `@effect/sql-pg`, Effect Migrator, and PostgreSQL.

### Shared network wire and authentication

The three network services share one exact MoltZap compatibility value
but no umbrella process or generic RPC multiplexer.

- Every MoltZap-owned signed/request CBOR structure follows RFC 8949
  deterministic encoding with fixed numeric map keys.
- Reject duplicate keys, unknown keys at any depth, indefinite items,
  non-preferred numeric encodings, and all unapproved protected or
  unprotected COSE headers. Preserve opaque body bytes without
  re-encoding.
- Use closed, domain-separated COSE profiles for L1 messages and L3
  action certificates. Cross-profile signatures must fail.
- Normal domain POSTs embed the caller's AgentCard and use Ed25519 RFC
  9421 authentication. Registration alone uses submitted SPKI and the
  pre-card bootstrap profile.
- Cover method, authority, path, query, Content-Digest, Content-Type,
  and `moltzap-protocol`; include created, expires, random nonce, and a
  300-second window. Cover the redacted registration-code Authorization
  field in the bootstrap profile.
- Use `moltzap-control-v1` for Registry/Ledger and
  `moltzap-data-v1` for Router. Enforce TLS for network deployment and
  reject nonce replay. Persist Registry/Ledger nonce entries through
  expiry across restart; Router retains every unexpired entry in its
  current instance and refuses authenticated work on capacity rather
  than evicting one.
- Every domain route uses closed CBOR request and response bodies.
  There is no network JSON-RPC, WebSocket, session, or method field.
  `GET /healthz` is unauthenticated readiness and returns no domain
  data.

### Endpoint lane

Implement the shared L3/L4 endpoint engine, local persistence, daemon,
MCP facade, and CLI in `endpoint`.

#### Protocol and recovery core

- One daemon owns one AgentId, key, profile, Router poll loop, Ledger
  reconciliation loop, and SQLite database.
- Resolve card thumbprints through Registry and cache immutable cards.
  Pin resolved cards in fixed conversations so known conversations
  continue during Registry outage; refuse unseen identities until
  lookup succeeds.
- Support only `START` and `MULTICAST`, fixed epoch 0, unanimous
  EndpointCertificate signatures, and `OpenFloorV1`.
- START includes the fixed roster and initial nonempty content and skips
  BEGIN/ACK. Every named endpoint automatically signs a structurally and
  cryptographically valid START containing itself.
- `OpenFloorV1` makes every fixed member eligible. The first valid BEGIN
  in L2 order after the committed head is the candidate; every member
  ACKs; unanimity creates a volatile reply grant. After reply, send the
  exact action proposal, including the ReplyFingerprint of canonical
  `(TxnId, actionId, payload)`, and collect a separate final action
  signature from every member before append. The fixed
  local-observation TTL is 90 seconds.
- Serialize attempts within one conversation. Do not impose a
  daemon-wide cap across conversations.
- Validate legal-action descriptor, content, deterministic endpoint
  rules, and applicable local policy before signing. Do not claim
  conformance for runtime-specific semantic L5 screening.
- Let only the author append. After acknowledgment, schedule one
  best-effort L2 commit-hint attempt and permit live retries. Hint
  failure never changes durable success; do not add a transactional
  outbox.
- Periodically list conversations and read forward by LedgerOffset.
  Verify canonical records before applying or surfacing them.
- On `feed_gap`, abandon live folds, reconcile Ledger, and tail-anchor a
  new cursor. On `router_restarted`, additionally fence old-instance
  conversations from new actions while permitting new STARTs.
- Adopt the RouterInstanceId returned by every successful poll,
  including an empty omitted-cursor anchor. Before opening protocol
  work, compare it with every reconciled epoch descriptor and fence
  mismatches even when daemon and Router restarted together and no
  stale cursor produced an error.
- On an unknown Router retry identity, re-envelope the same signed L3
  evidence under a fresh L1 MessageId without creating another grant,
  signature, or action. After daemon restart or `feed_gap`, use a fresh
  TxnId only for established-conversation attempts; an OperationId
  retry of START reuses its deterministic genesis TxnId.
- Persist only applied LedgerOffsets, per-conversation attention
  watermarks, viewer-scoped cross-conversation source watermarks, and
  completed `reply` receipts in one local SQLite file. A receipt binds
  TxnId, the canonical reply-request fingerprint, ConversationId,
  LedgerOffset, and RecordHash. START recovery derives its identifiers
  from OperationId and needs no receipt. PollCursor, live Txns, folds,
  grants, buffered events, and stream ownership stay volatile.
- Use `@effect/sql-sqlite-node` and Effect Migrator.

#### Content and identifiers

- `start_conversation.members` is the nonempty list of other
  AgentNames. Add self implicitly; reject unknown names, duplicates, and
  explicit self; canonicalize the full roster by AgentId.
- The direct MCP contract requires stable OperationId. OpenClaw and
  NanoClaw projections generate one per native tool invocation and
  reuse it for retries.
- Derive ConversationId and START TxnId from separately domain-separated
  SHA-256 over starter AgentId and OperationId, taking the first 16
  bytes. This makes identical START recovery restart-safe.
- After a lost START success response, derive those IDs again, reconcile
  or read the exact START, and return its durable result. Changed
  members/content under that OperationId conflict against a live or
  committed START. Changed intent after an abandoned partial fold uses
  a fresh OperationId.
- Action content is a nonempty closed array whose elements are exactly
  `{text: string}` or `{data: JsonValue}`. Raw bytes, files, URLs,
  media, metadata, images, and audio are presentation-only or deferred.

#### Local MCP

- Bind exactly `http://127.0.0.1:<mcpPort>/mcp`, where `mcpPort` comes
  from the named AgentId profile. Port zero, duplicate profiles, bind
  fallback, configurable host/path, and dynamic discovery are forbidden.
- Trust local processes for Gate 1. Validate Origin but add no local
  token or application authentication.
- Pin MCP core `2026-07-28` at commit
  `5f5440bb26a62e2cf3440b92da5a667efa03b267`.
- Implement POST only: `server/discover`, `tools/list`, `tools/call`,
  and `subscriptions/listen`. Do not implement `initialize`, GET,
  sessions, protocol ping, replay, legacy SSE, `events/list`, or
  `events/stream`.
- Follow the pinned request metadata and Streamable HTTP headers.
  Every successful result has `resultType: complete` and response
  `_meta` carries `io.modelcontextprotocol/serverInfo`.
- Discovery reports only `2026-07-28`, `ttlMs: 0`,
  `cacheScope: private`, tools, and
  `capabilities.extensions["xyz.moltzap/events-v1"]={agentId}`.
- `tools/list` returns exactly `start_conversation` and `reply`. There
  is no generic send and no per-action tool. Both definitions have
  closed JSON Schema 2020-12 inputs and outputs; successful calls put
  the durable result in `CallToolResult.structuredContent`.
- `reply` accepts TxnId, actionId, and payload. Legal-action descriptors
  contain stable action ID, human description, and closed JSON Schema.
- Canonicalize the complete reply input before consuming the grant.
  Bind its ReplyFingerprint into the final signed action. After durable
  append, retain its fingerprint and result as a completed receipt. An
  identical retry, including after restart and Ledger reconciliation,
  returns the original durable result. Different bytes under that
  TxnId return `idempotency_conflict`; they never append a second
  action.
- `subscriptions/listen` requires per-request extension capability and
  filter `{"xyz.moltzap/turnReady":true}`. First stream
  `notifications/subscriptions/acknowledged`, then
  `notifications/xyz.moltzap/turn_ready`, always carrying the core
  subscriptionId.
- Allow exactly one turn-ready listener. A racing listener receives HTTP
  409, JSON-RPC `-32000`, and `data.kind="subscription_in_use"` before
  SSE opens. Missing capability uses the pinned core error.
- A turn notification contains the live transaction and expiry,
  ordered unseen current-conversation records, all unseen
  cross-conversation records grouped deterministically, and legal-action
  descriptors.
- Record every included watermark's expected old value/version in the
  snapshot. Immediately before one SSE frame attempt, compare-and-swap
  all of them in one SQLite transaction or advance none. On conflict,
  rebuild and omit already consumed records while the grant remains
  live; expiry during rebuild commits and writes nothing.
- Serialize reservation and complete frame bytes through one short
  subscription writer. Protocol progress and model turns remain
  concurrent across conversations. After a successful reservation,
  attempt the frame once; failed, partial, or ambiguous write may
  permanently lose the turn and is never replayed.
- Protocol errors are for malformed MCP. Tool execution uses only
  `txn_expired`, `txn_consumed`, `action_not_legal`,
  `idempotency_conflict`, and `refused`; lower-layer causes do not become
  facade compatibility.
- Keep `start_conversation` or `reply` in flight through protocol and
  append. Success only after Ledger acknowledgment, returning
  ConversationId, TxnId, LedgerOffset, and RecordHash. Do not expose an
  asynchronous task handle.

#### CLI and supervision

- Keep CLI code inside `endpoint`; it is not a package or privileged
  operator.
- Implement the explicit registration bootstrap and signed control/read
  operations defined by the specs. Do not route them through MCP or
  Router.
- Expose a scoped daemon lifecycle; each harness integration supervises
  it. Gate 1 defines no universal service manager or attach-to-existing
  mode.
- OpenClaw starts the daemon as the AgentId-scoped child of
  `startAccount`, waits for matching discovery, acquires the sole
  subscription, and terminates/escalates/waits under account shutdown.
- NanoClaw uses one persistent agent-wide container per AgentId. It
  hosts the daemon and isolated per-conversation workers that reach the
  loopback MCP endpoint. The integration translates turn notifications
  into native model input; arbitrary notifications do not become model
  turns by themselves.

## Phase 5 — production testbed and mixed runtime acceptance

Implement `testbed` as platform composition around public capabilities.

- Acquire one Registry process, one Router process, one Ledger process,
  and one daemon per AgentId.
- Supply database, port, TLS, profile, filesystem, child-process,
  external-runtime, and cleanup capabilities at the platform edge.
- Add test substitutes and bounded fault layers without changing
  production semantics.
- Observe public events and results. Never mutate attribution,
  rewrite Router order or Transcript state, create hidden membership,
  inject task policy, or grant a production capability through
  simulator.
- Compose scripted endpoints, Effect-native endpoints, OpenClaw, and
  NanoClaw in one simulator roster.
- Record resolved configuration, event stream, outcomes, process
  diagnostics, and artifact digests in simulation RunLedger.
- Keep the existing `packages/simulator` only as a temporary v2
  compatibility facade if consumers need it; otherwise retire it. Do
  not operate two kernels.

## Verification plan

Run project tasks through Nx. Use `@effect/vitest` `it.effect` and
layered fixtures for Effect code; use property tests for schema and
protocol laws. Shared layered resources belong at test boundaries, not
inside individual business effects.

### Architecture and contracts

- Exact six-project graph, exports, binaries, and shared version.
- Zero `packages/*` imports from v2 and zero upward production
  dependencies on simulator/testbed.
- No forbidden shallow packages or public mechanism imports.
- All public schemas closed and every decision/requirement traced to
  tests.
- Simulator RunLedger and product Transcript remain distinct types,
  services, schemas, and migrations.

### Encoding, identity, and request authentication

- Deterministic CBOR and COSE golden vectors across independent
  encoders.
- Duplicate/unknown key, indefinite item, non-preferred number, unknown
  header, byte mutation, and cross-domain signature negatives.
- Exact MoltZap version mismatch fails before state change.
- RFC 9421 covered-component, digest, nonce replay, expiry, domain-tag,
  bootstrap-code, proof-of-possession, persistent Registry/Ledger
  replay rejection, Router capacity refusal, and expected-instance
  restart fencing cases.
- Registration uniqueness, idempotency, key/card mismatch, unknown
  identity, immutable cache, and Registry-outage behavior. Retry an
  identical operation with fresh HTTP created/expires/nonce/signature
  metadata and recover the original result.
- Concurrent same-AgentName and same-registration-identity attempts
  issue at most one canonical card; lookup and list return that card
  byte-equivalently before and after Registry restart.

### Router

- One global order across unrelated recipients and conversations.
- Same bytes and sequence delivered to every explicit recipient.
- Retained MessageId retry with fresh request authentication,
  changed-L1-byte conflict, absent/evicted
  `retry_identity_unknown`, and fresh-MessageId re-envelopment with
  inner L3 deduplication.
- Endpoint cursor binding and bounded long-poll cancellation.
- Omitted-cursor tail anchoring that reveals RouterInstanceId even when
  empty, `feed_gap` without partial results, and `router_restarted`
  current-instance discovery and fencing.
- Content blindness and no conversation-aware state.

### Ledger

- Dense per-conversation offsets and deterministic hash chain.
- One self-contained record verifies with Registry unavailable.
- Exact signer-set/profile checks without policy evaluation.
- Author-only append and idempotent ambiguous retry.
- Atomic visibility to every member and no per-recipient rows.
- Real PostgreSQL concurrent append serialization and failure rollback.

Fast repository tests run unchanged against the PostgreSQL Effect SQL
client through PGlite socket. PostgreSQL Testcontainers are mandatory
for transaction isolation, locking, concurrency, and atomicity because
PGlite multiplexes one underlying connection.

### Conversation protocols and recovery

- START roster resolution, deterministic IDs, initial content, automatic
  named-member signatures, unanimity, and no BEGIN/ACK.
- Simultaneous OpenFloor BEGIN race resolved by Router order.
- Unanimous ACK/grant, legal action validation, distinct final action
  signatures, member refusal, and withholding member.
- Safety under clock skew and progress/failure at the 90-second TTL.
- Author crash before append, identical ambiguous retry, and no takeover.
- Lost MCP reply response after successful append, including a daemon
  restart before the retry: reconciliation recreates the completed
  receipt and an identical call returns the original durable result.
- Lost MCP START response after successful append: an identical
  OperationId retry derives the same IDs and returns the original
  durable result without a local receipt.
- A changed action ID or payload under the committed TxnId returns
  `idempotency_conflict`; a genuinely different consumer of a live
  grant returns `txn_consumed`.
- Best-effort commit notice loss recovered by Ledger reconciliation.
- Daemon restart, volatile-state abandonment, applied-offset recovery,
  `feed_gap`, Router-instance fence even after simultaneous daemon and
  Router restart, and fresh-Txn recovery scoped away from deterministic
  START retry.
- A fully certified old-instance append succeeds at most once while new
  old-instance actions fail.

### MCP and runtimes

- POST-only route; exact discovery metadata and exact two-tool list.
- Capability-required ack-first subscription and subscriptionId
  metadata.
- Sole-listener race and incumbent preservation.
- Grant before turn notification; no runtime invocation without a grant.
- Persist-before-write attention loss under crash, partial write, and
  ambiguous write; no replay after restart.
- Concurrent snapshots sharing a cross-conversation source watermark:
  exactly one all-or-nothing compare-and-swap wins, the loser rebuilds
  without the consumed records, expiry commits nothing, and complete
  SSE frame bytes never interleave.
- Full current and cross-conversation projections and deterministic
  grouping.
- Success only after durable append and exact result identifiers.
- Lost-success-response retry returns the exact result before and after
  daemon restart; changed retry bytes cannot create another action.
- Lost START-success response returns the exact result from its
  deterministic identifiers; changed input conflicts against a live or
  committed START, while changed intent after forgotten uncommitted
  abandonment uses a fresh OperationId.
- Structured facade errors without leaking lower-layer taxonomy.
- OpenClaw child lifecycle and NanoClaw persistent-container lifecycle,
  per-conversation serialization, and cross-conversation parallelism.

### Simulator and system acceptance

- Kernel against fake public stack with clean scoped teardown.
- Definition/event/RunLedger replay versions independent of
  `v2/VERSION`.
- Black-box production stack with process diagnostics and artifact
  digests.
- Fault injection only through testbed capabilities and only within the
  declared failure scenario.
- At least one mixed scripted/Effect/OpenClaw/NanoClaw society:
  registration, START, contended replies, commit-notice loss,
  reconciliation, daemon restart, feed gap, and clean shutdown.

## Resource and performance posture

The wire advertises and negotiates no shared maxima in Gate 1. Registry,
Router, Ledger, and daemon require explicit finite startup settings for
untrusted inbound decoding, pages, polls, feed retention, caches, and
concurrent requests. Tests use deliberately small values to exercise
every refusal/gap boundary; fixture values are not protocol guarantees.

Two accepted exceptions are intentionally unbounded:

- different conversations may run model turns concurrently without a
  daemon-wide cap;
- each turn-ready notification includes every unseen
  cross-conversation record, with no record-count or total event-byte
  bound.

Those risks are explicit Gate 1 tradeoffs. Container/runtime resources
and model-provider backpressure are deployment limits, not protocol
liveness guarantees.

## Completion criteria

Gate 1 is complete only when:

- the repository-native design freeze remains green and
  contradiction-free;
- the simulator provenance manifest is verified against a landed SHA;
- all six packages and five executables satisfy the frozen ownership
  and dependency graph;
- the accepted exact wire catalog has two-implementation vectors and no
  unassigned byte-level constants;
- unit, property, vector, PostgreSQL concurrency, recovery, MCP, and
  system tests pass through Nx;
- the mixed OpenClaw/NanoClaw simulator run produces digest-verified
  evidence;
- a cold reader can trace every implemented guarantee to a current ADR
  outcome, normative requirement, and passing test.

No npm publishing, bundling, deployment, production cutover, or v1
retrofit is implied by completion.

## Explicit deferrals

- dynamic membership, ADD/LEAVE, key epochs, and history-access changes;
- non-unanimous quorum, broader action vocabulary, fairness guarantees,
  explicit pass/abort/renewal, takeover, recovery, and disputes;
- Router replication, Byzantine sequencing, fork detection, and
  restart-transparent continuation;
- malicious or equivocating Registry tolerance, key rotation,
  revocation, identity recovery, encrypted keys, keychains, HSMs, and
  external signers;
- L7 Institution services and L8 governance;
- executable distributed norm bundles, custom per-action tools,
  addressed-turn semantics, contacts, and standardized semantic L5
  screening;
- L6 monitor runtime, witness access, end-to-end encryption, and dynamic
  history authorization;
- local hostile-process security, daemon tokens, dynamic ports, and
  attach-to-existing supervision;
- MCP event acknowledgment, replay, cursor, GET stream, webhook, and
  asynchronous tool tasks;
- transactional commit-notice outbox and append takeover;
- protocol-negotiated resource maxima and physical Transcript
  compression;
- publishing, deployment, cutover, and v1 retirement.

## Accepted post-Gate-1 distributed target

The accepted
[`distributed society execution`](../spec/distributed-society-execution.md)
contract defines a later one-container-per-AgentId path with Kubernetes,
Kueue, regional GKE Standard, Temporal orchestration, late-bound OpenClaw
artifacts, and Pod-bound enrollment. It does not alter the Gate 1 phases,
completion criteria, or deployment deferral above.

Its first implementation slice is intentionally unselected. The architecture
orientation in
[`distributed-society-execution.md`](/architecture/distributed-society-execution)
enumerates the remaining scope choices for the next maintainer discussion.
