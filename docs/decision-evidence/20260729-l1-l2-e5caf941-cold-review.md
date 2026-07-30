# Blind teammate review artifact

This file mechanically records the completed fresh-agent review. The
artifact write occurred after the review and did not revise or
re-evaluate any answer.

## Original procedural prompt

```text
Perform the repository's blind teammate review gate against candidate repository root /home/tapanc/moltzap at commit e5caf9419e891eee1453a674835d64231fd80ece (tree 6de4dd6e2b6667a61bddf7e308b76f228fabfb70; git-archive SHA-256 2b8f8b07513120b56e2d0527f24c6adfbca3721eead76cd37281fe89caaa264f).

Isolation rules: You are a fresh reviewer with no inherited conversation, compaction, memory, private state, or earlier blind-review output. Inspect only the candidate repository. Do not open, read, or search the contents of any *-cold-review.md or invalid-review record; those are quarantined inputs. Merely seeing an artifact path in a directory listing or history is allowed. If any command returns an answer or verdict from a quarantined record, stop and mark the run invalid. Do not ask the author for hints. No author intervention will be provided.

Ask and answer these questions verbatim:

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Return: candidate identity; reviewer identity and isolation attestation; start/end UTC timestamps and duration; the exact prompt above; unedited answers; independently discovered paths/headings; discovery trail; any author interventions; a PASS/FAIL verdict for each question with reasons; blockers; and overall PASS/FAIL. PASS requires all six answers to be accurate and discoverable with consistent status, lineage, authority, assumptions, normative ownership, and source-event attribution. Any wrong or unfindable answer, broken source locator, unresolved contradiction, invented binding choice, or need for an author hint is FAIL. Do not edit the repository.
```

## Exact returned review

# Blind teammate review record

## Candidate identity

- Repository root: `/home/tapanc/moltzap`
- Commit: `e5caf9419e891eee1453a674835d64231fd80ece`
- Tree: `6de4dd6e2b6667a61bddf7e308b76f228fabfb70`
- Parent: `28075cbe8eb4abd5eab0bc4dbf0998de7b35131a`
- Commit subject: `docs(v2): reconcile L1 and L2 authority review`
- Git-archive SHA-256: `2b8f8b07513120b56e2d0527f24c6adfbca3721eead76cd37281fe89caaa264f`
- Archive verification: exact match
- Review start: `2026-07-29T22:10:18Z`
- Review end: `2026-07-29T22:17:54Z`
- Duration: `00:07:36`

## Reviewer identity and isolation attestation

Reviewer: fresh Codex agent `/root/blind_authority_review_e5caf941`.

I received only the candidate repository root, candidate identity, isolation rules, and six fixed questions. I had no inherited author conversation, compaction, private state, prior review answers, or author hints.

The path `docs/decision-evidence/20260729-l1-l2-28075cbe-cold-review.md` appeared in the candidate commit’s name-only listing. I did not open, read, or search its contents. I did not open, read, or search any other `*-cold-review.md` or invalid-review record.

No author intervention occurred.

## Exact prompt

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

# Unedited answers

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate makes one coordinated L1/L2 authority state current:

- V2’s checked-in authority lives on the `v2` track rather than requiring a prior authoritative copy on `main`.
- L1 and L2 own separate representation chapters and acceptance evidence. There is no current cross-layer wire catalog, shared vector-corpus abstraction, or generic public codec/wire package.
- L1 uses closed RFC 8785 JCS JSON, exact Ed25519 JWKs, attached one-signature General JWS AgentCards and SignedMessages, and an identity-owned `AuthenticatedHttp` capability implementing the normal and registration RFC 9421 profiles.
- L2 uses the `router` package. Its global order is private; public continuation is an opaque, client-held Compact-JWE `PollCursor`. An accepted send returns the current RouterInstanceId and Router-owned SignedMessageDigest.
- Router state is one bounded, volatile global ring plus coupled retry, nonce, identity-cache, and request-scoped waiter state. It has no durable feed, recipient queue, per-recipient advancement, session, cursor record, conversation state, or recovery semantics.
- Application processes impose no TLS, URL-scheme, certificate, or trusted-proxy policy. Request signatures do not protect unsigned responses, so deployments whose threat model includes network-path tampering supply bidirectional channel integrity outside the application processes.
- This candidate changes only L1/L2 representation and related package/authority concerns. L3, L4, endpoint-daemon, and MCP semantic outcomes remain current.

