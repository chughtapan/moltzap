---
status: accepted
date: 2026-07-28
decision-makers: Tapan Chugh
---

# Gate 1 starts with a repository-native architecture freeze

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-gate-1-architecture-freeze) and [Registry trust selection](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#registry-trust-assumption).

## Context and Problem Statement

The Gate 1 engineering review resolved the implementation boundary, but
the repository still contained older accepted records and normative
pages that described incompatible transports, package maps, layer
ownership, and endpoint surfaces. A plan available only in a review
conversation is not an implementation contract and cannot be audited by
a cold reader.

## Decision Outcome

Chosen: **the reconciled repository is the first Gate 1 deliverable**.
No simulator landing, v2 scaffolding, or product implementation begins
until the architecture freeze is reviewed and merged on `main`.

The repository reading order is:

1. `AGENTS.md` and `v2/VISION.md` state design law.
2. Accepted decision records state rationale and supersession lineage.
3. `docs/spec/` owns normative Gate 1 contracts.
4. `docs/architecture/` explains the resulting system and execution
   plan.
5. `v2/inputs/` is evidence; `v2/drafts/` is historical, non-normative
   input.

Every earlier decision record has one exact status:
`accepted`, `partially-superseded`, or `superseded`. A partially or
fully superseded record names its replacement and visibly states what,
if anything, remains valid. Records are not deleted or silently
rewritten.

The traceability inventory below is the durable record of the complete
Gate 1 decision set. It intentionally has no dependency on private
conversation state or local planning databases. If a normative page and
this inventory disagree, the freeze is not complete and implementation
remains blocked.

The focused accepted records owning the design rationale are:

- `20260728-adrs-link-source-events-and-require-blind-review.md`
- `20260728-layer-boundaries-and-fault-model.md`
- `20260728-gate-1-identity-profile.md`
- `20260728-network-wire-is-http-post-polling.md`
- `20260728-transcript-is-mechanical-atomic-commit.md`
- `20260728-open-floor-v1.md`
- `20260728-endpoint-daemon-speaks-modern-mcp.md`
- `20260728-model-surface-is-start-reply-listen.md`
- `20260728-six-deep-packages-one-version.md`
- `20260728-simulator-is-the-system-driver.md`

## Normative owner

The `Normative owner` column identifies the one checked-in area that
owns each frozen decision. Public interface and wire facts must point
to `docs/spec/`; architecture pages cannot establish a competing
interface. Repository process, implementation ordering, source
provenance, and design-law decisions may instead point to their
canonical architecture, input, or agent-law owner.

## Acceptance owner

The `Acceptance owner` category identifies the evidence suite that must
pin each decision:

| Category | Evidence required |
|---|---|
| `DOC` | Repository consistency checks and a blind teammate review |
| `ARCH` | Dependency, ownership, process-boundary, and import checks |
| `WIRE` | Golden vectors, strict decoding, authentication, and retry tests |
| `ID` | Registry, card, identifier, and bootstrap tests |
| `L2` | Router order, multicast, polling, gap, and restart tests |
| `L3` | Ledger atomicity, certificate, recovery, and concurrency tests |
| `PROTO` | START, OpenFloor, quorum, TTL, and failure tests |
| `MCP` | Daemon discovery, tools, subscriptions, attention, and errors |
| `SIM` | Simulator provenance, kernel, lifecycle, and mixed-runtime tests |
| `INT` | Production-stack and external-harness integration tests |
| `DEFER` | A negative scope assertion that the named guarantee is absent |

## Gate 1 traceability inventory

### Source of truth and system boundaries

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-001 | The complete repository-native freeze merges before simulator landing, scaffolding, or product implementation. | `docs/architecture/first-implementation.md` — Gate 0 | `DOC` |
| G1-DEC-002 | The reading order is design law, current ADR outcomes including retained partially-superseded scope, normative specs, architecture guidance, then historical evidence. | `docs/spec/README.md` — Reading order | `DOC` |
| G1-DEC-003 | ADR status is exactly accepted, partially-superseded, or superseded; replacement lineage is explicit and old bodies remain historical evidence. | `docs/decisions/README.md` — Status and supersession | `DOC` |
| G1-DEC-004 | Every open question is marked resolved, explicitly deferred, or outside Gate 1; a decided question cannot remain open. | `v2/VISION.md` — Open-question register | `DOC` |
| G1-DEC-005 | Drafts are historical input, never a competing implementation source. | `v2/drafts/README.md` | `DOC` |
| G1-DEC-006 | A fresh teammate must reconstruct the design from the exact checked-in candidate and fixed questions without inherited context, author hints, or file pointers. | `AGENTS.md` — Blind teammate review gate | `DOC` |
| G1-DEC-007 | Exact wire facts have one normative owner; other pages link rather than restate a competing contract. | `docs/spec/README.md` — Ownership | `DOC` |
| G1-DEC-008 | The freeze fails on any contradiction or already-decided question presented as open. | `docs/architecture/first-implementation.md` — Acceptance | `DOC` |
| G1-DEC-009 | Every ADR visibly links to a non-normative source-event ledger with native locators, literal human and agent excerpts, mechanical repository effects, and explicit source gaps; it does not reconstruct motive or rationale. | `AGENTS.md` — Decision provenance | `DOC` |
| G1-DEC-010 | Every admitted ADR change is bound to an exact candidate and passes the recorded six-question blind teammate gate before landing. | `AGENTS.md` — Blind teammate review gate | `DOC` |
| G1-DEC-100 | One stack has eight layers in communication and trust regions; guarantees flow up and configuration flows down. | `v2/VISION.md` — The constitution | `ARCH` |
| G1-DEC-101 | Interpretive policy lives at endpoints. The network has no app principals, manifests, hooks, reverse callbacks, or task owners. | `AGENTS.md` — Constitution | `ARCH` |
| G1-DEC-102 | L1 owns identity; L7 institutions are separate services and trust domains. Gate 1 contains no L7 service. | `docs/spec/enforcement.md` — L1/L7 separation | `ARCH`, `DEFER` |
| G1-DEC-103 | L2 owns content-blind, equivocation-free ordered multicast and generic signed-evidence carriage only. | `docs/spec/data-plane.md` — Router guarantees | `L2` |
| G1-DEC-104 | L3 owns conversations, retransmission, deduplication, reconciliation, recovery, action protocols, and durable commit. | `docs/spec/layer-interfaces.md` — L2/L3 boundary | `L3` |
| G1-DEC-105 | L4 supplies task-specific eligibility, quorum, and liveness policy; Gate 1 embeds only OpenFloorV1. | `docs/spec/endpoints/tasks.md` — Gate 1 norm | `PROTO` |
| G1-DEC-106 | Registry, Router, and Ledger are three independent processes. Router and Ledger are siblings coordinated only by endpoints. | `docs/architecture/components.md` — Runtime topology | `ARCH`, `INT` |
| G1-DEC-107 | Gate 1 tolerates Byzantine endpoints but assumes one correct non-equivocating Registry, one correct non-equivocating Router, and one correct durable Ledger. A malicious or equivocating Registry is outside the L1 guarantee. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ARCH`, `ID`, `PROTO` |
| G1-DEC-108 | Registry outage blocks registration and uncached identity resolution; Router or Ledger outage may halt progress. Pinned identity verification, ordering safety, and committed-state safety remain separate from progress claims. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ID`, `PROTO` |
| G1-DEC-109 | Router and Ledger verify only L1 identity and technical bindings and never query institutional policy. | `docs/spec/enforcement.md` — Network admission | `ARCH` |
| G1-DEC-110 | Resource protection is operational quota and abuse control, not institutional policy. | `docs/spec/enforcement.md` — Operational limits | `ARCH` |
| G1-DEC-111 | L2 bodies remain opaque so end-to-end encryption stays possible, but encryption is not required in Gate 1. | `docs/spec/data-plane.md` — Content blindness | `L2`, `DEFER` |

### Identity, encoding, authentication, and identifiers

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-200 | AgentCard is a Moltzap-native immutable X.509 identity artifact. | `docs/spec/identity.md` — AgentCard | `ID` |
| G1-DEC-201 | A card binds AgentId, opaque PrincipalId, immutable AgentName, Ed25519 verification key, issue time, and endpoint routing information. | `docs/spec/identity.md` — Card profile | `ID` |
| G1-DEC-202 | Registry lookup and list return complete immutable cards; no parallel routing-metadata surface exists. | `docs/spec/identity.md` — Resolution | `ID` |
| G1-DEC-203 | AgentName is a Registry-wide unique canonical lowercase mention-safe slug and is never silently normalized. | `docs/spec/identity.md` — Names | `ID` |
| G1-DEC-204 | Local or model-facing AgentName inputs resolve before signed network addressing or fixed-member bindings, which use canonical AgentId; the Registry-signed AgentCard still publishes AgentName. | `docs/spec/identity.md` — Name resolution | `ID`, `WIRE` |
| G1-DEC-205 | Gate 1 has one immutable card and signing key per AgentId; a new key creates a new AgentId. | `docs/spec/identity.md` — Key lifecycle | `ID` |
| G1-DEC-206 | L2 carries AgentId and immutable card thumbprint, not the full card; endpoints resolve and cache cards. | `docs/spec/identity.md` — Card resolution | `ID`, `L2` |
| G1-DEC-207 | Pinned conversation cards permit established conversations during a Registry outage; unseen identities require successful resolution. | `docs/spec/identity.md` — Cache behavior | `ID`, `PROTO` |
| G1-DEC-208 | Registry exposes POST register, lookup, and list operations plus a readiness-only GET health check. | `docs/spec/control-plane.md` — Registry API | `ID`, `WIRE` |
| G1-DEC-209 | Registration is a Registry control operation using a deployment admission code; it never traverses Router, Ledger, daemon MCP, or runtime events. | `docs/spec/identity.md` — Registration bootstrap | `ID` |
| G1-DEC-210 | Registration proves possession of the submitted Ed25519 key with the sole pre-card RFC 9421 bootstrap profile. | `docs/spec/identity.md` — Bootstrap authentication | `ID`, `WIRE` |
| G1-DEC-211 | Registration accepts an opaque PrincipalId and AgentName; the admission code temporarily authorizes that binding. | `docs/spec/identity.md` — Admission policy | `ID` |
| G1-DEC-212 | Agent signing uses a caller-owned, pre-existing, unencrypted Ed25519 PKCS#8 file at an absolute path; registration never generates or copies it. | `docs/spec/cli.md` — Key input | `ID`, `DEFER` |
| G1-DEC-213 | Normal service requests embed the caller AgentCard and authenticate with the same Ed25519 key. | `docs/spec/identity.md` — Normal request authentication | `WIRE` |
| G1-DEC-214 | Normal and bootstrap RFC 9421 profiles cover method, authority, path, query, content digest, content type, and exact protocol header, with created, expires, random nonce, replay rejection, a 300-second window, and mandatory TLS outside the loopback daemon. Registry/Ledger persist nonces through expiry; Router retains all unexpired current-instance nonces and refuses on capacity. | `docs/spec/identity.md` — RFC 9421 profiles | `WIRE` |
| G1-DEC-215 | Router request signatures use domain tag `moltzap-data-v1`; message attribution remains independently signed. | `docs/spec/data-plane.md` — Request authentication | `WIRE`, `L2` |
| G1-DEC-216 | Moltzap-owned signed and request bodies use closed RFC 8949 deterministic CBOR with fixed numeric keys. | `docs/spec/identity.md` — Deterministic encoding | `WIRE` |
| G1-DEC-217 | Decoders reject duplicate or unknown keys, indefinite items, non-preferred numbers, and all unapproved protected or unprotected COSE headers. | `docs/spec/identity.md` — Closed schemas | `WIRE` |
| G1-DEC-218 | L1 attributed messages and L3 endpoint certificates use distinct COSE application profiles and domain contexts. | `docs/spec/identity.md` — COSE profiles | `WIRE` |
| G1-DEC-219 | Router byte-preserves the complete attributed L1 message and never decodes or re-encodes its opaque body. | `docs/spec/data-plane.md` — Message and Delivery | `WIRE`, `L2` |
| G1-DEC-220 | Semantic IDs are opaque 128-bit values: 16 bytes in CBOR and canonical type-prefixed unpadded base64url in JSON, CLI, and logs; digests and thumbprints are full SHA-256. | `docs/spec/identity.md` — Identifier representation | `WIRE` |
| G1-DEC-221 | START ConversationId and genesis TxnId are separately domain-separated SHA-256 derivations over starter AgentId and OperationId, truncated to 128 bits. | `docs/spec/endpoints/daemon.md` — start_conversation | `PROTO`, `WIRE` |
| G1-DEC-222 | Other control-plane mutations use caller AgentId plus OperationId, Router send uses caller AgentId plus MessageId, Ledger append uses conversation/epoch/TxnId, and registration uses SPKI thumbprint plus OperationId. Equality compares canonical operation bytes while each HTTP retry uses fresh RFC 9421 metadata; identical bytes recover and changed bytes conflict within the owning service's durability or retention scope. | `docs/spec/layer-interfaces.md` — Retry identity | `WIRE`, `L3` |
| G1-DEC-223 | Every Registry, Router, and Ledger domain POST carries the exact Moltzap compatibility version and rejects a mismatch; loopback MCP uses its independent MCP revision. | `docs/spec/identity.md` — HTTP request authentication | `WIRE` |
| G1-DEC-224 | Gate 0 freezes carrier and semantic encoding constraints, while a single exact byte catalog and two-implementation vector corpus are a blocking Phase 2A contract deliverable before any product, protocol, simulator-port, client, or server code. Missing assignments are never implementation choices or post-Gate-1 deferrals. | `docs/architecture/first-implementation.md` — Phase 2A exact byte-contract freeze | `DOC`, `WIRE` |

### L2 Router

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-300 | An L2 message has sender AgentId, card thumbprint, explicit recipient AgentIds, MessageId, and opaque signed body. | `docs/spec/data-plane.md` — Message | `L2`, `WIRE` |
| G1-DEC-301 | L2 has no ConversationId, membership, TxnId, action, or route identifier; those meanings remain inside the opaque L3 body. | `docs/spec/data-plane.md` — Layer boundary | `L2`, `ARCH` |
| G1-DEC-302 | The trusted Router assigns one RouterInstanceId and global RouterSequence and delivers identical bytes to every recipient. | `docs/spec/data-plane.md` — Ordering and multicast | `L2` |
| G1-DEC-303 | Router is one in-memory process. Multi-process ordering, persistence, and fork detection are non-conformant in Gate 1. | `docs/spec/data-plane.md` — Fault model | `L2`, `DEFER` |
| G1-DEC-304 | Router exposes POST message send and endpoint-wide delivery poll plus a readiness-only GET health check. | `docs/spec/data-plane.md` — HTTP API | `L2`, `WIRE` |
| G1-DEC-305 | Each authenticated long poll holds for at most 25 seconds and every success returns the authenticated current RouterInstanceId, bounded batch, and opaque PollCursor, including an empty anchor or timeout. | `docs/spec/data-plane.md` — Long polling | `L2` |
| G1-DEC-306 | PollCursor binds RouterInstanceId, authenticated AgentId, and next global feed sequence. | `docs/spec/data-plane.md` — Poll cursor | `L2`, `WIRE` |
| G1-DEC-307 | An omitted cursor atomically anchors at the current tail after Ledger reconciliation and does not replay retained volatile history. | `docs/spec/data-plane.md` — Initial anchor | `L2`, `L3` |
| G1-DEC-308 | Duplicate batches are permitted; the endpoint advances its volatile cursor only after accepting the complete batch. | `docs/spec/data-plane.md` — Batch retry | `L2` |
| G1-DEC-309 | A retained-feed miss returns `feed_gap` with no partial batch; endpoints abandon live folds, reconcile Ledger, and re-anchor. | `docs/spec/data-plane.md` — Feed gap | `L2`, `L3` |
| G1-DEC-310 | Instance mismatch returns `router_restarted` plus the current RouterInstanceId. Daemons also compare every successful poll's returned instance with reconciled epochs, fence mismatches before protocol work, and still permit new STARTs. | `docs/spec/data-plane.md` — Restart fencing | `L2`, `PROTO` |
| G1-DEC-311 | RouterInstanceId is bound into deliveries, L3 messages, epoch descriptors, action bindings, and TranscriptRecords; a fully certified old-instance action may append once. | `docs/spec/layer-interfaces.md` — Instance binding | `L2`, `L3` |
| G1-DEC-312 | L2 owns no durable replay, per-conversation recovery, or offline convergence. | `docs/spec/data-plane.md` — Non-guarantees | `L2`, `DEFER` |
| G1-DEC-313 | A post-commit notice is an ordinary best-effort L2 wake-up hint, never the source of commit truth. | `docs/spec/control-plane.md` — Commit notification and recovery | `L2`, `L3` |
| G1-DEC-314 | Every send names its expected Router instance and declares `initial` or `retry`. A retained identical retry returns its original position, changed L1 bytes conflict, and an absent/evicted retry returns `retry_identity_unknown` without delivery; L3 then re-envelopes the same evidence under a fresh MessageId and recipients deduplicate it. | `docs/spec/data-plane.md` — Send | `L2`, `L3` |

### L3 Transcript and endpoint certification

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-400 | Ledger exposes POST append, read, and conversation list plus a readiness-only GET health check. | `docs/spec/control-plane.md` — Ledger API | `L3`, `WIRE` |
| G1-DEC-401 | Atomic commit is one canonical TranscriptRecord made readable to every fixed member or to none; there are no per-recipient copies or delivery rows. | `docs/spec/control-plane.md` — Atomic commit | `L3` |
| G1-DEC-402 | The committing endpoint is acknowledged only after the ACID transaction commits. | `docs/spec/control-plane.md` — Commit acknowledgement | `L3` |
| G1-DEC-403 | One append transaction reserves idempotency, assigns a dense conversation offset, and advances one hash chain. | `docs/spec/control-plane.md` — Append transaction | `L3` |
| G1-DEC-404 | Each logical record embeds the complete verification evidence needed for offline replay without a live Registry. | `docs/spec/control-plane.md` — Self-contained records | `L3` |
| G1-DEC-405 | Later compression is permitted only if reads reconstruct identical logical records, hashes, and signature preimages. | `docs/spec/control-plane.md` — Physical representation | `L3` |
| G1-DEC-406 | Ledger mechanically verifies canonical bindings, base offset/hash, epoch and Router binding, author, exact fixed-member signer set, embedded cards, and signatures. | `docs/spec/control-plane.md` — Certificate admission | `L3` |
| G1-DEC-407 | Exact signer-set equality is certificate-format validation, not task-quorum or semantic policy evaluation. | `docs/spec/control-plane.md` — Policy blindness | `L3`, `ARCH` |
| G1-DEC-408 | Ledger never evaluates BEGIN precedence, grants, L4 legality, content meaning, or result correctness. | `docs/spec/control-plane.md` — Policy blindness | `L3` |
| G1-DEC-409 | Endpoints validate actions and create the complete certificate before append; invalid attempts remain outside Ledger. | `docs/spec/control-plane.md` — Mechanical admission | `PROTO`, `L3` |
| G1-DEC-410 | One honest required endpoint can prevent invalid certification; unanimously malicious certification is outside the guarantee. | `docs/spec/layer-interfaces.md` — Byzantine boundary | `PROTO` |
| G1-DEC-411 | Only the signed action author may append its completed START or MULTICAST certificate. | `docs/spec/control-plane.md` — Author-only append | `L3` |
| G1-DEC-412 | Author failure after signature collection may leave the action uncommitted; there is no takeover in Gate 1. | `docs/spec/layer-interfaces.md` — Append failure | `L3`, `DEFER` |
| G1-DEC-413 | An ambiguous append is resolved by retrying identical TxnId/certificate or reading that exact transaction. | `docs/spec/control-plane.md` — Ambiguous outcome | `L3` |
| G1-DEC-414 | Every fixed epoch-0 member may read the complete conversation transcript. | `docs/spec/control-plane.md` — Read authorization | `L3` |
| G1-DEC-415 | Missing commit hints recover through periodic conversation-list and per-conversation read-forward reconciliation. | `docs/spec/layer-interfaces.md` — Reconciliation | `L3` |

### Gate 1 conversation and action protocol

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-500 | Gate 1 commits only START and MULTICAST actions under immutable membership epoch 0. | `docs/spec/endpoints/tasks.md` — Action set | `PROTO` |
| G1-DEC-501 | `start_conversation.members` is a nonempty list of other immutable AgentNames; the daemon adds self, resolves AgentIds, and rejects unknown, duplicate, or explicit-self entries. | `docs/spec/endpoints/daemon.md` — start_conversation | `PROTO`, `ID` |
| G1-DEC-502 | START includes its fixed roster and initial nonempty content in one commit; no empty conversation is created. | `docs/spec/endpoints/tasks.md` — START | `PROTO` |
| G1-DEC-503 | Content is a nonempty array whose elements are exactly one closed-union arm, `{text: string}` or `{data: JsonValue}`, with canonical JSON semantics. | `docs/spec/endpoints/tasks.md` — ContentPartV1 | `PROTO`, `WIRE` |
| G1-DEC-504 | Every named endpoint automatically signs a structurally and cryptographically valid START containing itself. | `docs/spec/endpoints/tasks.md` — START consent | `PROTO` |
| G1-DEC-505 | START has no separate invitation, roster pin, preconsent store, BEGIN, or ACK round; unanimous START signatures are its consent evidence. | `docs/spec/endpoints/tasks.md` — START consent | `PROTO` |
| G1-DEC-506 | OpenFloorV1 is the sole built-in Gate 1 norm and makes every fixed member eligible after committed START or MULTICAST state. | `docs/spec/endpoints/tasks.md` — OpenFloorV1 | `PROTO` |
| G1-DEC-507 | Each eligible endpoint may emit BEGIN; the first valid BEGIN in shared L2 order after the committed head is the sole candidate. | `docs/spec/endpoints/tasks.md` — Contention | `PROTO` |
| G1-DEC-508 | Every fixed member may ACK the winning candidate; unanimous ACKs create the reply grant. After reply, every member separately validates and signs the exact proposed action before commit. | `docs/spec/endpoints/tasks.md` — Contention, grant, and action certification | `PROTO` |
| G1-DEC-509 | Any unavailable or withholding member may halt progress; Gate 1 makes no fairness or starvation-freedom claim. | `docs/spec/endpoints/tasks.md` — Liveness | `PROTO` |
| G1-DEC-510 | Each live transaction has one protocol-fixed 90-second local-observation TTL. | `docs/spec/endpoints/tasks.md` — TTL | `PROTO` |
| G1-DEC-511 | Expiry abandons the volatile fold and permits a fresh BEGIN without altering committed records. | `docs/spec/endpoints/tasks.md` — Expiry | `PROTO` |
| G1-DEC-512 | TTL is the only grant lifecycle: there is no explicit pass, abort, renewal, takeover, dispute, or recovery protocol. | `docs/spec/endpoints/tasks.md` — Lifecycle | `PROTO`, `DEFER` |
| G1-DEC-513 | Safety is timing-independent; progress assumes Router, Ledger, and every required member observe and act within the TTL. | `docs/spec/endpoints/tasks.md` — Safety and progress | `PROTO` |
| G1-DEC-514 | L3 retries and deduplicates while an attempt is live. Daemon restart or feed_gap abandons partial work and permits a fresh TxnId for a new established-conversation attempt after reconciliation; START retry retains its OperationId-derived genesis TxnId. Router restart instead fences old-instance conversations. | `docs/spec/layer-interfaces.md` — Recovery | `PROTO`, `L3` |
| G1-DEC-515 | Only completed actions are durable and exactly recoverable; partial coordination is volatile. | `docs/spec/layer-interfaces.md` — Recovery | `L3` |
| G1-DEC-516 | After append, a live author schedules one best-effort commit-hint attempt and may retry; hint failure does not change durable success, and there is no transactional outbox. | `docs/spec/endpoints/tasks.md` — Commit notification | `PROTO`, `L3` |
| G1-DEC-517 | Future L4 protocols must declare membership/fault model, quorum, required availability, timing assumption, and retry condition separately from safety. | `docs/spec/endpoints/tasks.md` — Future protocol contract | `DEFER` |
| G1-DEC-518 | Contacts are future ordinary L4/L5 policy through the shared action-validation seam, not a START-specific mechanism. | `docs/spec/endpoints/screening.md` — Semantic screening | `DEFER` |
| G1-DEC-519 | Addressed-turn eligibility and a deterministic executable NormPin contract are not implemented in Gate 1. | `docs/spec/endpoints/tasks.md` — Deferred norms | `DEFER` |

### Endpoint daemon, model surface, and MCP

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-600 | One independently supervised endpoint daemon owns one AgentId. | `docs/spec/endpoints/daemon.md` — Ownership | `MCP`, `ARCH` |
| G1-DEC-601 | A named profile stores a nonzero stable `mcpPort`; daemon and adapter use `http://127.0.0.1:<mcpPort>/mcp`. Duplicate AgentId profiles and bind fallback are forbidden. | `docs/spec/endpoints/daemon.md` — Process and profile | `MCP` |
| G1-DEC-602 | Gate 1 trusts local processes, binds only loopback, and validates Origin but adds no local authentication. | `docs/spec/endpoints/daemon.md` — Local trust | `MCP`, `DEFER` |
| G1-DEC-603 | Supervision policy is harness-specific; the shared daemon exposes lifecycle and singleton enforcement, not a universal service manager. | `docs/spec/endpoints/daemon.md` — Supervision | `INT` |
| G1-DEC-604 | MCP core is pinned to revision `2026-07-28` at tagged commit `5f5440bb26a62e2cf3440b92da5a667efa03b267`. | `docs/spec/endpoints/daemon.md` — MCP revision | `MCP` |
| G1-DEC-605 | The daemon exposes one POST-only `/mcp`; GET and DELETE are 405. | `docs/spec/endpoints/daemon.md` — Transport | `MCP` |
| G1-DEC-606 | Implement server/discover, tools/list, tools/call, and subscriptions/listen with required request metadata and `resultType`; response `_meta` carries serverInfo, and cacheable discovery/tool-list results use ttlMs 0 and private cache scope. | `docs/spec/endpoints/daemon.md` — MCP transport and discovery | `MCP` |
| G1-DEC-607 | Do not implement initialize, protocol sessions, GET streams, cursors, replay, legacy SSE, protocol ping, or SSE id/event/retry fields. | `docs/spec/endpoints/daemon.md` — Non-features | `MCP`, `DEFER` |
| G1-DEC-608 | Discovery advertises `extensions["xyz.moltzap/events-v1"]={agentId}`; breaking extension changes use a new identifier. | `docs/spec/endpoints/daemon.md` — Discovery | `MCP` |
| G1-DEC-609 | tools/list is exactly `start_conversation` and `reply`; there is no generic send or dynamic per-action tool in Gate 1. | `docs/spec/endpoints/daemon.md` — Tools | `MCP` |
| G1-DEC-610 | Direct start calls require OperationId; OpenClaw and NanoClaw generate one per native invocation and reuse it across retries. | `docs/spec/endpoints/daemon.md` — Start idempotency | `MCP` |
| G1-DEC-611 | `reply` selects one stable legal-action descriptor and supplies its payload for a live TxnId; the engine revalidates before compiling messages. | `docs/spec/endpoints/daemon.md` — Reply | `MCP`, `PROTO` |
| G1-DEC-612 | Legal-action descriptors contain stable id, description, and closed JSON Schema. | `docs/spec/endpoints/daemon.md` — Action descriptors | `MCP` |
| G1-DEC-613 | A listen request declares the extension capability and exact filter `{"xyz.moltzap/turnReady":true}`. | `docs/spec/endpoints/daemon.md` — Subscription request | `MCP` |
| G1-DEC-614 | The daemon emits `notifications/subscriptions/acknowledged` first and echoes the filter, then emits `notifications/xyz.moltzap/turn_ready`; each carries the core subscriptionId metadata. | `docs/spec/endpoints/daemon.md` — Subscription stream | `MCP` |
| G1-DEC-615 | Exactly one turn-ready listener owns a daemon. A racing listener receives HTTP 409, JSON-RPC -32000, and `subscription_in_use` before SSE opens; missing capability uses -32021. | `docs/spec/endpoints/daemon.md` — Listener ownership | `MCP` |
| G1-DEC-616 | Graceful server close returns a complete result; client disconnect cancels without a final response; optional SSE comments are transport-only keepalive. | `docs/spec/endpoints/daemon.md` — Stream close | `MCP` |
| G1-DEC-617 | Turn-ready is emitted only after a live reply grant exists; if no legal reply can be granted, the runtime is not invoked. | `docs/spec/endpoints/daemon.md` — Grant gating | `MCP`, `PROTO` |
| G1-DEC-618 | A turn event carries TxnId, expiry, ordered unseen current records, legal actions, and deterministically grouped full-content unseen records from other conversations. | `docs/spec/endpoints/daemon.md` — Turn payload | `MCP` |
| G1-DEC-619 | Attention is at-most-once: a snapshot records every included watermark's expected old value/version, then immediately before one SSE write a single SQLite transaction compare-and-swaps all of them or advances none. | `docs/spec/endpoints/daemon.md` — Attention durability | `MCP` |
| G1-DEC-620 | A failed, partial, or ambiguous write after that commit may lose the turn permanently and never triggers replay. | `docs/spec/endpoints/daemon.md` — Loss semantics | `MCP` |
| G1-DEC-621 | With no stream, no watermark is consumed until a write attempt; expiry permits a fresh grant. After consumption, that base-head input is never offered again to that AgentId. | `docs/spec/endpoints/daemon.md` — Grant without listener | `MCP`, `PROTO` |
| G1-DEC-622 | Persist applied Ledger offsets, current/cross-conversation attention watermarks, and completed `reply` receipts. Live transactions, folds, events, subscriptions, and Router cursor are volatile; START recovery uses deterministic identifiers instead of a receipt. | `docs/spec/endpoints/daemon.md` — SQLite state | `MCP`, `L3` |
| G1-DEC-623 | Serialize grants/model turns within a conversation. One short-lived subscription writer serializes watermark reservation and complete SSE frame bytes, but there is no daemon-wide cross-conversation protocol or model-turn cap. | `docs/spec/endpoints/daemon.md` — Concurrency | `MCP` |
| G1-DEC-624 | The full cross-conversation snapshot has no batching, truncation, record-count, or total-byte bound in Gate 1. | `docs/spec/endpoints/daemon.md` — Snapshot bounds | `MCP`, `DEFER` |
| G1-DEC-625 | Harness queue and steer options affect presentation within one granted batch only; exactly one reply consumes it. | `docs/spec/endpoints/daemon.md` — Adapter law | `MCP`, `INT` |
| G1-DEC-626 | Tool execution failures expose only `txn_expired`, `txn_consumed`, `action_not_legal`, `idempotency_conflict`, and `refused`; malformed MCP uses protocol errors. | `docs/spec/endpoints/daemon.md` — Errors | `MCP` |
| G1-DEC-627 | Tool success is returned only after Ledger acknowledgement and contains ConversationId, TxnId, LedgerOffset, and RecordHash. | `docs/spec/endpoints/daemon.md` — Durable success | `MCP`, `L3` |
| G1-DEC-628 | Gate 1 exposes no asynchronous MCP task handle. | `docs/spec/endpoints/daemon.md` — Durable success | `MCP`, `DEFER` |
| G1-DEC-629 | OpenClaw `startAccount` owns daemon spawn, readiness/identity check, sole subscription, graceful termination, escalation, and exit wait; Gate 1 has no gateway-global, external-only, or attach-to-preexisting ownership mode. | `docs/spec/endpoints/daemon.md` — OpenClaw | `INT` |
| G1-DEC-630 | NanoClaw uses one persistent AgentId container with the daemon and no protocol-level cap on isolated per-conversation workers. Persistent mounts hold keys, profiles, markers, and worker state; the stock per-session idle reaper does not own this container. | `docs/spec/endpoints/daemon.md` — NanoClaw | `INT` |
| G1-DEC-631 | Runtime bridges translate turn-ready into native model input and prevent native final output from bypassing `reply`. | `docs/spec/endpoints/daemon.md` — Runtime adapters | `INT` |
| G1-DEC-632 | A lost HTTP success after committed `reply` is recovered by an identical retry from the completed receipt or Ledger reconciliation; changed action or payload bytes under that TxnId conflict and cannot append again. | `docs/spec/endpoints/daemon.md` — Tool completion | `MCP`, `L3` |
| G1-DEC-633 | A lost HTTP success after committed `start_conversation` is recovered by deriving the same ConversationId and TxnId from AgentId/OperationId and reading the exact START; changed members or content conflict against a live or committed START, while changed intent after forgotten uncommitted abandonment requires a fresh OperationId. | `docs/spec/endpoints/daemon.md` — start_conversation | `MCP`, `L3` |
| G1-DEC-634 | A stale attention-watermark expectation rolls back every proposed advance, rebuilds while the grant remains live, and omits already consumed records. Grant expiry during rebuild advances nothing and writes no frame. | `docs/spec/endpoints/daemon.md` — Attention durability | `MCP` |

### Packages, implementation substrate, and simulator

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-700 | V2 has exactly six deep packages: identity, transport, transcript, endpoint, simulator, and testbed. | `docs/spec/layer-interfaces.md` — Package map | `ARCH` |
| G1-DEC-701 | Production dependencies are transport→identity, transcript→identity+transport contracts, and endpoint→identity+transport+transcript. Simulator uses identity and endpoint public capabilities; testbed may use all five. | `docs/spec/layer-interfaces.md` — Dependency graph | `ARCH` |
| G1-DEC-702 | Identity, transport, transcript, and endpoint each own public contracts, concrete implementation, and runnable binaries. | `docs/spec/layer-interfaces.md` — Package graph and binaries | `ARCH` |
| G1-DEC-703 | Binaries are `moltzap-directory`, `moltzap-router`, `moltzap-ledger`, `moltzap-agentd`, and `moltzap`. | `docs/spec/layer-interfaces.md` — Binaries | `ARCH` |
| G1-DEC-704 | Production exports are `.` and `./server`; simulator exports `.`, `./adapter`, and `./ledger`; testbed exports `.`. | `docs/spec/layer-interfaces.md` — Exports | `ARCH` |
| G1-DEC-705 | Wire, protocol, endpoint-core, daemon-api, CLI, harness-adapter, and conformance are not packages. | `docs/spec/layer-interfaces.md` — Information hiding | `ARCH` |
| G1-DEC-706 | No production package depends on simulator or testbed, and no `v2/*` package imports `packages/*`. | `docs/spec/layer-interfaces.md` — Isolation laws | `ARCH` |
| G1-DEC-707 | Deep packages expose capabilities and guarantees while hiding mechanisms, use cohesive services and root-composed Layers, and avoid shallow per-method port/accessor packages. | `docs/architecture/components.md` — Deep-module design rules | `ARCH` |
| G1-DEC-708 | One CalVer value in `v2/VERSION` exactly matches all six manifests and Moltzap wire compatibility. | `docs/spec/layer-interfaces.md` — Versioning | `ARCH`, `WIRE` |
| G1-DEC-709 | MCP revision and simulator definition/event/RunLedger persisted-schema versions remain independent of `v2/VERSION`. | `docs/spec/layer-interfaces.md` — Independent versions | `ARCH` |
| G1-DEC-710 | Registry and Ledger use native Effect SQL with PostgreSQL; fast tests use the same PostgreSQL client through PGlite socket. | `docs/architecture/first-implementation.md` — Persistence | `ARCH`, `L3` |
| G1-DEC-711 | Real PostgreSQL Testcontainers are mandatory for concurrency, isolation, and atomicity properties. | `docs/architecture/first-implementation.md` — Database tests | `L3` |
| G1-DEC-712 | Each daemon owns one SQLite file. Router state is in memory; restart loses its feeds, creates a new instance, fences old-instance conversations, and still permits new STARTs. | `docs/architecture/first-implementation.md` — Endpoint and transport persistence | `ARCH` |
| G1-DEC-713 | V2 owns the one simulator kernel, runtime roster, EventCatalog, and typed run-evidence RunLedger. | `docs/architecture/first-implementation.md` — Simulator | `SIM` |
| G1-DEC-714 | Preserve `Simulator.define`, immutable definition identity, closed typed EventCatalog, scoped runtime roster/lifecycle, and RunLedger/LedgerStorage while replacing v1 protocol-facing ports with v2 public capabilities. | `docs/architecture/first-implementation.md` — Port contract | `SIM` |
| G1-DEC-715 | Simulator owns and root-exports StackProvider; testbed supplies its production Live Layer, focused tests supply fake Layers, runtimes receive EndpointProfileRef, and run-evidence RunLedger remains separate from product Transcript. | `docs/spec/layer-interfaces.md` — StackProvider | `SIM`, `ARCH` |
| G1-DEC-716 | Do not port legacy `launchTestbed`, public v1 protocol types, grading/YAML DSLs, or Node child-process/external-runtime details into `simulator`. | `docs/architecture/first-implementation.md` — Do-not-port list | `SIM`, `ARCH` |
| G1-DEC-717 | Simulator porting starts only from a fully tracked, constitution-aligned, landed-green immutable SHA recorded in the repository handoff. | `docs/architecture/first-implementation.md` — Simulator provenance gate | `SIM` |
| G1-DEC-718 | The old simulator becomes a temporary compatibility facade or is retired; two simulator engines never run in parallel. | `docs/architecture/first-implementation.md` — Cutover | `SIM` |
| G1-DEC-719 | Testbed owns platform acquisition, supervision, fault layers, external-process constructors, substitutes, and black-box subjects, never production service implementations. | `docs/spec/layer-interfaces.md` — Testbed | `ARCH`, `SIM` |
| G1-DEC-720 | OpenClaw, NanoClaw, and eval packages remain external consumers of v2 public interfaces. | `docs/architecture/first-implementation.md` — Non-negotiable boundaries | `INT` |

## Explicit deferrals

The rows below exhaustively group every item named by a normative
chapter's `Explicitly deferred` section. A spec-local deferral absent
from this inventory is a freeze defect. Phase 2A byte assignments are
not in this table because they block Gate 1 implementation rather than
moving beyond Gate 1.

| ID | Deferred beyond Gate 1 | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-800 | Router replication, multi-process ordering, Byzantine sequencing, and fork detection. | `docs/spec/data-plane.md` — Deferred guarantees | `DEFER` |
| G1-DEC-801 | Tolerance of a malicious or equivocating Registry; card/key rotation, historical-card lookup, revocation, identity recovery, encrypted keys, keychains, HSMs, and external signers. | `docs/spec/identity.md` — Explicitly deferred | `DEFER` |
| G1-DEC-802 | L7 institution services, statement vocabularies, and governance effects. | `v2/VISION.md` — Open-question register | `DEFER` |
| G1-DEC-803 | Dynamic membership, membership/key epoch transitions, and history authorization across changing membership or witness/monitor readers. | `docs/spec/endpoints/tasks.md` — Deferred membership | `DEFER` |
| G1-DEC-804 | Executable user-provided L4 norms, deterministic NormPin semantics, non-unanimous quorums, and addressed turns. | `docs/spec/endpoints/tasks.md` — Future norms | `DEFER` |
| G1-DEC-805 | Fairness and starvation-freedom guarantees. | `docs/spec/endpoints/tasks.md` — Liveness non-guarantees | `DEFER` |
| G1-DEC-806 | Append takeover, exact-attempt recovery, pass/abort/renewal, and append-only dispute protocols and remedies. | `docs/spec/endpoints/tasks.md` — Future lifecycle | `DEFER` |
| G1-DEC-807 | Semantic L5 conformance across MCP and contacts policy. | `docs/spec/endpoints/screening.md` — Deferred screening | `DEFER` |
| G1-DEC-808 | Local daemon authentication, hostile-host defense, dynamic port discovery, attach-to-existing ownership, and a universal daemon supervisor. | `docs/spec/endpoints/daemon.md` — Deferred local operations | `DEFER` |
| G1-DEC-809 | MCP event acknowledgement/replay, cursors, GET subscription streams, webhooks, resource wakeups, asynchronous tool-task handles, and dynamic per-action tools. | `docs/spec/endpoints/daemon.md` — Deferred MCP surface | `DEFER` |
| G1-DEC-810 | A transactional outbox for commit hints. | `docs/spec/endpoints/tasks.md` — Commit notification | `DEFER` |
| G1-DEC-811 | Protocol-negotiated resource maxima. Services still require bounded local decoding, pages, polls, retention, caches, and requests; cross-conversation turns and snapshots are deliberate unbounded exceptions. | `docs/architecture/first-implementation.md` — Resource posture | `DEFER` |
| G1-DEC-812 | Raw bytes, URLs, media types, filenames, metadata, files, images, and audio in action content. | `docs/spec/endpoints/tasks.md` — Deferred content | `DEFER` |
| G1-DEC-813 | A required end-to-end encryption or key-distribution profile. The content-blind boundary preserves the option. | `docs/spec/data-plane.md` — Encryption posture | `DEFER` |
| G1-DEC-814 | npm publishing, bundling, deployment, production cutover, retrofitting v1, and v1 retirement. | `docs/architecture/first-implementation.md` — Non-goals | `DEFER` |
| G1-DEC-815 | Delegation evidence and peer-card custody. | `docs/spec/identity.md` — Deferred identity lifecycle | `DEFER` |
| G1-DEC-816 | Persistent feeds, offline convergence, transparent Router restart, and network-push transports. | `docs/spec/data-plane.md` — Deferred guarantees | `DEFER` |
| G1-DEC-817 | Public observer reads, Ledger replication, and transparent physical Transcript compression. | `docs/spec/control-plane.md` — Deferred storage and readers | `DEFER` |
| G1-DEC-818 | Final CLI command naming, interactive prompts, and remote daemon administration. | `docs/spec/cli.md` — Deferred CLI surface | `DEFER` |
| G1-DEC-819 | A daemon-wide cross-conversation concurrency cap and bounded/truncated cross-conversation snapshots. Gate 1 deliberately ships neither. | `docs/spec/endpoints/daemon.md` — Deferred resource bounds | `DEFER` |
| G1-DEC-820 | Semantic screening protocol, model-judgment testimony, institution/policy composition and distribution, contacts enforcement, and portable cross-harness L5 conformance. | `docs/spec/endpoints/screening.md` — Deferred screening | `DEFER` |
| G1-DEC-821 | The post-Gate-1 action vocabulary, externally distributed norm bundles, and per-action tools. | `docs/spec/endpoints/tasks.md` — Deferred norms and vocabulary | `DEFER` |
| G1-DEC-822 | An L6 monitor runtime. | `docs/architecture/first-implementation.md` — Explicit deferrals | `DEFER` |
| G1-DEC-823 | FROST signature compression. | `docs/spec/endpoints/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-824 | Non-unanimous action certificates. | `docs/spec/control-plane.md` — Explicitly deferred | `DEFER` |

## Gate 0 review record

An earlier cold-reader pass reported **PASS, 13/13 review dimensions**
with all 177 traceability rows and all 25 explicit-deferral rows
reconciled. That run did not preserve its exact candidate identity,
questions, unedited answers, discovery trail, reviewer isolation, or
maintainer disposition. It is legacy evidence and does not satisfy the
root blind teammate review gate.

Gate 0 readiness is established only by the latest maintainer-accepted
`*-cold-review.md` artifact under `docs/decision-evidence/` that is
bound to the exact candidate revision. The review artifact, rather than
an unstructured PASS claim in this ADR, owns the current gate result.

Repository evidence:

| Check | Result |
|---|---|
| Legacy independent review | Reported PASS — not current blind-gate evidence |
| `pnpm format:check` | PASS |
| `pnpm docs:check:mermaid` | PASS — 32 Mermaid blocks across 261 files |
| `mise x node@22.23.1 -- pnpm docs:check` | PASS — no broken links |
| `pnpm lint` | PASS — architecture scan, Knip guard, ESLint, Nx lint, and Oxlint |
| `pnpm typecheck` | PASS — all six current v1 Nx build targets |
| `pnpm docs:generate` | PASS — the before/after docs diff digest was identical |
| `git diff --check` | PASS |

The MCP pin was checked against the official `2026-07-28` tag at commit
`5f5440bb26a62e2cf3440b92da5a667efa03b267`.

This record reviews the freeze content; it does not invent a landing
commit. The simulator handoff remains `pending upstream landing` with
its source SHA `_unset_`, and Phase 1 remains blocked until this reviewed
state is committed and merged on `main`.

## Consequences

Implementation may rely on every row above and must not silently fill a
deferred cell. Any change to a frozen decision requires a new accepted
record and an explicit update to this inventory, its normative owner,
and its acceptance evidence.
