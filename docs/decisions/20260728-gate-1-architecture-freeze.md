---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260729-v2-authority-lives-with-v2.md
---

# Gate 1 starts with a repository-native architecture freeze

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-gate-1-architecture-freeze), [Registry trust selection](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#registry-trust-assumption), [V2 authority replacement](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#v2-authority-lives-with-v2), [L1/L2 representation replacements](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#representations-are-layer-owned), and [L1/L2 scope correction](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#l1-and-l2-only-scope).

## Supersession

The repository-native authority chain, explicit ADR lineage, stable
`G1-DEC-NNN` traceability inventory, acceptance-owner categories,
contradiction-free gate, and blind teammate review requirement remain
current. The layer constitution, trust and fault assumptions, L3 and
later semantics, daemon MCP surface, and explicit deferrals remain
current except where a row below now states a narrower replacement.

`20260729-v2-authority-lives-with-v2.md` replaces the requirement that
this freeze merge first on `main`: V2 authority is complete on the V2
track. `20260729-representations-are-layer-owned.md`,
`20260729-identity-uses-jcs-jose-authenticated-http.md`, and
`20260729-router-order-is-opaque.md` replace the cross-layer wire
catalog, X.509/CBOR/COSE profile, mandatory application TLS, exposed
Router order, `transport` package, and related L1/L2 rows. The updated
inventory below points to the current normative owners. These
replacements leave L3, L4, endpoint-daemon, and MCP semantic documents
and ADR outcomes unchanged and assign no later-layer replacement
representation.

{/* @bake-constants: V2_PROTOCOL_VERSION */}

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

- `20260729-v2-authority-lives-with-v2.md`
- `20260729-representations-are-layer-owned.md`
- `20260729-identity-uses-jcs-jose-authenticated-http.md`
- `20260729-router-order-is-opaque.md`
- `20260728-adrs-link-source-events-and-require-blind-review.md`
- `20260728-layer-boundaries-and-fault-model.md`
- `20260728-simulator-is-the-system-driver.md`

The explicitly retained portions of the partially-superseded identity,
network, package, Transcript, OpenFloorV1, daemon, model-surface,
monitor, freeze, and code-first simulator records remain current and
point to their replacements.

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
| `WIRE` | Independently produced interoperability examples, strict decoding, authentication, and retry tests |
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
| G1-DEC-001 | The complete L1/L2 authority candidate—ADRs, lineage, traceability, normative specifications, and architecture guidance—lands atomically and passes the blind teammate gate before L1/L2 product implementation. | `docs/architecture/l1-l2-implementation-ask.md` — Authority gate | `DOC` |
| G1-DEC-002 | V2 reads authority from agent law and `v2/VISION.md`, current ADR outcomes including retained partially-superseded scope, normative specifications, architecture guidance, then historical evidence, all on the V2 track. | `v2/VISION.md` — Authority | `DOC` |
| G1-DEC-003 | ADR status is exactly accepted, partially-superseded, or superseded; replacement lineage is explicit and old bodies remain historical evidence. | `docs/decisions/README.md` — Status and supersession | `DOC` |
| G1-DEC-004 | Every open question is marked resolved, explicitly deferred, or outside Gate 1; a decided question cannot remain open. | `v2/VISION.md` — Open-question register | `DOC` |
| G1-DEC-005 | Drafts are historical input, never a competing implementation source. | `v2/drafts/README.md` | `DOC` |
| G1-DEC-006 | A fresh teammate must reconstruct the design from the exact checked-in candidate and fixed questions without inherited context, author hints, or file pointers. | `AGENTS.md` — Blind teammate review gate | `DOC` |
| G1-DEC-007 | Every exact L1/L2 representation fact has one normative owner at the layer that owns the public concept; no cross-layer wire catalog or shared vector-corpus abstraction is current. | `docs/spec/README.md` — L1 and L2 representation readiness | `DOC` |
| G1-DEC-008 | The authority gate fails on any contradiction, broken lineage, missing layer-owned representation, or already-decided question presented as open. | `docs/architecture/l1-l2-implementation-ask.md` — Authority gate | `DOC` |
| G1-DEC-009 | Every ADR visibly links to a non-normative source-event ledger with native locators, literal human and agent excerpts, mechanical repository effects, and explicit source gaps; it does not reconstruct motive or rationale. | `AGENTS.md` — Decision provenance | `DOC` |
| G1-DEC-010 | Every admitted ADR change is bound to an exact candidate and passes the recorded six-question blind teammate gate before landing. | `AGENTS.md` — Blind teammate review gate | `DOC` |
| G1-DEC-100 | One stack has eight layers in communication and trust regions; guarantees flow up and configuration flows down. | `v2/VISION.md` — The constitution | `ARCH` |
| G1-DEC-101 | Interpretive policy lives at endpoints. The network has no app principals, manifests, hooks, reverse callbacks, or task owners. | `AGENTS.md` — Constitution | `ARCH` |
| G1-DEC-102 | L1 owns identity; L7 institutions are separate services and trust domains. Gate 1 contains no L7 service. | `docs/spec/enforcement.md` — L1/L7 separation | `ARCH`, `DEFER` |
| G1-DEC-103 | L2 owns content-blind, equivocation-free ordered multicast and generic signed-evidence carriage only. | `docs/spec/router.md` — Router guarantees | `L2` |
| G1-DEC-104 | L3 owns conversations, retransmission, deduplication, reconciliation, recovery, action protocols, and durable commit. | `docs/spec/layer-interfaces.md` — L2/L3 boundary | `L3` |
| G1-DEC-105 | L4 supplies task-specific eligibility, quorum, and liveness policy; Gate 1 embeds only OpenFloorV1. | `docs/spec/endpoints/tasks.md` — Gate 1 norm | `PROTO` |
| G1-DEC-106 | Registry, Router, and Ledger are three independent processes. Router and Ledger are siblings coordinated only by endpoints. | `docs/architecture/components.md` — Runtime topology | `ARCH`, `INT` |
| G1-DEC-107 | Gate 1 tolerates Byzantine endpoints but assumes one correct non-equivocating Registry, one correct non-equivocating Router, and one correct durable Ledger. A malicious or equivocating Registry is outside the L1 guarantee. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ARCH`, `ID`, `PROTO` |
| G1-DEC-108 | Registry outage blocks registration and uncached identity resolution; Router or Ledger outage may halt progress. Pinned identity verification, ordering safety, and committed-state safety remain separate from progress claims. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ID`, `PROTO` |
| G1-DEC-109 | Router and Ledger verify only L1 identity and technical bindings and never query institutional policy. | `docs/spec/enforcement.md` — Network admission | `ARCH` |
| G1-DEC-110 | Resource protection is operational quota and abuse control, not institutional policy. | `docs/spec/enforcement.md` — Operational limits | `ARCH` |
| G1-DEC-111 | L2 bodies remain opaque so end-to-end encryption stays possible, but encryption is not required in Gate 1. | `docs/spec/router.md` — Content blindness | `L2`, `DEFER` |

### Identity, encoding, authentication, and identifiers

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-200 | AgentCard is a MoltZap-native immutable Registry-attested artifact: one exact JCS payload in one attached General JWS with one Ed25519 signature. | `docs/spec/identity-representation.md` — AgentCard | `ID`, `WIRE` |
| G1-DEC-201 | AgentCard binds exactly the MoltZap version, AgentId, opaque PrincipalId, immutable AgentName, exact Ed25519 public JWK, and whole-second issue time; it contains no service route, certificate chain, policy, active status, contact data, or extension bag. | `docs/spec/identity-representation.md` — AgentCard payload | `ID`, `WIRE` |
| G1-DEC-202 | Registry public lookup and list return complete immutable AgentCards; no parallel thin identity or routing-metadata surface exists. | `docs/spec/identity.md` — Resolution | `ID` |
| G1-DEC-203 | AgentName is Registry-wide unique and exactly 3–32 lowercase letters, digits, or single interior hyphens matching `^[a-z0-9]+(-[a-z0-9]+)*$`; input is never normalized. | `docs/spec/identity-representation.md` — AgentName | `ID`, `WIRE` |
| G1-DEC-204 | Human-facing AgentName inputs resolve before signed network addressing or fixed-member bindings, which use canonical AgentId; AgentCard still publishes AgentName. | `docs/spec/identity.md` — Name resolution | `ID`, `WIRE` |
| G1-DEC-205 | Gate 1 has one immutable AgentCard and one Ed25519 agent key per AgentId; a different key creates a different AgentId. | `docs/spec/identity.md` — Key lifecycle | `ID` |
| G1-DEC-206 | SignedMessage carries sender AgentId and AgentCardDigest, not the full card; endpoints and Router resolve and positively cache complete immutable AgentCards. | `docs/spec/identity.md` — Card resolution | `ID`, `L2` |
| G1-DEC-207 | Pinned cards permit established work during Registry outage; a previously unseen identity requires successful resolution. | `docs/spec/identity.md` — Cache behavior | `ID`, `PROTO` |
| G1-DEC-208 | Registry exposes `POST /v1/identities:register`, `POST /v1/identities:lookup`, `POST /v1/identities:list`, and readiness-only `GET /healthz`; lookup and list are public unauthenticated reads. | `docs/spec/identity.md` — Registry API | `ID`, `WIRE` |
| G1-DEC-209 | Registration is a Registry control operation using a deployment admission credential; it never traverses Router, Ledger, daemon MCP, or runtime events. | `docs/spec/identity.md` — Registration | `ID` |
| G1-DEC-210 | Registration proves possession of the submitted Ed25519 public JWK through the sole pre-card `AuthenticatedHttp` RFC 9421 bootstrap profile. | `docs/spec/identity-representation.md` — Registration authentication | `ID`, `WIRE` |
| G1-DEC-211 | Registration accepts caller-supplied OperationId, opaque PrincipalId, AgentName, and exact Ed25519 public JWK; the admission credential authorizes that attempt. | `docs/spec/identity.md` — Registration | `ID`, `WIRE` |
| G1-DEC-212 | Agent signing uses a caller-owned pre-existing unencrypted Ed25519 PKCS#8 file named by absolute path; registration never generates or copies it, and private material is redacted at every boundary. | `docs/spec/identity.md` — Private key input | `ID`, `DEFER` |
| G1-DEC-213 | Normal authenticated bodies carry `callerAgentId`; `AuthenticatedHttp` resolves its immutable AgentCard and verifies with that card's key. Requests do not embed AgentCard. | `docs/spec/identity-representation.md` — Normal authentication | `WIRE` |
| G1-DEC-214 | The exact normal and registration RFC 9421 profiles bind method, authority, path, query, content digest, content type, MoltZap version, and registration authorization where applicable; require exact signature parameters, a 300-second maximum window, five-second future skew, 16-byte nonce, and atomic replay claim. Application TLS is a deployment concern; admission-bearing deployments protect the credential in transit, and deployments supply response-path integrity when their threat model includes network-path tampering. | `docs/spec/identity-representation.md` — AuthenticatedHttp | `WIRE` |
| G1-DEC-215 | Normal Registry/Router request signatures use label `moltzap` and tag `moltzap-request-v1`; registration uses tag `moltzap-registration-v1`. SignedMessage attribution remains independently verifiable. | `docs/spec/identity-representation.md` — HTTP message signatures | `WIRE`, `L2` |
| G1-DEC-216 | MoltZap-owned L1 signed artifacts and Registry/Router request and result bodies use exact closed JSON; signed logical values use RFC 8785 JCS. | `docs/spec/identity-representation.md` — Canonical JSON | `WIRE` |
| G1-DEC-217 | Decoders reject duplicate or unknown fields, noncanonical JSON where canonical form is required, noncanonical base64url, extra JWS fields or signatures, unprotected headers, and any unapproved JOSE header or algorithm. | `docs/spec/identity-representation.md` — Strict decoding | `WIRE` |
| G1-DEC-218 | AgentCard and SignedMessage use distinct exact General-JWS `typ` values and closed payload schemas. This L1 decision does not change the L3 certificate contract. | `docs/spec/identity-representation.md` — JOSE profiles | `WIRE` |
| G1-DEC-219 | Router byte-preserves the complete SignedMessage and never interprets, decodes, or re-encodes its opaque body. | `docs/spec/router.md` — Content blindness | `WIRE`, `L2` |
| G1-DEC-220 | AgentId, PrincipalId, OperationId, and MessageId are identity-owned exact type-prefixed canonical unpadded base64url encodings of 16 bytes. AgentCardDigest is an identity-owned full SHA-256 value; SignedMessageDigest is the Router-owned full SHA-256 equality receipt. | `docs/spec/identity-representation.md`, `docs/spec/router-representation.md` — Refined values | `WIRE` |
| G1-DEC-221 | START ConversationId and genesis TxnId are separately domain-separated SHA-256 derivations over starter AgentId and OperationId, truncated to 128 bits. This L1/L2 revision does not change that L3 contract. | `docs/spec/endpoints/daemon.md` — start_conversation | `PROTO`, `WIRE` |
| G1-DEC-222 | Registry idempotency uses submitted-key JWK thumbprint plus OperationId and exact canonical inner request bytes; Router retry identity uses authenticated sender AgentId plus MessageId and complete SignedMessage equality. Fresh RFC 9421 attempt metadata is excluded. L3 retry representation remains with L3. | `docs/spec/layer-interfaces.md` — Retry identity | `WIRE`, `ID`, `L2` |
| G1-DEC-223 | Every authenticated Registry and Router domain POST carries and signs the exact MoltZap compatibility version and rejects mismatch after successful authentication. This L1/L2 row does not change the existing Ledger or independent MCP version contracts. | `docs/spec/identity-representation.md` — Version binding | `WIRE` |
| G1-DEC-224 | The separate L1 and L2 representation chapters and their traceability must be complete before L1/L2 implementation; no cross-layer catalog or shared vector-corpus deliverable blocks either layer. | `docs/spec/README.md` — L1 and L2 representation readiness | `DOC`, `WIRE` |
| G1-DEC-225 | `docs/spec/identity-representation.md` assigns exact L1 values, JCS/JOSE artifacts, AuthenticatedHttp, Registry representation, and envelope failures; `docs/spec/router-representation.md` assigns exact L2 values, requests, results, and PollCursor. An absent in-scope fact is an owner-chapter defect. This row makes no later-layer representation decision. | `docs/spec/README.md` — L1 and L2 representation readiness | `WIRE` |

### L2 Router

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-300 | SignedMessage names sender AgentId, AgentCardDigest, explicit canonically ordered recipient AgentIds, MessageId, and opaque body bytes in a self-contained signed artifact. | `docs/spec/router.md` — SignedMessage boundary | `L2`, `WIRE` |
| G1-DEC-301 | L2 has no ConversationId, membership, TxnId, action, route identifier, persistence, replay, or recovery meaning; any such meaning remains inside the opaque body and is owned by L3 endpoints. | `docs/spec/router.md` — Layer boundary | `L2`, `ARCH` |
| G1-DEC-302 | One correct non-equivocating Router assigns a private global bigint order and multicasts identical SignedMessage bytes; no RouterSequence or internal order appears in the public protocol. | `docs/spec/router.md` — Ordering and multicast | `L2` |
| G1-DEC-303 | Router is one bounded in-memory process with one global count-and-byte-bounded feed and coupled retry index. Restart loses all process-local state and creates a fresh RouterInstanceId and cursor key; persistence, multi-process ordering, replication, and fork detection are absent. | `docs/spec/router.md` — State and fault model | `L2`, `DEFER` |
| G1-DEC-304 | Router exposes `POST /v1/messages:send`, endpoint-wide `POST /v1/messages:poll`, and local-readiness-only `GET /healthz`. Router health does not query Registry. | `docs/spec/router.md` — HTTP API | `L2`, `WIRE` |
| G1-DEC-305 | An authenticated held poll waits at most 25 seconds and returns a bounded ordered `batch` with current RouterInstanceId and opaque PollCursor, or a closed `feed_gap` or `cursor_invalid` result. | `docs/spec/router.md` — Long polling | `L2` |
| G1-DEC-306 | PollCursor is a client-held opaque Compact JWE binding authenticated AgentId, current RouterInstanceId, and the last scanned private order; no server-side cursor state exists. | `docs/spec/router-representation.md` — PollCursor | `L2`, `WIRE` |
| G1-DEC-307 | An omitted cursor returns an immediate empty batch anchored at the current tail and does not replay retained volatile history. | `docs/spec/router.md` — Initial anchor | `L2`, `L3` |
| G1-DEC-308 | Continuation scans strictly after the cursor, advances past unrelated messages, preserves global order, and does not skip the first addressed message that would exceed a count or byte bound. Duplicate batches remain permissible until the client accepts and retains the returned cursor. | `docs/spec/router.md` — Continuation | `L2` |
| G1-DEC-309 | A cursor behind global eviction returns conservative `feed_gap` with no partial batch; endpoints abandon live folds, reconcile Ledger, and re-anchor. | `docs/spec/router.md` — Feed gap | `L2`, `L3` |
| G1-DEC-310 | Send checks expected RouterInstanceId immediately after `AuthenticatedHttp` and returns `router_restarted` with the current instance before SignedMessage resolution or feed work. Poll cursor tamper, caller/instance mismatch, future order, malformed plaintext, noncanonical decimal, or old key returns `cursor_invalid` without disclosing the current instance. | `docs/spec/router.md` — Instance fencing | `L2`, `PROTO` |
| G1-DEC-311 | RouterInstanceId remains the L2 restart fence consumed by L3 epoch descriptors, action bindings, and TranscriptRecords; a fully certified old-instance action may append once. Router does not interpret those L3 bindings. | `docs/spec/layer-interfaces.md` — Instance binding | `L2`, `L3` |
| G1-DEC-312 | L2 owns no durable replay, recipient advancement, per-conversation recovery, offline convergence, or restart-transparent liveness. | `docs/spec/router.md` — Non-guarantees | `L2`, `DEFER` |
| G1-DEC-313 | A post-commit notice is an ordinary best-effort SignedMessage wake-up hint, never the source of commit truth. | `docs/spec/control-plane.md` — Commit notification and recovery | `L2`, `L3` |
| G1-DEC-314 | Every send names its expected RouterInstanceId and declares `initial` or `retry`. Initial duplicate identity conflicts. A retained byte-identical retry returns its original accepted result, changed bytes conflict, and an absent or evicted retry returns `retry_identity_unknown`; L3 may re-envelope the same evidence under a fresh MessageId. | `docs/spec/router.md` — Send | `L2`, `L3` |

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
| G1-DEC-700 | V2 has exactly six deep packages: identity, router, transcript, endpoint, simulator, and testbed. | `docs/spec/layer-interfaces.md` — Package map | `ARCH` |
| G1-DEC-701 | Production dependencies are router→identity, transcript→identity+router contracts, and endpoint→identity+router+transcript. Simulator uses identity and endpoint public capabilities; testbed may use all five. | `docs/spec/layer-interfaces.md` — Dependency graph | `ARCH` |
| G1-DEC-702 | Identity, router, transcript, and endpoint each own public contracts, concrete implementation, and runnable binaries behind the deep package boundary. | `docs/spec/layer-interfaces.md` — Package graph and binaries | `ARCH` |
| G1-DEC-703 | Binaries are `moltzap-registry`, `moltzap-router`, `moltzap-ledger`, `moltzap-agentd`, and `moltzap`. | `docs/spec/layer-interfaces.md` — Binaries | `ARCH` |
| G1-DEC-704 | Production packages export `.` and `./server`; simulator exports `.`, `./adapter`, and `./ledger`; testbed exports `.`. | `docs/spec/layer-interfaces.md` — Exports | `ARCH` |
| G1-DEC-705 | Wire, protocol, endpoint-core, daemon-api, CLI, harness-adapter, conformance, and any cross-layer representation module are not packages. | `docs/spec/layer-interfaces.md` — Information hiding | `ARCH` |
| G1-DEC-706 | No production package depends on simulator or testbed, and no `v2/*` package imports `packages/*`; V2 packages follow only the frozen V2 DAG. | `docs/spec/layer-interfaces.md` — Isolation laws | `ARCH` |
| G1-DEC-707 | Deep packages expose domain capabilities and guarantees while hiding representation and infrastructure mechanisms, use cohesive services and root-composed Layers, and avoid shallow per-method ports or generic accessor packages. | `docs/architecture/components.md` — Deep-module design rules | `ARCH` |
| G1-DEC-708 | `v2/VERSION`, all six package manifests, and MoltZap compatibility are exactly `2026.729.1` for this contract revision. | `docs/spec/layer-interfaces.md` — Versioning | `ARCH`, `WIRE` |
| G1-DEC-709 | MCP revision and simulator definition, event, and RunLedger persisted-schema versions remain independent of `v2/VERSION`. | `docs/spec/layer-interfaces.md` — Independent versions | `ARCH` |
| G1-DEC-710 | Registry and Ledger use native Effect SQL with PostgreSQL; fast tests use the same PostgreSQL client through PGlite socket. | `docs/spec/control-plane.md` — Persistence realization | `ARCH`, `L3` |
| G1-DEC-711 | Real PostgreSQL Testcontainers are mandatory for concurrency, isolation, and atomicity properties. | `docs/spec/control-plane.md` — Persistence realization | `L3` |
| G1-DEC-712 | Each endpoint daemon owns one SQLite file. Router owns only bounded process-local volatile state; restart loses its feed, retry index, cursor key, nonce set, identity cache, and waiters, creates a new instance, and leaves reconciliation to L3 while permitting new STARTs. | `docs/spec/router.md` — Volatile state and restart | `ARCH`, `L2` |
| G1-DEC-713 | V2 owns the one simulator kernel, runtime roster, EventCatalog, and typed run-evidence RunLedger. | `docs/architecture/first-implementation.md` — Simulator | `SIM` |
| G1-DEC-714 | Preserve `Simulator.define`, immutable definition identity, closed typed EventCatalog, scoped runtime roster/lifecycle, and RunLedger/LedgerStorage while replacing v1 protocol-facing ports with v2 public capabilities. | `docs/architecture/first-implementation.md` — Port contract | `SIM` |
| G1-DEC-715 | Simulator owns and root-exports StackProvider; testbed supplies its production Live Layer, focused tests supply fake Layers, runtimes receive EndpointProfileRef, and run-evidence RunLedger remains separate from product Transcript. | `docs/spec/layer-interfaces.md` — StackProvider | `SIM`, `ARCH` |
| G1-DEC-716 | Do not port legacy `launchTestbed`, public v1 protocol types, grading/YAML DSLs, or Node child-process/external-runtime details into `simulator`. | `docs/architecture/first-implementation.md` — Do-not-port list | `SIM`, `ARCH` |
| G1-DEC-717 | Simulator porting starts only from a fully tracked, constitution-aligned, landed-green immutable SHA recorded in the repository handoff. | `docs/architecture/first-implementation.md` — Simulator provenance gate | `SIM` |
| G1-DEC-718 | The old simulator becomes a temporary compatibility facade or is retired; two simulator engines never run in parallel. | `docs/architecture/first-implementation.md` — Cutover | `SIM` |
| G1-DEC-719 | Testbed owns platform acquisition, supervision, fault layers, external-process constructors, substitutes, and black-box subjects, never production service implementations. | `docs/spec/layer-interfaces.md` — Testbed | `ARCH`, `SIM` |
| G1-DEC-720 | OpenClaw, NanoClaw, and eval packages remain external consumers of v2 public interfaces. | `docs/architecture/first-implementation.md` — Non-negotiable boundaries | `INT` |

## Explicit deferrals

The rows below group the items named by normative chapters'
`Explicitly deferred` sections. This L1/L2 revision changes only
L1/L2-related deferrals and makes no new L3, L4, endpoint-daemon, or MCP
deferral.

| ID | Deferred beyond Gate 1 | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-800 | Router replication, multi-process ordering, Byzantine sequencing, fork detection, failover, and stable instance identity. | `docs/spec/router.md` — Explicitly deferred | `DEFER` |
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
| G1-DEC-813 | A required end-to-end body-encryption or key-distribution profile. The content-blind SignedMessage body preserves the option. | `docs/spec/router.md` — Content blindness | `DEFER` |
| G1-DEC-814 | npm publishing, bundling, deployment, production cutover, retrofitting v1, and v1 retirement. | `docs/architecture/first-implementation.md` — Non-goals | `DEFER` |
| G1-DEC-815 | Delegation evidence and peer-card custody. | `docs/spec/identity.md` — Deferred identity lifecycle | `DEFER` |
| G1-DEC-816 | Persistent feeds or cursors, recipient queues or progress, offline convergence, restart-transparent liveness, per-recipient indexes, and network-push transports. | `docs/spec/router.md` — Explicitly deferred | `DEFER` |
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