This resolves four central conflicts:

- `main`-first versus V2-track authority;
- one cross-layer byte catalog versus layer-owned representations;
- X.509/CBOR/COSE and application-owned TLS versus JCS/JOSE/RFC 9421 with deployment-owned channel protection for L1/Router;
- exposed Router positions and delivery-state semantics versus a private order and opaque, client-held continuation.

Binding authority is:

1. `AGENTS.md` and `v2/VISION.md`;
2. accepted ADR Decision Outcomes and explicitly retained portions of partially superseded ADRs;
3. normative chapters under `docs/spec/`.

Within the current ADRs, the explicit Binding outcome, guarantees, scope boundaries, and deliberate deferrals are current. Exact representation and observable behavior live in their normative specification owners.

ADR Context and Problem Statement, Considered Options, historical bodies of superseded records, and Consequences are explanatory or historical. The compacted trajectory is explicitly non-normative evidence. `docs/architecture/l1-l2-implementation-ask.md` is an approved execution handoff, not normative protocol authority. Its private Effect RPC composition and other implementation mechanisms cannot override the current ADRs or specifications.

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

Fully replaced:

- `20260722-spec-lives-on-main.md`: V2 authority now lives with V2.
- `20260729-wire-profile-assigns-every-gate-1-byte.md`: there is no current cross-layer catalog or shared corpus.
- `20260721-x509-card-container.md`: L1 AgentCard is JCS/General JWS with an exact Ed25519 JWK.
- Historical interim registration, request-signature, X.509, and cross-layer encoding outcomes where their Supersession sections point to the new identity or representation ADRs.

Partially replaced:

- `20260728-gate-1-architecture-freeze.md`: its authority chain, traceability inventory, review gate, layer constitution, later-layer semantics, and explicit deferrals remain; main-first, cross-layer representation, old L1 wire, TLS, exposed Router-order, and package-name rows are replaced.
- `20260728-gate-1-identity-profile.md`: immutable card/key, AgentName, correct Registry assumption, sole pre-card registration, PKCS#8 proof, positive caching, and absent lifecycle features remain; X.509, routes in cards, CBOR/COSE, embedded cards in ordinary requests, and application TLS are replaced.
- `20260728-network-wire-is-http-post-polling.md`: separate POST operations, no WebSocket/network JSON-RPC, 25-second endpoint-wide poll, send modes, instance fencing, retained retry behavior, and plane separation remain; encoding, poll route, exposed order/cursor behavior, response details, and TLS requirements are replaced.
- `20260728-six-deep-packages-one-version.md`: six packages, exports, dependency isolation, and one CalVer remain; `transport` becomes `router`, `moltzap-directory` becomes `moltzap-registry`, and affected DAG names change.

Explicitly retained or untouched:

- The layer/fault model: potentially Byzantine endpoints, one correct non-equivocating Registry, one correct non-equivocating Router, and one correct durable Ledger.
- L3 conversations, retries, recovery, COSE/CBOR certificate and Transcript representation, Ledger semantics, OpenFloorV1, daemon persistence, local MCP, and runtime attention semantics.
- The six-package count and shared MoltZap version.
- V1 authority on `main`, forward merges from `main` to `v2`, and npm publication from `main` before cutover.
- Later-layer representation choices are neither replaced nor inferred from the superseded cross-layer catalog.

Current normative owners:

