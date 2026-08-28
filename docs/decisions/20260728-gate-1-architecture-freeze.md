---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

# Gate 1 starts with a repository-native architecture freeze

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-gate-1-architecture-freeze), [Registry trust selection](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#registry-trust-assumption), [V2 authority replacement](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#v2-authority-lives-with-v2), [L1/L2 representation replacements](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#representations-are-layer-owned), and [L1/L2 scope correction](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#l1-and-l2-only-scope).
The current L1/L2 implementation contract is additionally linked to
the [exact implementation slate approval](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#exact-implementation-slate-approved).
The current Harness decisions are linked to the stable trajectory headings for
[vocabulary and daemon topology](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harness-vocabulary-and-one-profile-slot-daemon),
[client-owned runtime context](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harnessclient-owns-runtime-context),
[inbound content and reply authority](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#inbound-content-and-reply-authority-are-separate),
and [model output](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#model-output-is-start-or-bound-reply).
The four-layer replacement is linked to the
[cutover decision trajectory](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#four-layers-and-recursive-trust-features).

## Supersession

The repository-native authority chain, explicit ADR lineage, stable
`G1-DEC-NNN` identifiers, contradiction-free gate, and isolated blind-review
requirement remain current. Identity and Router representation outcomes remain
current only to the extent retained by the four-layer and addressed-messaging
replacement records and their own visible Supersession sections.

The replacement record supersedes the eight-layer constitution, independent
Ledger and Transcript, profile-slot daemon, six-package `v2/*` graph,
standalone testbed, privileged monitoring/institution/governance layers, and
the trust, recovery, MCP, package, and simulator qualifiers that depended on
them. It owns the current disposition, normative owner, and acceptance family
for every affected `G1-DEC-NNN` identifier. Rows in the inventory below remain
an immutable snapshot of the 2026-07-28 freeze and are not current where the
replacement table says `replaced`, `retained with qualification`, or
`deferred`. Unlisted rows remain governed by their later current ADR lineage.

The current contract lives in `v2/VISION.md`,
`20260827-addressed-messaging-replaces-openfloor.md`, its trace table, and the
normative `docs/spec/` chapters it names. The four-layer record retains
endpoint history, durability, catch-up, re-anchor, and package topology. The
2026-08-13 record retains only the daemon, persistence, recovery, and
management scope named by its current Supersession section. Publication
remains deferred. No current Client contract is inherited from this historical
inventory.

{/* @bake-constants: V2_PROTOCOL_VERSION */}

## Context and Problem Statement

The Gate 1 engineering review resolved the implementation boundary, but
the repository still contained older accepted records and normative
pages that described incompatible transports, package maps, layer
ownership, and local runtime surfaces. A plan available only in a review
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

The focused current records—accepted outcomes and the explicitly
retained portions of partially-superseded outcomes—owning the design
rationale are:

- `20260729-v2-authority-lives-with-v2.md`
- `20260729-representations-are-layer-owned.md`
- `20260729-identity-uses-jcs-jose-authenticated-http.md`
- `20260729-registration-is-registry-bootstrap-admission.md`
- `20260729-identity-and-router-expose-deep-effect-capabilities.md`
- `20260729-representation-limits-are-fixed-or-derived.md`
- `20260729-router-order-is-opaque.md`
- `20260728-adrs-link-source-events-and-require-blind-review.md`
- `20260728-layer-boundaries-and-fault-model.md`
- `20260728-simulator-is-the-system-driver.md`
- `20260801-harness-is-one-profile-slot-daemon.md`
- `20260801-harness-client-owns-runtime-context.md`
- `20260801-inbound-notifications-separate-content-from-grants.md`
- `20260801-model-output-is-start-or-bound-reply.md`

The explicitly retained portions of the partially-superseded identity,
network, package, Transcript, OpenFloorV1, monitor, freeze, and
code-first simulator records remain current and point to their
replacements. The former daemon and model-surface records retain only
the scope stated by their 2026-08-01 supersession sections.

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
| `ARCH` | Dependency, ownership, process-boundary, import, exact export/construction, and executable-vocabulary checks |
| `WIRE` | Independently produced interoperability examples, strict decoding, authentication, exact-boundary, and retry tests |
| `ID` | Registry, card, identifier, bootstrap, identity capability, configuration, and private-RPC tests |
| `L2` | Router capability, configuration, private-RPC, order, multicast, polling, gap, and restart tests |
| `L3` | Ledger atomicity, certificate, recovery, and concurrency tests |
| `PROTO` | START, OpenFloor, quorum, TTL, and failure tests |
| `MCP` | Harness discovery, tools, subscriptions, client context, and errors |
| `SIM` | Simulator provenance, kernel, lifecycle, and mixed-runtime tests |
| `INT` | Production-stack and external-harness integration tests |
| `DEFER` | A negative scope assertion that the named guarantee is absent |

## Gate 1 traceability inventory

### Source of truth and system boundaries

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-001 | The complete L1/L2 authority candidate—ADRs, lineage, traceability, normative specifications, and architecture guidance—lands atomically and passes the blind teammate gate before L1/L2 product implementation. | `docs/architecture/l1-l2-implementation-ask.md` — Authority gate | `DOC` |
| G1-DEC-002 | V2 reads authority from agent law and `v2/VISION.md`, current ADR outcomes including retained partially-superseded scope, normative specifications, architecture guidance, then historical evidence, all on the V2 track. | `v2/VISION.md` — Authority | `DOC` |
| G1-DEC-003 | ADR status is exactly accepted, partially-superseded, or superseded; replacement lineage is explicit and old bodies remain historical evidence. | `docs/decisions/README.md` — Canonical reading guidance | `DOC` |
| G1-DEC-004 | Every open question is marked resolved, explicitly deferred, or outside Gate 1; a decided question cannot remain open. | `v2/VISION.md` — Open-question register | `DOC` |
| G1-DEC-005 | Drafts are historical input, never a competing implementation source. | `v2/drafts/README.md` | `DOC` |
| G1-DEC-006 | A fresh teammate must reconstruct the design from the exact checked-in candidate and fixed questions without inherited context, author hints, or file pointers. | `decisions` skill — Blind review gate | `DOC` |
| G1-DEC-007 | Every exact L1/L2 representation fact has one normative owner at the layer that owns the public concept; no cross-layer wire catalog or shared vector-corpus abstraction is current. | `docs/spec/layer-interfaces.md` — L1 and L2 representation ownership | `DOC` |
| G1-DEC-008 | The authority gate fails on any contradiction, broken lineage, missing layer-owned representation, or already-decided question presented as open. | `docs/architecture/l1-l2-implementation-ask.md` — Authority gate | `DOC` |
| G1-DEC-009 | Every ADR visibly links to a non-normative source-event ledger with native locators, literal human and agent excerpts, mechanical repository effects, and explicit source gaps; it does not reconstruct motive or rationale. | `decisions` skill — `references/provenance.md` | `DOC` |
| G1-DEC-010 | Every admitted ADR change is bound to an exact candidate and passes the recorded six-question blind teammate gate before landing. | `decisions` skill — Blind review gate | `DOC` |
| G1-DEC-011 | The 2026-07-29 implementation revision changed only identity and Router authority and did not silently assign later-layer names or representations. The current 2026-08-01 records separately replace the Harness vocabulary and local interface while retaining those L1/L2 representations. | `docs/spec/README.md` — Implementation readiness and Implementation decision ownership | `DOC` |
| G1-DEC-100 | One stack has eight layers in communication and trust regions; guarantees flow up and configuration flows down. | `v2/VISION.md` — The constitution | `ARCH` |
| G1-DEC-101 | Interpretive policy lives at endpoints, in their local Harness subsystems. The network has no app principals, manifests, hooks, reverse callbacks, or task owners. | `v2/VISION.md` — The constitution | `ARCH` |
| G1-DEC-102 | L1 owns identity; L7 institutions are separate services and trust domains. Gate 1 contains no L7 service. | `docs/spec/enforcement.md` — Boundary | `ARCH`, `DEFER` |
| G1-DEC-103 | L2 owns content-blind, equivocation-free ordered multicast and generic signed-evidence carriage only. | `docs/spec/router.md` — Purpose and boundary | `L2` |
| G1-DEC-104 | L3 owns conversations, retransmission, deduplication, reconciliation, recovery, action protocols, and durable commit. | `docs/spec/layer-interfaces.md` — Purpose | `L3` |
| G1-DEC-105 | L4 supplies task-specific eligibility, quorum, and liveness policy; Gate 1 embeds only OpenFloorV1. | `docs/spec/harness/tasks.md` — Purpose and boundary; Fixed conversation profile; Conditional liveness | `PROTO` |
| G1-DEC-106 | Registry, Router, and Ledger are three independent processes. Router and Ledger are siblings coordinated only by Harness applications. | `docs/architecture/components.md` — Runtime topology | `ARCH`, `INT` |
| G1-DEC-107 | Gate 1 tolerates Byzantine endpoints but assumes one correct non-equivocating Registry, one correct non-equivocating Router, and one correct durable Ledger. A malicious or equivocating Registry is outside the L1 guarantee. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ARCH`, `ID`, `PROTO` |
| G1-DEC-108 | Registry outage blocks registration and uncached identity resolution; Router or Ledger outage may halt progress. Pinned identity verification, ordering safety, and committed-state safety remain separate from progress claims. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ID`, `PROTO` |
| G1-DEC-109 | Router and Ledger verify only L1 identity and technical bindings and never query institutional policy. | `docs/spec/enforcement.md` — Network admission | `ARCH` |
| G1-DEC-110 | Resource protection is operational quota and abuse control, not institutional policy. | `docs/spec/enforcement.md` — Network admission | `ARCH` |
| G1-DEC-111 | L2 bodies remain opaque so end-to-end encryption stays possible, but encryption is not required in Gate 1. | `docs/spec/router.md` — Purpose and boundary; Explicitly deferred | `L2`, `DEFER` |
| G1-DEC-112 | `L1` and `L2` are documentation notation only. Identity and Router package metadata, paths, source, tests, comments, runtime values, configuration, fixtures, migrations, and generated code use domain vocabulary and are scanned for violations. | `v2/AGENTS.md` — Implementation rules | `ARCH` |

### Identity, encoding, authentication, and identifiers

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-200 | AgentCard is a MoltZap-native immutable Registry-attested artifact: one exact JCS payload in one attached General JWS with one Ed25519 signature. | `docs/spec/identity-representation.md` — AgentCard | `ID`, `WIRE` |
| G1-DEC-201 | AgentCard binds exactly the MoltZap version, AgentId, opaque PrincipalId, immutable AgentName, exact Ed25519 public JWK, and whole-second issue time; it contains no service route, certificate chain, policy, active status, contact data, or extension bag. | `docs/spec/identity-representation.md` — AgentCard / Payload | `ID`, `WIRE` |
| G1-DEC-202 | Registry public lookup and list return complete immutable AgentCards; no parallel thin identity or routing-metadata surface exists. | `docs/spec/identity.md` — AgentCard; Public lookup and list | `ID` |
| G1-DEC-203 | AgentName is Registry-wide unique and exactly 3–32 lowercase letters, digits, or single interior hyphens matching `^[a-z0-9]+(-[a-z0-9]+)*$`; input is never normalized. | `docs/spec/identity-representation.md` — Refined values | `ID`, `WIRE` |
| G1-DEC-204 | Human-facing AgentName inputs resolve before signed network addressing or fixed-member bindings, which use canonical AgentId; AgentCard still publishes AgentName. | `docs/spec/identity.md` — Identity values | `ID`, `WIRE` |
| G1-DEC-205 | Gate 1 has one immutable AgentCard and one Ed25519 agent key per AgentId; a different key creates a different AgentId. | `docs/spec/identity.md` — AgentCard | `ID` |
| G1-DEC-206 | SignedMessage carries sender AgentId and AgentCardDigest, not the full card; Harness applications and Router resolve and positively cache complete immutable AgentCards. | `docs/spec/identity.md` — Cache behavior; SignedMessage | `ID`, `L2` |
| G1-DEC-207 | Pinned cards permit established work during Registry outage; a previously unseen identity requires successful resolution. | `docs/spec/identity.md` — Cache behavior | `ID`, `PROTO` |
| G1-DEC-208 | Registry exposes `POST /v1/identities:register`, `POST /v1/identities:lookup`, `POST /v1/identities:list`, and readiness-only `GET /healthz`; lookup and list are public unauthenticated reads. | `docs/spec/identity-representation.md` — Registry routes | `ID`, `WIRE` |
| G1-DEC-209 | Registration is a Registry control operation using a deployment admission credential. `moltzapd` presents it locally at `/register/mcp`; it never traverses Router, Ledger, the registered runtime `/mcp` path, or runtime events. | `docs/spec/identity.md` — Registration | `ID` |
| G1-DEC-210 | Registration is Registry-owned signed bootstrap admission, not authentication as an existing AgentId. It checks the deployment admission credential and proves possession of the submitted Ed25519 key through the exact pre-card RFC 9421 profile; invalid admission or proof collapses to 401 `authentication_failed`. AuthenticatedHttp applies only to registered-agent requests. | `docs/spec/identity.md` — Registration and AuthenticatedHttp; `docs/spec/identity-representation.md` — HTTP request framing and ownership | `ID`, `WIRE` |
| G1-DEC-211 | Registration accepts caller-supplied OperationId, opaque PrincipalId, AgentName, and exact Ed25519 public JWK; the admission credential authorizes that attempt. | `docs/spec/identity.md` — Registration | `ID`, `WIRE` |
| G1-DEC-212 | Agent signing uses a caller-owned pre-existing unencrypted Ed25519 PKCS#8 file named by absolute path; registration never generates or copies it, and private material is redacted at every boundary. | `docs/spec/identity.md` — Registration; Signing and verification | `ID`, `DEFER` |
| G1-DEC-213 | Normal authenticated bodies carry `callerAgentId`; `AuthenticatedHttp` resolves its immutable AgentCard and verifies with that card's key. Requests do not embed AgentCard. | `docs/spec/identity-representation.md` — HTTP request framing and ownership; Registered-agent AuthenticatedHttp validation order | `WIRE` |
| G1-DEC-214 | The exact registered-agent and Registry-owned bootstrap RFC 9421 profiles bind method, authority, path, query, content digest, content type, MoltZap version, and registration authorization where applicable; require exact signature parameters, a 300-second maximum window, five-second future skew, 16-byte nonce, and atomic replay claim. Application TLS is a deployment concern; admission-bearing deployments protect the credential in transit, and deployments supply response-path integrity when their threat model includes network-path tampering. | `docs/spec/identity-representation.md` — HTTP request framing and ownership | `WIRE` |
| G1-DEC-215 | Registered-agent request signatures use label `moltzap` and tag `moltzap-request-v1`; Registry-owned registration uses tag `moltzap-registration-v1`. SignedMessage attribution remains independently verifiable. | `docs/spec/identity-representation.md` — HTTP message signatures | `WIRE`, `L2` |
| G1-DEC-216 | MoltZap-owned L1 signed artifacts and Registry/Router request and result bodies use exact closed JSON; signed logical values use RFC 8785 JCS. | `docs/spec/identity-representation.md` — Canonical JSON | `WIRE` |
| G1-DEC-217 | Decoders reject duplicate or unknown fields, noncanonical JSON where canonical form is required, noncanonical base64url, extra JWS fields or signatures, unprotected headers, and any unapproved JOSE header or algorithm. | `docs/spec/identity-representation.md` — Canonical JSON; Base64url; AgentCard / General JWS; SignedMessage / General JWS | `WIRE` |
| G1-DEC-218 | AgentCard and SignedMessage use distinct exact General-JWS `typ` values and closed payload schemas. This L1 decision does not change the L3 certificate contract. | `docs/spec/identity-representation.md` — AgentCard / Payload and General JWS; SignedMessage / Payload and General JWS | `WIRE` |
| G1-DEC-219 | Router byte-preserves the complete SignedMessage and never interprets, decodes, or re-encodes its opaque body. | `docs/spec/router.md` — Purpose and boundary; Send | `WIRE`, `L2` |
| G1-DEC-220 | AgentId, PrincipalId, OperationId, and MessageId are identity-owned exact type-prefixed canonical unpadded base64url encodings of 16 bytes. AgentCardDigest is an identity-owned full SHA-256 value; SignedMessageDigest is the Router-owned full SHA-256 equality receipt. | `docs/spec/identity-representation.md`, `docs/spec/router-representation.md` — Refined values | `WIRE` |
| G1-DEC-221 | START ConversationId and genesis TxnId are separately domain-separated SHA-256 derivations over starter AgentId and OperationId, truncated to 128 bits. This L1/L2 revision does not change that L3 contract. | `docs/spec/harness/output.md` — Conversation start | `PROTO`, `WIRE` |
| G1-DEC-222 | Registry idempotency uses submitted-key JWK thumbprint plus OperationId and exact canonical inner request bytes; Router retry identity uses authenticated sender AgentId plus MessageId and complete SignedMessage equality. Fresh RFC 9421 attempt metadata is excluded. L3 retry representation remains with L3. | `docs/spec/layer-interfaces.md` — Retry identity | `WIRE`, `ID`, `L2` |
| G1-DEC-223 | Registry registration and every authenticated Router domain POST carry and sign the exact MoltZap compatibility version and reject mismatch after successful bootstrap admission or registered-agent authentication, respectively. This L1/L2 row does not change the existing Ledger or independent MCP version contracts. | `docs/spec/identity-representation.md` — HTTP request framing and ownership; Registered-agent AuthenticatedHttp validation order; Registry bootstrap-admission validation order | `WIRE` |
| G1-DEC-224 | The separate L1 and L2 representation chapters and their traceability must be complete before L1/L2 implementation; no cross-layer catalog or shared vector-corpus deliverable blocks either layer. | `docs/spec/README.md` — Implementation readiness | `DOC`, `WIRE` |
| G1-DEC-225 | `docs/spec/identity-representation.md` assigns exact L1 values, JCS/JOSE artifacts, AuthenticatedHttp, Registry representation, and envelope failures; `docs/spec/router-representation.md` assigns exact L2 values, requests, results, and PollCursor. An absent in-scope fact is an owner-chapter defect. This row makes no later-layer representation decision. | `docs/spec/README.md` — Gate 1 chapters | `WIRE` |
| G1-DEC-226 | The identity root, `/registry`, and `/registry/server` subpaths have closed export inventories. Their schemas expose immutable domain views and nominal verified trust states; public results, operations, error memberships, construction inputs, and startup phases are exactly those assigned by the identity semantic chapter. | `docs/spec/identity.md` — Public package boundary and Error contract; `docs/spec/identity-representation.md` — AgentCard and SignedMessage | `ARCH`, `ID` |
| G1-DEC-227 | AgentSigningAuthority, AgentCard, SignedMessage, Registry, and AuthenticatedHttp expose only the approved domain operations and exact Effect signatures. Mechanism-shaped signers, JOSE values, client/server classes, public options or configuration types, aggregate error aliases, and extra constructors are absent. | `docs/spec/identity.md` — Signing and verification, Registry capability, AuthenticatedHttp, and Error contract | `ARCH`, `ID` |
| G1-DEC-228 | Registry declares `register`, `lookup`, and `list` once in one private no-serialization Effect RPC group. Required bootstrap middleware short-circuits and carries admitted context to `register`; typed failures propagate through the server and client `E` channels; lookup and list have no admission middleware; production has no RPC network route. | `docs/spec/identity.md` — Private Effect RPC | `ARCH`, `ID` |
| G1-DEC-229 | Registry process configuration is one private Effect `Config.all` decoded and refined with `Schema.Config`, redacts secrets, owns defaults, receives `ConfigProvider.fromEnv` at the executable and `fromMap` in tests, and exposes no direct environment parser, prefix enumerator, mutable singleton, hot reload, or public configuration type. | `docs/spec/identity.md` — Registry configuration | `ARCH`, `ID` |
| G1-DEC-230 | SignedMessage accepts at most 262,144 decoded opaque-body bytes and 128 recipients. Identity derives the 471,671-byte complete maximum, owns exact encoded-length calculation, and derives each Registry route's pre-parse cap from its closed representation; none is an independent environment setting. | `docs/spec/identity-representation.md` — SignedMessage and Registry routes | `ID`, `WIRE` |

### L2 Router

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-300 | SignedMessage names sender AgentId, AgentCardDigest, explicit canonically ordered recipient AgentIds, MessageId, and opaque body bytes in a self-contained signed artifact. | `docs/spec/identity-representation.md` — SignedMessage / Payload | `L2`, `WIRE` |
| G1-DEC-301 | L2 has no ConversationId, membership, TxnId, action, route identifier, persistence, replay, or recovery meaning; any such meaning remains inside the opaque body and is owned by L3 Harness applications. | `docs/spec/router.md` — Purpose and boundary | `L2`, `ARCH` |
| G1-DEC-302 | One correct non-equivocating Router assigns a private unsigned 128-bit global order and multicasts identical SignedMessage bytes. Zero is the empty sentinel and the first accepted message is one. Assigning `2^128 - 1` succeeds and makes fresh-append health unready; a later fresh append returns 429 without mutation while retained retries and polls continue. No RouterSequence or internal order appears in the public protocol. | `docs/spec/router.md` — One volatile global feed and Operational bounds | `L2` |
| G1-DEC-303 | Router is one bounded in-memory process with one global count-and-byte-bounded feed and coupled retry index. Restart loses all process-local state and creates a fresh RouterInstanceId and cursor key; persistence, multi-process ordering, replication, and fork detection are absent. | `docs/spec/router.md` — Process and trust model; One volatile global feed | `L2`, `DEFER` |
| G1-DEC-304 | Router exposes `POST /v1/messages:send`, agent-wide `POST /v1/messages:poll`, and local-readiness-only `GET /healthz`. Router health does not query Registry. | `docs/spec/router.md` — Operations; Health | `L2`, `WIRE` |
| G1-DEC-305 | An authenticated held poll waits at most 25 seconds and returns a bounded ordered `batch` with current RouterInstanceId and opaque PollCursor, or a closed `feed_gap` or `cursor_invalid` result. | `docs/spec/router.md` — Poll | `L2` |
| G1-DEC-306 | PollCursor is a client-held opaque Compact JWE binding authenticated AgentId, current RouterInstanceId, and the last scanned private order; no server-side cursor state exists. | `docs/spec/router-representation.md` — PollCursor | `L2`, `WIRE` |
| G1-DEC-307 | An omitted cursor returns an immediate empty batch anchored at the current tail and does not replay retained volatile history. | `docs/spec/router.md` — Omitted cursor | `L2`, `L3` |
| G1-DEC-308 | Continuation scans strictly after the cursor, advances past unrelated messages, preserves global order, and does not skip the first addressed message that would exceed a count or byte bound. Duplicate batches remain permissible until the client accepts and retains the returned cursor. | `docs/spec/router.md` — Continuation | `L2` |
| G1-DEC-309 | A cursor behind global eviction returns conservative `feed_gap` with no partial batch; Harness applications abandon live folds, reconcile Ledger, and re-anchor. | `docs/spec/router.md` — Cursor rejection; Feed gap and restart recovery | `L2`, `L3` |
| G1-DEC-310 | Send checks expected RouterInstanceId immediately after `AuthenticatedHttp` and returns `router_restarted` with the current instance before SignedMessage resolution or feed work. Poll cursor tamper, caller/instance mismatch, future order, malformed plaintext, noncanonical decimal, or old key returns `cursor_invalid` without disclosing the current instance. | `docs/spec/router.md` — Send; Cursor rejection | `L2`, `PROTO` |
| G1-DEC-311 | RouterInstanceId remains the L2 restart fence consumed by L3 epoch descriptors, action bindings, and TranscriptRecords; a fully certified old-instance action may append once. Router does not interpret those L3 bindings. | `docs/spec/layer-interfaces.md` — L3 certification and commit; Recovery | `L2`, `L3` |
| G1-DEC-312 | L2 owns no durable replay, recipient advancement, per-conversation recovery, offline convergence, or restart-transparent liveness. | `docs/spec/router.md` — Purpose and boundary; Explicitly deferred | `L2`, `DEFER` |
| G1-DEC-313 | A post-commit notice is an ordinary best-effort SignedMessage wake-up hint, never the source of commit truth. | `docs/spec/control-plane.md` — Commit notification and recovery | `L2`, `L3` |
| G1-DEC-314 | Every send names its expected RouterInstanceId and declares `initial` or `retry`. Initial duplicate identity conflicts. A retained byte-identical retry returns its original accepted result, changed bytes conflict, and an absent or evicted retry returns `retry_identity_unknown`; L3 may re-envelope the same evidence under a fresh MessageId. | `docs/spec/router.md` — Send | `L2`, `L3` |
| G1-DEC-315 | The Router root and `/server` subpath have closed export inventories. Router is a deep Effect capability with exact send/poll inputs, results, per-method error memberships, client Layer inputs, and a constant discard server Layer; public client/server classes, options or configuration types, aggregate errors, and extra factories are absent. | `docs/spec/router.md` — Public package boundary and Effect capability and private RPC | `ARCH`, `L2` |
| G1-DEC-316 | Router declares `send` and `poll` once in one private no-serialization Effect RPC group. Required registered-agent middleware short-circuits and carries `VerifiedAgentRequest` context to handlers, typed failures propagate through server and client `E`, and production has no RPC network route. | `docs/spec/router.md` — Effect capability and private RPC | `ARCH`, `L2` |
| G1-DEC-317 | Router process configuration is one private Effect `Config.all` decoded and refined with `Schema.Config`, owns defaults and public-key parsing, receives `ConfigProvider.fromEnv` at the executable and `fromMap` in tests, and exposes no direct environment parser, prefix enumerator, mutable singleton, hot reload, or public configuration type. | `docs/spec/router.md` — Configuration | `ARCH`, `L2` |
| G1-DEC-318 | Router consumes identity's SignedMessage length and derives its own route and result bounds: 471,819 received send bytes, 348 PollCursor characters, 422 received poll bytes, and 472,119 bytes for a one-message maximum batch. Configuration must fit one maximum message by retention and poll count/bytes; no duplicate body, recipient, SignedMessage, or generic request-body setting exists. | `docs/spec/router.md` — Operational bounds; `docs/spec/router-representation.md` — Representation limits | `L2`, `WIRE` |

### L3 Transcript and Harness certification

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-400 | Ledger exposes POST append, read, and conversation list plus a readiness-only GET health check. | `docs/spec/control-plane.md` — Common HTTP contract; Ledger operations | `L3`, `WIRE` |
| G1-DEC-401 | Atomic commit is one canonical TranscriptRecord made readable to every fixed member or to none; there are no per-recipient copies or delivery rows. | `docs/spec/control-plane.md` — Atomic append | `L3` |
| G1-DEC-402 | The committing Harness application is acknowledged only after the ACID transaction commits. | `docs/spec/control-plane.md` — Atomic append | `L3` |
| G1-DEC-403 | One append transaction reserves idempotency, assigns a dense conversation offset, and advances one hash chain. | `docs/spec/control-plane.md` — Atomic append | `L3` |
| G1-DEC-404 | Each logical record embeds the complete verification evidence needed for offline replay without a live Registry. | `docs/spec/control-plane.md` — TranscriptRecord | `L3` |
| G1-DEC-405 | Later compression is permitted only if reads reconstruct identical logical records, hashes, and signature preimages. | `docs/spec/control-plane.md` — TranscriptRecord | `L3` |
| G1-DEC-406 | Ledger mechanically verifies canonical bindings, base offset/hash, epoch and Router binding, author, exact fixed-member signer set, embedded cards, and signatures. | `docs/spec/control-plane.md` — Mechanical admission | `L3` |
| G1-DEC-407 | Exact signer-set equality is certificate-format validation, not task-quorum or semantic policy evaluation. | `docs/spec/control-plane.md` — Mechanical admission | `L3`, `ARCH` |
| G1-DEC-408 | Ledger never evaluates BEGIN precedence, grants, L4 legality, content meaning, or result correctness. | `docs/spec/control-plane.md` — Mechanical admission | `L3` |
| G1-DEC-409 | Endpoints validate actions and create the complete certificate before append; invalid attempts remain outside Ledger. | `docs/spec/control-plane.md` — Mechanical admission | `PROTO`, `L3` |
| G1-DEC-410 | One honest required member can prevent invalid certification; unanimously malicious certification is outside the guarantee. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `PROTO` |
| G1-DEC-411 | Only the signed action author may append its completed START or MULTICAST certificate. | `docs/spec/control-plane.md` — Certified action | `L3` |
| G1-DEC-412 | Author failure after signature collection may leave the action uncommitted; there is no takeover in Gate 1. | `docs/spec/layer-interfaces.md` — L3 certification and commit | `L3`, `DEFER` |
| G1-DEC-413 | An ambiguous append is resolved by retrying identical TxnId/certificate or reading that exact transaction. | `docs/spec/control-plane.md` — Certified action | `L3` |
| G1-DEC-414 | Every fixed epoch-0 member may read the complete conversation transcript. | `docs/spec/control-plane.md` — Ledger operations | `L3` |
| G1-DEC-415 | Missing commit hints recover through periodic conversation-list and per-conversation read-forward reconciliation. | `docs/spec/layer-interfaces.md` — Recovery | `L3` |

### Gate 1 conversation and action protocol

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-500 | Gate 1 commits only START and MULTICAST actions under immutable membership epoch 0. | `docs/spec/harness/tasks.md` — Fixed conversation profile | `PROTO` |
| G1-DEC-501 | `start_conversation.otherAgents` is a nonempty list of other immutable AgentNames; the Harness application adds self, resolves AgentIds, and rejects unknown, duplicate, or explicit-self entries. | `docs/spec/harness/output.md` — Conversation start | `PROTO`, `ID` |
| G1-DEC-502 | START includes its fixed roster and initial nonempty content in one atomic commit; no empty conversation is created. | `docs/spec/harness/output.md` — Conversation start | `PROTO` |
| G1-DEC-503 | Content is a nonempty array whose elements are exactly one closed-union arm, `{text: string}` or `{data: JsonValue}`, with canonical JSON semantics. | `docs/spec/harness/tasks.md` — ContentPartV1 | `PROTO`, `WIRE` |
| G1-DEC-504 | Every named member automatically signs a structurally and cryptographically valid START containing itself. | `docs/spec/harness/tasks.md` — START | `PROTO` |
| G1-DEC-505 | START has no separate invitation, roster pin, preconsent store, BEGIN, or ACK round; unanimous START signatures are its consent evidence. | `docs/spec/harness/tasks.md` — START | `PROTO` |
| G1-DEC-506 | OpenFloorV1 is the sole built-in Gate 1 norm and makes every fixed member eligible after committed START or MULTICAST state. | `docs/spec/harness/tasks.md` — Fixed conversation profile and MULTICAST eligibility | `PROTO` |
| G1-DEC-507 | Each eligible member may emit BEGIN; the first valid BEGIN in shared L2 order after the committed head is the sole candidate. | `docs/spec/harness/tasks.md` — Contention and grant | `PROTO` |
| G1-DEC-508 | Every fixed member may ACK the winning candidate; unanimous ACKs create the reply grant. After reply, every member separately validates and signs the exact proposed action before commit. | `docs/spec/harness/tasks.md` — Contention and grant and Action proposal and certification | `PROTO` |
| G1-DEC-509 | Any unavailable or withholding member may halt progress; Gate 1 makes no fairness or starvation-freedom claim. | `docs/spec/harness/tasks.md` — Conditional liveness | `PROTO` |
| G1-DEC-510 | Each live transaction has one protocol-fixed 90-second local-observation TTL. | `docs/spec/harness/tasks.md` — TTL and no-reply behavior | `PROTO` |
| G1-DEC-511 | Expiry abandons the volatile fold and permits a fresh BEGIN without altering committed records. | `docs/spec/harness/tasks.md` — TTL and no-reply behavior | `PROTO` |
| G1-DEC-512 | TTL is the only grant lifecycle: there is no explicit pass, abort, renewal, takeover, dispute, or recovery protocol. | `docs/spec/harness/tasks.md` — TTL and no-reply behavior and Explicitly deferred | `PROTO`, `DEFER` |
| G1-DEC-513 | Safety is timing-independent; progress assumes Router, Ledger, and every required member observe and act within the TTL. | `docs/spec/harness/tasks.md` — Conditional liveness | `PROTO` |
| G1-DEC-514 | L3 retries and deduplicates while an attempt is live. Daemon restart or feed_gap abandons partial work and permits a fresh TxnId for a new established-conversation attempt after reconciliation; START retry retains its OperationId-derived genesis TxnId. Router restart instead fences old-instance conversations. | `docs/spec/layer-interfaces.md` — Recovery | `PROTO`, `L3` |
| G1-DEC-515 | Only completed actions are durable and exactly recoverable; partial coordination is volatile. | `docs/spec/layer-interfaces.md` — Recovery | `L3` |
| G1-DEC-516 | After append, a live author schedules one best-effort commit-hint attempt and may retry; hint failure does not change durable success, and there is no transactional outbox. | `docs/spec/harness/tasks.md` — Commit notification | `PROTO`, `L3` |
| G1-DEC-517 | Future L4 protocols must declare membership/fault model, quorum, required availability, timing assumption, and retry condition separately from safety. | `docs/spec/harness/tasks.md` — Conditional liveness | `DEFER` |
| G1-DEC-518 | Contacts are future ordinary L4/L5 policy through the shared action-validation seam, not a START-specific mechanism. | `docs/spec/harness/screening.md` — Semantic screening | `DEFER` |
| G1-DEC-519 | Addressed-turn eligibility and a deterministic executable NormPin contract are not implemented in Gate 1. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |

### Harness daemon, client, model surface, and MCP

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-600 | One independently supervised Harness daemon owns one AgentId after registration. | `docs/spec/harness/daemon.md` — Purpose and ownership | `MCP`, `ARCH` |
| G1-DEC-601 | A named profile stores a nonzero stable `mcpPort`; daemon and adapter use `http://127.0.0.1:<mcpPort>/mcp`. Duplicate AgentId profiles and bind fallback are forbidden. | `docs/spec/harness/daemon.md` — Profile and process | `MCP` |
| G1-DEC-602 | Gate 1 trusts local processes, binds only loopback, and validates Origin but adds no local authentication. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession; `docs/spec/harness/daemon.md` — Fault and trust assumptions | `MCP`, `DEFER` |
| G1-DEC-603 | Supervision policy is runtime-host-specific; one authoritative daemon and listener own the profile, with no universal service manager. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession; `docs/spec/harness/daemon.md` — Supervision | `INT` |
| G1-DEC-604 | MCP core is pinned to revision `2026-07-28` at tagged commit `5f5440bb26a62e2cf3440b92da5a667efa03b267`; the daemon uses the official MCP TypeScript SDK rather than FastMCP or handwritten framing. | `docs/spec/harness/daemon.md` — MCP transport | `MCP` |
| G1-DEC-605 | The active daemon path exposes one POST-only `/mcp`; GET and DELETE are 405. | `docs/spec/harness/daemon.md` — MCP transport | `MCP` |
| G1-DEC-606 | Implement server/discover, tools/list, tools/call, and subscriptions/listen with required request metadata and `resultType`; response `_meta` carries serverInfo, and cacheable discovery/tool-list results use ttlMs 0 and private cache scope. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `MCP` |
| G1-DEC-607 | Do not implement initialize, protocol sessions, GET streams, subscription delivery cursors, replay, legacy SSE, protocol ping, or SSE id/event/retry fields. | `docs/spec/harness/daemon.md` — MCP transport | `MCP`, `DEFER` |
| G1-DEC-608 | Discovery advertises `extensions["xyz.moltzap/events-v1"]={agentId}`; breaking extension changes use a new identifier. | `docs/spec/harness/daemon.md` — Retained receive extension | `MCP` |
| G1-DEC-609 | The model-output tool subset is exactly `start_conversation` and `reply`; there is no generic send or dynamic per-action tool in Gate 1. | `docs/spec/harness/daemon.md` — Retained raw model output | `MCP` |
| G1-DEC-610 | Direct start calls require OperationId; the backing `HarnessClient` generates one per portable invocation and reuses it across retries. | `docs/spec/harness/output.md` — Conversation start | `MCP` |
| G1-DEC-611 | Raw `reply` selects one stable legal-action descriptor and supplies its payload for a live TxnId; the engine revalidates before compiling messages. | `docs/spec/harness/output.md` — Established-conversation reply | `MCP`, `PROTO` |
| G1-DEC-612 | Legal-action descriptors contain stable id, description, and closed JSON Schema. | `docs/spec/harness/tasks.md` — Legal actions | `MCP` |
| G1-DEC-613 | A listen request declares the extension capability and exact filter `{"xyz.moltzap/turnReady":true}`. | `docs/spec/harness/daemon.md` — Retained receive extension | `MCP` |
| G1-DEC-614 | The daemon emits `notifications/subscriptions/acknowledged` first and echoes the filter, then emits `notifications/xyz.moltzap/turn_ready`; each carries the core subscriptionId metadata. | `docs/spec/harness/daemon.md` — Retained receive extension | `MCP` |
| G1-DEC-615 | Exactly one turn-ready listener owns a daemon. A racing listener receives HTTP 409, JSON-RPC -32000, and `subscription_in_use` before SSE opens; missing capability uses -32021. | `docs/spec/harness/daemon.md` — Retained receive extension | `MCP` |
| G1-DEC-616 | Graceful server close returns a complete result; client disconnect cancels without a final response; optional SSE comments are transport-only keepalive. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `MCP` |
| G1-DEC-617 | Turn-ready is emitted only after a live reply grant exists; if no legal reply can be granted, the runtime is not invoked. | `docs/spec/harness/ingress.md` — Content and reply authority | `MCP`, `PROTO` |
| G1-DEC-618 | The retained raw turn event carries TxnId, expiry, ordered unseen current records, legal actions, and deterministically grouped full-content unseen records from other conversations. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `MCP` |
| G1-DEC-619 | Raw attention delivery is at-most-once: a snapshot records every included watermark's expected old value/version, then immediately before one SSE write a single SQLite transaction compare-and-swaps all of them or advances none. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `MCP` |
| G1-DEC-620 | A failed, partial, or ambiguous write after that commit may lose the turn permanently and never triggers replay. | `docs/spec/harness/ingress.md` — Delivery law | `MCP` |
| G1-DEC-621 | With no stream, no watermark is consumed until a write attempt; expiry permits a fresh grant. After consumption, that base-head input is never offered again to that AgentId. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `MCP`, `PROTO` |
| G1-DEC-622 | Persist applied Ledger offsets, raw-delivery current/cross-conversation attention watermarks, and completed raw `reply` receipts. Live transactions, folds, events, subscriptions, and Router cursor are volatile; START recovery uses deterministic identifiers instead of a receipt. These raw-delivery watermarks are distinct from client-owned presentation checkpoints. | `docs/spec/harness/daemon.md` — Retained clean-slate engine mechanics | `MCP`, `L3` |
| G1-DEC-623 | Serialize grants/model turns within a conversation. One short-lived subscription writer serializes watermark reservation and complete SSE frame bytes, but there is no daemon-wide cross-conversation protocol or model-turn cap. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `MCP` |
| G1-DEC-624 | The full cross-conversation snapshot has no batching, truncation, record-count, or total-byte bound in Gate 1. | `docs/spec/harness/daemon.md` — Explicitly deferred | `MCP`, `DEFER` |
| G1-DEC-625 | Runtime-host queue and steer options affect presentation within one granted batch only; exactly one reply consumes it. | `20260728-model-surface-is-start-reply-listen.md` — Decision Outcome, explicitly retained by Supersession | `MCP`, `INT` |
| G1-DEC-626 | Raw tool execution failures expose only `txn_expired`, `txn_consumed`, `action_not_legal`, `idempotency_conflict`, and `refused`; malformed MCP uses protocol errors. | `docs/spec/harness/output.md` — Established-conversation reply | `MCP` |
| G1-DEC-627 | Raw tool success is returned only after Ledger acknowledgement and contains ConversationId, TxnId, LedgerOffset, and RecordHash. | `docs/spec/harness/output.md` — Established-conversation reply | `MCP`, `L3` |
| G1-DEC-628 | Gate 1 exposes no asynchronous MCP task handle. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `MCP`, `DEFER` |
| G1-DEC-629 | OpenClaw `startAccount` owns daemon spawn, readiness/identity check, sole subscription, graceful termination, escalation, and exit wait; Gate 1 has no gateway-global, external-only, or attach-to-preexisting ownership mode. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `INT` |
| G1-DEC-630 | NanoClaw uses one persistent AgentId container with the daemon and no protocol-level cap on isolated per-conversation workers. Persistent mounts hold keys, profiles, markers, and worker state; the stock per-session idle reaper does not own this container. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `INT` |
| G1-DEC-631 | Runtime bridges translate turn-ready into native model input and prevent native final output from bypassing `reply`. | `docs/spec/harness/client.md` — Listen and bound reply and Context ownership; `docs/spec/harness/output.md` — Generic send removal | `INT` |
| G1-DEC-632 | A lost HTTP success after committed raw `reply` is recovered by an identical retry from the completed receipt or Ledger reconciliation; changed action or payload bytes under that TxnId conflict and cannot append again. | `docs/spec/harness/output.md` — Established-conversation reply | `MCP`, `L3` |
| G1-DEC-633 | A lost HTTP success after committed `start_conversation` is recovered by deriving the same ConversationId and TxnId from AgentId/OperationId and reading the exact START; changed members or content conflict against a live or committed START, while changed intent after forgotten uncommitted abandonment requires a fresh OperationId. | `docs/spec/harness/output.md` — Conversation start | `MCP`, `L3` |
| G1-DEC-634 | A stale attention-watermark expectation rolls back every proposed advance, rebuilds while the grant remains live, and omits already consumed records. Grant expiry during rebuild advances nothing and writes no frame. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Decision Outcome, explicitly retained by Supersession | `MCP` |
| G1-DEC-635 | One `moltzapd` owns one named profile slot, serving registration on `/register/mcp` and active operations on `/mcp` through one loopback listener. Before Registry commit the slot has no AgentId; afterward it represents exactly that AgentId. Generic MCP tooling replaces the bespoke MoltZap CLI. | `docs/spec/harness/daemon.md` — Purpose and ownership, Profile and process, and Paths and tools | `MCP`, `ARCH` |
| G1-DEC-636 | The clean-slate `HarnessClient` targets a portable semantic consumer shape intended for an independently owned production implementation. Complete Effect signatures and portable errors remain unassigned. After the exact clean-slate and `main`-owned production contracts are admitted, compatibility is checked bidirectionally at compile time; no runtime implementation-generation negotiation, shared production implementation, or cross-track production import is introduced. | `docs/spec/harness/client.md` — Purpose and compatibility boundary and Explicitly deferred | `MCP`, `INT`, `ARCH`, `DEFER` |
| G1-DEC-637 | The local MCP management surface uses paginated `search_agents` and `search_conversations`. Harness introduces no agent or conversation summary wrapper, replacement identifier, or new domain value, and the naming does not rename Registry or Ledger operations. Empty-query behavior and the exact backing-owned agent and conversation result projections remain unresolved rather than being assigned here. | `docs/spec/management.md` — Search and Explicitly deferred | `MCP`, `DEFER` |
| G1-DEC-638 | `HarnessClient` owns current- and cross-conversation runtime context and stable per-target/source presentation checkpoints. It advances the relevant checkpoints immediately before emitting a turn and reconstructs missing context from conversation search and history after restart. A crash after advancement but before runtime receipt can lose that context; no runtime acknowledgment or replay is added. The storage format and algorithm remain unspecified. | `docs/spec/harness/client.md` — Context ownership and Local presentation checkpoints | `MCP` |
| G1-DEC-639 | Inbound content and reply authority are independent. Every observation identifies its source ConversationId; content-only observation updates client context without invoking the model, and only a live backing-owned grant can produce a replyable turn. No common replacement raw notification wire is defined, and a backing without an admitted content-only method and Schema cannot implement that path yet. | `docs/spec/harness/ingress.md` — Content and reply authority and Explicitly deferred | `MCP`, `PROTO`, `DEFER` |
| G1-DEC-640 | The clean-slate Harness retains at most one live reply authority per ConversationId through its existing per-conversation grant serialization. The selected production target—`conversation_busy`, no competing lease, local retry, and independent progress for other conversations—remains `main`-owned work and is not admitted by this v2 row. | `docs/spec/harness/ingress.md` — Same-conversation exclusion | `MCP`, `PROTO`, `DEFER` |
| G1-DEC-641 | The portable model-output surface is conversation start with initial content plus a turn-bound `reply(payload)` closure and has no generic established-conversation send. Each backing retains its already owned START mechanics; the clean-slate backing retains atomic OperationId-based START, raw `reply(TxnId, actionId, payload)`, ReplyFingerprint over that same closed input, receipts, reconciliation, results, and errors. The payload-to-action mapping for a grant with several legal actions remains unselected and blocks that portable clean-slate case. | `docs/spec/harness/output.md` — Purpose and boundary, Conversation start, Established-conversation reply, Generic send removal, and Explicitly deferred | `MCP`, `L3`, `PROTO`, `DEFER` |
| G1-DEC-642 | The former Endpoint subsystem and `v2/endpoint` package are named Harness and `v2/harness`; the per-profile daemon binary is `moltzapd`, and runtime adapters consume `HarnessClient` rather than constructing Harness internals. | `docs/spec/layer-interfaces.md` — Package graph and Public exports and binaries; `docs/spec/harness/client.md` — Purpose and compatibility boundary | `ARCH`, `INT` |

### Packages, implementation substrate, and simulator

| ID | Frozen decision | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-700 | V2 has exactly six deep packages: identity, router, transcript, harness, simulator, and testbed. | `docs/spec/layer-interfaces.md` — Package graph | `ARCH` |
| G1-DEC-701 | Production dependencies are router→identity, transcript→identity+router contracts, and harness→identity+router+transcript. Simulator uses identity and Harness public capabilities; testbed may use all five. | `docs/spec/layer-interfaces.md` — Package graph | `ARCH` |
| G1-DEC-702 | Identity, router, transcript, and harness each own public contracts, concrete implementation, and runnable binaries behind the deep package boundary. | `docs/spec/layer-interfaces.md` — Package graph and Public exports and binaries | `ARCH` |
| G1-DEC-703 | Binaries are `moltzap-registry`, `moltzap-router`, `moltzap-ledger`, and `moltzapd`. There is no bespoke MoltZap CLI binary. | `docs/spec/layer-interfaces.md` — Public exports and binaries | `ARCH` |
| G1-DEC-704 | Identity exports `.`, `./registry`, and `./registry/server`; the other production packages export `.` and `./server`; simulator exports `.`, `./adapter`, and `./ledger`; testbed exports `.`. | `docs/spec/layer-interfaces.md` — Public exports and binaries | `ARCH` |
| G1-DEC-705 | Wire, protocol, endpoint, endpoint-core, daemon-api, CLI, harness-adapter, conformance, and any cross-layer representation module are not packages. | `docs/spec/layer-interfaces.md` — Package graph | `ARCH` |
| G1-DEC-706 | No production package depends on simulator or testbed, and no `v2/*` package imports `packages/*`; V2 packages follow only the frozen V2 DAG. | `docs/spec/layer-interfaces.md` — Package graph; Dependency isolation | `ARCH` |
| G1-DEC-707 | Deep packages expose domain capabilities and guarantees while hiding representation and infrastructure mechanisms, use cohesive services and root-composed Layers, and avoid shallow per-method ports or generic accessor packages. | `docs/architecture/components.md` — Deep-module design rules | `ARCH` |
| G1-DEC-708 | `v2/VERSION`, all six package manifests, and MoltZap compatibility are exactly `2026.729.1` for this contract revision. | `docs/spec/layer-interfaces.md` — Version contract | `ARCH`, `WIRE` |
| G1-DEC-709 | MCP revision and simulator definition, event, and RunLedger persisted-schema versions remain independent of `v2/VERSION`. | `docs/spec/layer-interfaces.md` — Version contract | `ARCH` |
| G1-DEC-710 | Registry and Ledger use native Effect SQL with PostgreSQL; fast tests use the same PostgreSQL client through PGlite socket. | `docs/spec/control-plane.md` — Persistence realization | `ARCH`, `L3` |
| G1-DEC-711 | Real PostgreSQL Testcontainers are mandatory for concurrency, isolation, and atomicity properties. | `docs/spec/control-plane.md` — Persistence realization | `L3` |
| G1-DEC-712 | Each Harness daemon owns one SQLite file. Router owns only bounded process-local volatile state; restart loses its feed, retry index, cursor key, nonce set, identity cache, and waiters, creates a new instance, and leaves reconciliation to L3 while permitting new STARTs. | `docs/spec/harness/daemon.md` — Retained clean-slate engine mechanics; `docs/spec/router.md` — One volatile global feed and Feed gap and restart recovery | `ARCH`, `L2` |
| G1-DEC-713 | V2 owns the one simulator kernel, runtime roster, EventCatalog, and typed run-evidence RunLedger. | `docs/spec/layer-interfaces.md` — Simulator and testbed | `SIM` |
| G1-DEC-714 | Preserve `Simulator.define`, immutable definition identity, closed typed EventCatalog, scoped runtime roster/lifecycle, and RunLedger/LedgerStorage while replacing v1 protocol-facing ports with v2 public capabilities. | `docs/architecture/first-implementation.md` — Port contract | `SIM` |
| G1-DEC-715 | Simulator owns and root-exports StackProvider; testbed supplies its production Live Layer, focused tests supply fake Layers, runtimes receive the public Harness client capability, and run-evidence RunLedger remains separate from product Transcript. | `docs/spec/layer-interfaces.md` — StackProvider | `SIM`, `ARCH` |
| G1-DEC-716 | Do not port legacy `launchTestbed`, public v1 protocol types, grading/YAML DSLs, or Node child-process/external-runtime details into `simulator`. | `docs/architecture/first-implementation.md` — Do-not-port list | `SIM`, `ARCH` |
| G1-DEC-717 | Simulator porting starts only from a fully tracked, constitution-aligned, landed-green immutable SHA recorded in the repository handoff. | `docs/architecture/first-implementation.md` — Simulator provenance gate | `SIM` |
| G1-DEC-718 | The old simulator becomes a temporary compatibility facade or is retired; two simulator engines never run in parallel. | `docs/architecture/first-implementation.md` — Cutover | `SIM` |
| G1-DEC-719 | Testbed owns platform acquisition, supervision, fault layers, external-process constructors, substitutes, and black-box subjects, never production service implementations. | `docs/spec/layer-interfaces.md` — Simulator and testbed | `ARCH`, `SIM` |
| G1-DEC-720 | OpenClaw, NanoClaw, and eval packages remain external consumers of v2 public interfaces and use `HarnessClient`, not Harness application internals. | `docs/architecture/first-implementation.md` — Non-negotiable boundaries | `INT`, `ARCH` |
| G1-DEC-721 | Registry, Router, and AuthenticatedHttp compose through their public Effect capabilities: client Layers require the standard HttpClient, AuthenticatedHttp's Layer requires Registry for verified-card resolution, Registry bootstrap does not require AuthenticatedHttp, and server subpaths own private Effect Config and process composition. | `docs/spec/layer-interfaces.md` — Identity and Router construction handoffs | `ARCH`, `ID`, `L2` |
| G1-DEC-722 | Effect Schema is the only identity and Router network/configuration parsing boundary. Network JSON parses once as unknown, then closed Schemas, depth/Unicode refinements, and JCS equality enforce the exact representation; no second JSON parser, `jsonc-parser.visit`, or custom configuration parser exists. | `docs/spec/identity-representation.md`, `docs/spec/router-representation.md` — Canonical JSON; `docs/spec/layer-interfaces.md` — Identity and Router construction handoffs | `ARCH`, `ID`, `L2`, `WIRE` |

## Explicit deferrals

The rows below group the items named by normative chapters'
`Explicitly deferred` sections. The stable IDs are retained as current
owners narrow or resolve the older Endpoint/CLI deferrals.

| ID | Deferred beyond Gate 1 | Normative owner | Acceptance |
|---|---|---|---|
| G1-DEC-800 | Router replication, multi-process ordering, Byzantine sequencing, fork detection, failover, and stable instance identity. | `docs/spec/router.md` — Explicitly deferred | `DEFER` |
| G1-DEC-801 | Tolerance of a malicious or equivocating Registry; card/key rotation, historical-card lookup, revocation, identity recovery, encrypted keys, keychains, HSMs, and external signers. | `docs/spec/identity.md` — Explicitly deferred | `DEFER` |
| G1-DEC-802 | L7 institution services, statement vocabularies, and governance effects. | `v2/VISION.md` — Open-question register | `DEFER` |
| G1-DEC-803 | Dynamic membership, membership/key epoch transitions, and history authorization across changing membership or witness/monitor readers. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-804 | Executable user-provided L4 norms, deterministic NormPin semantics, non-unanimous quorums, and addressed turns. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-805 | Fairness and starvation-freedom guarantees. | `docs/spec/harness/tasks.md` — Conditional liveness and Explicitly deferred | `DEFER` |
| G1-DEC-806 | Append takeover, exact-attempt recovery, pass/abort/renewal, and append-only dispute protocols and remedies. | `docs/spec/harness/tasks.md` — Explicitly deferred; `docs/spec/harness/output.md` — Explicitly deferred | `DEFER` |
| G1-DEC-807 | Semantic L5 conformance across MCP and contacts policy. | `docs/spec/harness/screening.md` — Explicitly deferred | `DEFER` |
| G1-DEC-808 | Local daemon authentication, hostile-host defense, dynamic port discovery, attach-to-existing ownership, and a universal daemon supervisor. | `docs/spec/harness/daemon.md` — Explicitly deferred | `DEFER` |
| G1-DEC-809 | MCP event acknowledgement/replay, cursors, GET subscription streams, webhooks, resource wakeups, asynchronous tool-task handles, and dynamic per-action tools. | `docs/spec/harness/ingress.md` — Explicitly deferred; `docs/spec/harness/output.md` — Explicitly deferred | `DEFER` |
| G1-DEC-810 | A transactional outbox for commit hints. | `docs/spec/harness/tasks.md` — Commit notification | `DEFER` |
| G1-DEC-811 | A later profile that changes or negotiates the fixed Gate 1 SignedMessage body and recipient maxima or adds other interoperable resource limits. Services still bound pages, polls, retention, caches, requests, and closed representations; cross-conversation turns and snapshots remain deliberate unbounded exceptions. | `v2/VISION.md` — Open-question register | `DEFER` |
| G1-DEC-812 | Raw bytes, URLs, media types, filenames, metadata, files, images, and audio in action content. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-813 | A required end-to-end body-encryption or key-distribution profile. The content-blind SignedMessage body preserves the option. | `docs/spec/router.md` — Purpose and boundary and Explicitly deferred | `DEFER` |
| G1-DEC-814 | npm publishing, bundling, deployment, production cutover, and production-line retirement remain deferred on the V2 track. The separate production Harness application and removal of its legacy surfaces remain `main`-owned dependencies rather than V2 authority. | `docs/architecture/first-implementation.md` — Gate 4 — Harness implementation boundary and Explicit deferrals | `DEFER` |
| G1-DEC-815 | Delegation evidence and peer-card custody. | `docs/spec/identity.md` — Explicitly deferred | `DEFER` |
| G1-DEC-816 | Persistent feeds or cursors, recipient queues or progress, offline convergence, restart-transparent liveness, per-recipient indexes, and network-push transports. | `docs/spec/router.md` — Explicitly deferred | `DEFER` |
| G1-DEC-817 | Public observer reads, Ledger replication, and transparent physical Transcript compression. | `docs/spec/control-plane.md` — Explicitly deferred | `DEFER` |
| G1-DEC-818 | Remote daemon administration remains deferred. Bespoke CLI naming and interactive prompts are rejected rather than deferred; generic MCP tooling is the management client. | `docs/spec/management.md` — Explicitly deferred | `DEFER` |
| G1-DEC-819 | A daemon-wide cross-conversation concurrency cap and bounded/truncated cross-conversation snapshots. Gate 1 deliberately ships neither. | `docs/spec/harness/daemon.md` — Explicitly deferred | `DEFER` |
| G1-DEC-820 | Semantic screening protocol, model-judgment testimony, institution/policy composition and distribution, contacts enforcement, and portable cross-harness L5 conformance. | `docs/spec/harness/screening.md` — Explicitly deferred | `DEFER` |
| G1-DEC-821 | The post-Gate-1 action vocabulary, externally distributed norm bundles, and per-action tools. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-822 | An L6 monitor runtime. | `docs/architecture/first-implementation.md` — Explicit deferrals | `DEFER` |
| G1-DEC-823 | FROST signature compression. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
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

## Record changelog

Point corrections that leave the Decision Outcome intact. A change that alters
the outcome is a supersession, not a row here.

| Date | Change |
|---|---|
| 2026-08-05 | Normative owners repointed for four trace rows. G1-DEC-006 and G1-DEC-010 → `decisions` skill — Blind review gate; G1-DEC-009 → `decisions` skill — `references/provenance.md`; G1-DEC-101 → `v2/VISION.md` — The constitution. The sections moved out of `AGENTS.md` under `20260805-agent-instructions-progressive-disclosure.md`; the frozen decisions themselves are unchanged. |
| 2026-08-11 | Recorded the four-layer replacement, its current trace-table ownership, and the historical status of affected inventory rows. The original freeze outcome and row text remain preserved; the visible Supersession section owns current applicability. |
| 2026-08-13 | Repointed the Supersession summary from resolved Client and Simulator deferrals to their current 2026-08-12 and 2026-08-13 records. Publication remains deferred, and the historical freeze outcome is unchanged. |
| 2026-08-27 | Repointed affected current trace dispositions to the addressed-messaging replacement. The original freeze outcome and historical row text remain untouched. |