- Authority and system law: `AGENTS.md`, `v2/VISION.md`.
- L1 semantics: `docs/spec/identity.md`.
- L1 exact representation: `docs/spec/identity-representation.md`.
- L2 semantics: `docs/spec/router.md`.
- L2 exact representation: `docs/spec/router-representation.md`.
- Package/type/cross-layer laws: `docs/spec/layer-interfaces.md`.
- Retained L3 storage contract: `docs/spec/control-plane.md`.
- Traceability and normative-owner index: `docs/decisions/20260728-gate-1-architecture-freeze.md`.
- Current ADR outcomes:
  - `20260729-v2-authority-lives-with-v2.md`
  - `20260729-representations-are-layer-owned.md`
  - `20260729-identity-uses-jcs-jose-authenticated-http.md`
  - `20260729-router-order-is-opaque.md`

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- Keep exactly six packages and use `identity`, `router`, `transcript`, `endpoint`, `simulator`, and `testbed`.
- Keep version `2026.729.1` in `v2/VERSION`, all six package manifests, and MoltZap-owned L1/L2 representations.
- Implement exact closed JCS decoding, strict base64url/refined values, exact Ed25519 public JWKs, one-signature attached General JWS AgentCards and SignedMessages, exact digests, and the stated rejection rules.
- Implement `AuthenticatedHttp` as the deep L1 boundary, including framing, request signatures, time/nonce/admission handling, validation precedence, replay claims, and closed envelope failures.
- Configure Registry clients with the deployment-pinned Registry signer JWK and verify returned cards plus request/result bindings before constructing verified domain values.
- Implement Registry registration, lookup, list, persistence, conflict precedence, restart metadata, and operational bounds.
- Implement Router send and poll at `/v1/messages:send` and `/v1/messages:poll`, with a private bigint order, one bounded global feed, coupled retry index, opaque JWE cursor, exact feed-gap rule, restart fencing, request-scoped waiters, and no durable state.
- Preserve SignedMessage body opacity and byte identity.
- Keep typed domain outcomes separate from envelope, transport, and malformed-response errors.
- Follow the staged public-name and per-slice readability gates in the implementation ask.

An implementer must avoid:

- Reintroducing X.509, deterministic CBOR/COSE, or MessagePack for L1 artifacts or Registry/Router HTTP.
- Treating retained L3 CBOR/COSE as replaced.
- Exporting Router order, `RouterSequence`, delivery wrappers, per-recipient progress, or durable cursor semantics.
- Creating a generic public wire, codec, serialization, protocol, or shared vector-corpus package.
- Letting Router interpret ConversationId, membership, TxnId, protocol bodies, tasks, norms, or policy.
- Adding application TLS termination, scheme enforcement, certificate loading, or trusted-proxy policy.
- Treating request signatures as response authentication or confidentiality.
- Treating SignedMessageDigest as ordering, delivery, durability, or recipient evidence.
- Importing `packages/*` from V2 or violating the frozen package DAG.
- Guessing unapproved public names.

Affected layers and consumers:

- Directly: L1 identity/Registry/AuthenticatedHttp and L2 Router.
- Cross-layer contract consumers: endpoint daemon and transcript package consume L1 identities and public Router contracts without acquiring L2 semantics.
- CLI uses registration and public Registry reads but does not become a Router client.
- Simulator, testbed, OpenClaw, and NanoClaw remain public-interface consumers; their later semantic contracts are unchanged.
- L3/L4/MCP are affected only where they refer to public L1/L2 values, route names, instance fencing, or package names.

Assumptions:

- Endpoints may be Byzantine.
- Registry is correct and non-equivocating; malicious or conflicting Registry issuance is outside Gate 1.
- Router is one correct, non-equivocating volatile process.
- Ledger is correct, durable, and mechanically validates closed certificates.
- Registry, Router, Ledger, or required-member unavailability may halt progress.
- Safety does not depend on timing. OpenFloor progress requires fixed members and required services to act within the 90-second TTL.
- Router restart, retention loss, or invalid continuation may stop transparent progress; L2 does not promise durable replay, offline convergence, or restart-transparent liveness.
- Router responses are unsigned. The L2 ordering guarantee assumes the endpoint receives the correct response without path modification.
- Pinned cards and self-contained records remain verifiable during Registry outage; unseen identities do not.
- One honest required endpoint can prevent an invalid unanimous certificate; a unanimously malicious certificate is outside semantic-validity guarantees.
- Router replication, fork detection, Byzantine sequencing, and malicious-Registry tolerance are unclaimed.

Compatibility:

- MoltZap L1/L2 compatibility is exact CalVer `2026.729.1`.
- MCP `2026-07-28` and simulator persisted-schema versions are independent.
- L3 and later representations remain under their existing contracts.
- V1 remains authoritative and publishable from `main`; V2 does not merge back before a separate cutover decision.

## 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

The current ADRs and the partially superseded freeze name one human decision-maker: **Tapan Chugh**.

All cited L1/L2 events come from Codex CLI rollout session `019fac90-d26a-7e51-8708-06858bd118bd`. The trajectory states that retained response items lack parent locators.

Principal cited calls:

- V2 authority:
  - Prompt `fc_0d0c5bdb13a3d3c4016a69a6a257948190b51618dda4813aa0`, `2026-07-29T07:07:18.221Z`.
  - Answer `fco_019facb5-464c-7ec0-9230-1d147fa2b9ef`, `2026-07-29T07:09:49.004Z`: `Own them on v2 (Recommended)`.

- Representation ownership:
  - User event `msg_019fae74-8382-7530-b3b9-1d6dd3ed5e3e`, `2026-07-29T15:18:19.266Z`: `separate documents one per layer`.
  - Prompt `fc_0d0c5bdb13a3d3c4016a6a1a0832408190a4f3efb285a12710`, `2026-07-29T15:19:40.300Z`.
  - Answer `fco_019fae76-9fff-7043-95be-d074a0b69464`, `2026-07-29T15:20:37.631Z`: `Repeat per layer`.
  - User challenge `msg_019fae76-f1c4-7612-902e-9763718af9ab`, `2026-07-29T15:20:58.564Z`: `actually why do we need cross-layer things`.
  - Later scope events explicitly say to focus only on L1/L2, restore L3/L4 documents, reject the cross-layer wire profile, and retain already discussed later-layer vocabulary:
    - `msg_019faf74-e678-7ab3-8b27-090394ccf237`
    - `msg_019faf77-25d7-7f41-aa0d-4784aac3162f`
    - `msg_019faf78-2bdf-7113-a819-75d66749f12d`
    - `msg_019faf79-b813-7583-997f-21a260009256`

- Identity stack:
  - MessagePack was raised at `msg_019fae7c-8c8d-7802-8c93-a50a36905623`; the structured MessagePack choice was aborted and recorded no selection.
  - JOSE/JSON prompt `fc_0d0c5bdb13a3d3c4016a6a1e89b14c81909e6b518dd9dccdf1`; answer `fco_019fae87-669d-7071-a217-67d52b651646`, `2026-07-29T15:38:57.053Z`: `Adopt JOSE/JSON (Recommended)`.
  - JWS/AgentId/JCS answer `fco_019fae8c-c55e-7a11-8e3d-e8b6844146a5`, `2026-07-29T15:44:48.990Z`: JSON forms only, opaque AgentId, and no JCS option selected.
  - Canonical-network-JSON answer `fco_019fae92-c987-7c02-896b-f57d45c730b1`, `2026-07-29T15:51:23.271Z`: `Canonical network JSON (Recommended)`.
  - General-JWS/adapter/numeric answer `fco_019fae97-3f50-73b1-8e30-1b25eeb257db`, `2026-07-29T15:56:15.568Z`: General JWS everywhere, Shared adapter library, Safe JSON numbers.
  - The later deep-module exchange did not select either listed ownership option. The subsequent ownership answer `fco_019faea3-ef76-7623-a5a4-08c4221d4071`, `2026-07-29T16:10:07.094Z`, selected `Inside identity (Recommended)`.
  - Name/carriage/error answer `fco_019faec0-0da3-7142-a3d0-fcbc6fa4e3d8`, `2026-07-29T16:40:49.827Z`: `AuthenticatedHttp`, Registry lookup rather than embedded card, and one `authentication_failed`.
  - Depth answer `fco_019faf1f-7822-7bc0-aaad-3b69af0d0e25`, `2026-07-29T18:25:03.010Z`: `Deep narrow boundary (Recommended)`.

- Router:
  - Package-name answer `fco_019faea1-3183-74f0-8ff4-250e7bf001fe`, `2026-07-29T16:07:07.395Z`: `Rename to router (Recommended)`.
  - Position answer `fco_019faea8-efeb-7523-bf52-a3902b63ddf1`, `2026-07-29T16:15:34.891Z`: `Redesign as opaque`.
  - Continuation/send-result answer `fco_019faec4-022b-7291-a4a1-2a79c4ecefaf`, `2026-07-29T16:45:09.035Z`: opaque server token, accepted message digest, and after-domain-ID pagination.
  - The immediately following user event `msg_019faec4-0251-7d00-ac49-3df4b0c7e1d1` says only `record this alternative`; its referent is not proven.
  - Poll restart was initially deferred by `fco_019faec7-667a-78f0-94b6-53c6f5ceed82`, then revisited. `fco_019faeeb-78aa-73c0-9aea-8691300059d6`, `2026-07-29T17:28:15.274Z`, selected `No, invalid cursor`.
  - User event `msg_019faefb-d4dd-7d72-b85d-177f665e9707` required the cursor design to remain lightweight without server-side cursor state.
  - PollCursor answer `fco_019faefc-cd94-7bb3-a64d-7c0a34fb0c02`, `2026-07-29T17:47:11.124Z`: `Compact JWE (Recommended)`.
  - Initial TLS answer `fco_019faefe-d122-7e72-ada6-75469050d7ac` selected deployment-edge TLS but retained client scheme rejection.
  - Later user event `msg_019faeff-730d-73a3-9343-72b3d40a69d6`, `2026-07-29T17:50:04.557Z`, states there should be no mandatory non-loopback TLS termination in code and TLS is fully a deployment concern.
  - Global-ring answer `fco_019faf09-39ca-7381-aba7-0659ab2d4333`, `2026-07-29T18:00:45.258Z`: `One global ring (Recommended)`.

Explicit source gaps and qualifications:

1. Session account identity is absent. The session metadata does not bind the account to Tapan Chugh. The ADR name is an accountability statement requiring his review, not a fact derived from the session metadata.
2. `HarnessEndpoin` was literally supplied by the user; the agent normalized it to `HarnessEndpoint`. No later human event confirms that normalization.
3. `record this alternative` has an ambiguous referent; the agent interpreted it as the send-result alternative without later human confirmation.
4. The MessagePack structured choice was aborted and records no selection.
5. Shared-adapter ownership was revisited: a structured choice selected a shared adapter, a later free-form exchange selected no listed option, and a later prompt placed AuthenticatedHttp inside identity.
6. The initial TLS option was broadened by a later free-form instruction removing code-level scheme/TLS policy.
7. “Stateless PollCursor” is not “fully stateless Router”; the trajectory explicitly preserves bounded volatile Router state.
8. The original simulator decision session was not located. The trajectory records that source gap rather than reconstructing it.
9. Agent-authored plans and mechanical repository events are labeled as such and are not attributed as human architecture decisions.

## 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest apparent contradiction is the retained historical body of `20260728-network-wire-is-http-post-polling.md`. It still says deterministic CBOR, `/v1/deliveries:poll`, and the earlier TLS behavior, while the current Router contract says canonical JSON, `/v1/messages:poll`, private order, opaque cursor, and no application TLS policy.

This is resolved, not a blocker:

- Its frontmatter is `partially-superseded`.
- Its immediately visible Supersession section identifies exactly what remains current and points to the identity and Router replacements.
- `docs/decisions/README.md` states that only the Supersession-retained portion of a partially superseded record remains current.
- Current ADR outcomes and the normative identity/Router chapters outrank the historical body.

A related apparent conflict is that `docs/spec/control-plane.md` still specifies deterministic CBOR/COSE for Ledger while the identity ADR calls CBOR/COSE non-current. The identity ADR now scopes that statement to L1 artifacts and Registry/Router HTTP representations and explicitly says it does not replace retained L3 representation. The representations ADR likewise leaves L3 and later representations untouched. Therefore the Ledger’s retained CBOR/COSE contract is consistent.

No unresolved contradiction, stale binding instruction, or broken lineage was found. All 43 ADR records matched the decision index, every non-accepted record had a visible Supersession section and existing primary replacement, and every ADR had provenance.

## 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Yes, the current L1/L2 protocol, package, persistence, failure, and test contracts are implementable from the repository without reconstructing chat. Exact semantic and representation owners, routes, schemas, validation order, retry behavior, resource outcomes, trust assumptions, package graph, staged slices, and tests are all discoverable.

A teammate cannot complete every slice without any future human interaction because the repository deliberately schedules human gates. It explicitly prohibits guessing at them.

Scheduled human gates, not implementation discretion:

- Literal Registry and Router configuration-key suffixes.
- Any public export name not already approved by the vocabulary table or governing specifications.
- The exact public type name for client response-validation failures.
- Per-slice readability and vocabulary dispositions.

Deliberate deferrals:

- Exact future `HarnessEndpoin`/`HarnessEndpoint` spelling.
- L3-or-later replacement representations.
- Key rotation, revocation, recovery, delegation, encrypted keys, keychains, HSMs, and external signers.
- Malicious or equivocating Registry tolerance.
- Router persistence, replication, failover, stable instance identity, Byzantine sequencing, and fork detection.
- Per-recipient indexes, queues, durable advancement, network push, and restart-transparent liveness.
- End-to-end body encryption and key distribution.
- Application-owned TLS.
- The eleven post-Gate-1 questions in `v2/VISION.md`, including later actions/membership, author-failure recovery, institutions/governance, monitor access, later MCP behavior, interoperable resource maxima, compression, and malicious-Registry tolerance.
- Deployment manifests, publishing, cutover, V1 retirement, and branch consolidation.
- Simulator-port work until its separate provenance manifest names a reconstructible SHA.

Provenance gaps that do not prevent L1/L2 implementation:

- The trajectory cannot bind the session account to Tapan Chugh.
- The original simulator decision source was not located.
- Several literal exchanges are explicitly marked aborted, ambiguous, broadened, or agent-interpreted.

Accidental implementation gaps found: **none**.

The absence of restart-transparent handling for every `cursor_invalid` case is not an accidental L2 promise: old-key cursors deliberately collapse with other invalid cursors, omitted-cursor anchoring and send-side `router_restarted` are the available instance-discovery paths, and restart-transparent liveness is explicitly excluded.

# Independently discovered paths and headings

- `AGENTS.md`
  - `Constitution`
  - `Architecture decision records`
  - `Blind teammate review gate`
  - `Docs`
- `v2/AGENTS.md`
  - `Authority and reading order`
  - `Structure`
  - `Implementation rules`
  - `Simulator provenance gate`
- `v2/VISION.md`
  - `Authority`
  - `The constitution`
  - `Gate 1 profile`
  - `Trust and failure envelope`
  - `Processes and persistence`
  - `Open-question register`
- `docs/decisions/README.md`
  - `Canonical reading guidance`
  - `Records`
- Current focused ADRs:
  - `V2 authority lives with V2`
  - `L1 and L2 representations are layer-owned`
  - `Identity uses JCS, JOSE, and AuthenticatedHttp`
  - `Router order is opaque`
- `docs/decisions/20260728-gate-1-architecture-freeze.md`
  - `Supersession`
  - `Normative owner`
  - `Gate 1 traceability inventory`
  - `Explicit deferrals`
- `docs/spec/identity.md`
  - `Trust and failure assumptions`
  - `AgentCard`
  - `AuthenticatedHttp`
  - `Deployment channel`
- `docs/spec/identity-representation.md`
  - `Canonical JSON`
  - `AgentCard`
  - `SignedMessage`
  - `AuthenticatedHttp framing`
  - `Exact envelope precedence`
- `docs/spec/router.md`
  - `Process and trust model`
  - `Send`
  - `One volatile global feed`
  - `Poll`
  - `Feed gap and restart recovery`
  - `Operational bounds`
- `docs/spec/router-representation.md`
  - `PollCursor`
  - `Send`
  - `Poll`
- `docs/spec/layer-interfaces.md`
  - `Package graph`
  - `L1 and L2 representation ownership`
  - `Cross-layer laws`
- `docs/spec/control-plane.md`
  - `Common HTTP contract`
  - `Certified action`
  - `Mechanical admission`
- `docs/architecture/l1-l2-implementation-ask.md`
  - `Human gates`
  - `Authority gate`
  - `Shared implementation principles`
  - `Implementation slices`
  - `Explicit deferrals`
- `docs/decision-evidence/20260729-l1-l2-implementation-trajectory.md`
  - `Source record and compaction method`
  - `V2 authority lives with V2`
  - `Representations are layer-owned`
  - `Identity uses JCS, JOSE, and AuthenticatedHttp`
  - `Router order is opaque`
  - `L1 and L2 only scope`
  - `Cross-cutting source gaps`

# Discovery trail

1. Verified commit, tree, parent, subject, changed-path names, and archive SHA-256.
2. Extracted the exact commit to a temporary isolated archive.
3. Read repository law and the decision index’s canonical reading guidance.
4. Followed the current focused ADRs and freeze trace rows to their normative owners.
5. Read L1/L2 semantic and representation chapters and the cross-layer package/recovery laws.
6. Followed each current ADR provenance link into the non-quarantined compacted trajectory.
7. Inspected superseded and partially superseded predecessors to verify replacement and retained scope.
8. Searched authoritative, normative, and architecture surfaces for stale terms including X.509, CBOR/COSE, `RouterSequence`, `/v1/deliveries:poll`, `transport`, TLS, PollCursor, and `router_restarted`, excluding all quarantined review records.
9. Verified 43 ADR frontmatter statuses against 43 decision-index rows, replacement targets, provenance presence, and Supersession-section requirements: zero problems.
10. Ran:
    - `pnpm docs:check:no-hardcoded-constants` — PASS.
    - `pnpm docs:check:doc-imports-resolve` — PASS.
    - `pnpm docs:check:gates-test` — PASS after adding a temporary package-local dependency symlink to the isolated archive. The initial run’s failures were solely missing temporary `node_modules/tsx` resolution, not candidate assertions.
    - `pnpm docs:check` — PASS, no broken links.
11. No repository files were edited.

# Per-question verdicts

| Question | Verdict | Reason |
|---|---|---|
| 1 | PASS | The current decisions, resolved problems, authority order, and binding/non-normative distinction are discoverable. |
| 2 | PASS | Supersession lineage, retained scope, untouched later layers, and normative owners are explicit and consistent. |
| 3 | PASS | Implementation obligations, prohibited designs, affected consumers, fault/trust envelope, liveness limits, and compatibility rules are complete. |
| 4 | PASS | The named decision-maker, native source locators, alternatives, reversals, deferrals, agent-only events, and source gaps are explicitly recorded without requiring inference. |
| 5 | PASS | The strongest stale historical text is resolved by visible status and Supersession sections; no broken lineage or unresolved contradiction remains. |
| 6 | PASS | L1/L2 is implementable from repository authority. Pending names and future functionality are clearly identified as scheduled human gates or deliberate deferrals; no accidental contract gap was found. |

## Blockers

None.

## Overall result

**PASS**

## Post-review reconciliation

The reviewer returned PASS without author intervention. The root agent
did not accept that result. After the review ended, a separate
configuration-vocabulary audit found that the lower-authority
implementation ask presented “held polls per AgentId | 1” as a
configurable default while normative `docs/spec/router.md` fixes
exactly one held poll per AgentId.

That missed contradiction blocks candidate
`e5caf9419e891eee1453a674835d64231fd80ece` despite the reviewer's
verdict. The implementation ask must make the value fixed and expose no
environment key for it. Because that is a semantic correction, a new
candidate and a different fresh reviewer are required.
