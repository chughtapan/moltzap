# L1 and L2 candidate `a261f4ee` blind teammate review

This file was added mechanically after the review completed. Its
addition does not revise, normalize, correct, or re-evaluate the
review answers.

## Original procedural prompt

```text
Perform the repository's blind teammate review gate against candidate repository root /home/tapanc/moltzap at commit a261f4ee939980e620e4996a146ab6fae744abba (tree 590b85fc7c54b59ed906e38ba22aeebfa2970fb9; git-archive SHA-256 0eb0315b033fd25f1a97362a3f89ba79be4d21fec1f9b7a3e00492c9e8270fdf).

Isolation rules: You are a fresh reviewer with no inherited conversation, compaction, memory, private state, or earlier blind-review output. Inspect only the candidate repository. Do not open, read, or search the contents of any *-cold-review.md or invalid-review record; those are quarantined inputs. Merely seeing an artifact path in a directory listing or history is allowed. If any command returns an answer or verdict from a quarantined record, stop and mark the run invalid. Do not ask the author for hints. No author intervention will be provided. Do not edit the repository.

Ask and answer these questions verbatim:

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Return: candidate identity; reviewer identity and isolation attestation; start/end UTC timestamps and duration; the exact prompt above; unedited answers; independently discovered paths/headings; discovery trail; any author interventions; a PASS/FAIL verdict for each question with reasons; blockers; and overall PASS/FAIL. PASS requires all six answers to be accurate and discoverable with consistent status, lineage, authority, assumptions, normative ownership, and source-event attribution. Any wrong or unfindable answer, broken source locator, unresolved contradiction, invented binding choice, or need for an author hint is FAIL. Do not edit the repository.
```

## Complete final review report

# Blind teammate review report

## Candidate identity

- Commit: `a261f4ee939980e620e4996a146ab6fae744abba`
- Tree: `590b85fc7c54b59ed906e38ba22aeebfa2970fb9`
- Parent: `edefd5bffa4d9cbb31c3b75d12119183e6612038`
- Git-archive SHA-256: `0eb0315b033fd25f1a97362a3f89ba79be4d21fec1f9b7a3e00492c9e8270fdf` — independently reproduced and matched
- Subject: `docs(v2): approve identity and Router implementation authority`

## Reviewer and isolation

Reviewer: `/root/blind_authority_review_a261f4ee`, fresh Codex teammate session.

I received no inherited conversation, compaction, memory, private state, design summary, file pointer, search term, or earlier review output. I inspected only an archive created from the specified candidate commit.

I saw quarantined artifact names only in directory and changed-path listings. I did not open, read, or search any `*-cold-review.md`, invalid-review record, or cold-review template. No command returned an answer or verdict from one. I requested no author hints, and there were no author interventions. The repository was not edited; final git status remained clean.

- Start: `2026-07-30T04:28:11Z`
- End: `2026-07-30T04:35:16Z`
- Duration: 7 minutes 5 seconds

## Exact prompt

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

## Unedited answers

### 1. What decision is current?

The candidate makes the complete L1 identity and L2 Router implementation authority current, while keeping product implementation blocked until this blind review passes and the maintainer accepts it.

It carries forward four already-current choices:

- V2 authority lives on the `v2` track.
- L1 and L2 own separate representation chapters; there is no cross-layer wire catalog or shared corpus.
- L1 uses closed JCS JSON, General JWS/JWK, and identity-owned registered-agent `AuthenticatedHttp`.
- Router order is private, continuation is an opaque client-held PollCursor, and the package is `router`.

It adds three follow-on decisions:

- Registration is Registry-owned signed bootstrap admission, not authentication as an existing AgentId. `AuthenticatedHttp` applies only to registered-agent requests.
- Identity and Router expose exact, cohesive Effect capabilities, closed public APIs and errors, private Effect RPC groups, Effect Schema/Config boundaries, and domain vocabulary. Numbered layer notation stays out of executable artifacts.
- Primitive representation limits are fixed and enclosing limits are owner-derived; duplicate configuration knobs and application request queues are removed.

These resolve three implementation blockers: the circular notion that a first registration already authenticates as the identity it creates; the absence of exact callable APIs, error channels, construction surfaces, and configuration ownership; and independently configurable nested limits that could contradict one another.

Binding authority is, in order:

1. `AGENTS.md` and `v2/VISION.md`;
2. accepted ADR Decision Outcomes and explicitly retained portions of partially superseded ADRs;
3. normative `docs/spec/` chapters;
4. architecture execution guidance where the freeze manifest assigns process ownership.

The binding contract includes the ADRs’ binding outcomes and guarantees, plus selected mechanisms where the outcome explicitly requires them, such as Effect Schema, private Effect RPC, Effect Config, JCS/JOSE, and exact public Layers.

ADR context, considered alternatives, historical Decision Outcome text below a supersession notice, and consequences are explanatory or historical. `docs/architecture/l1-l2-human-review-slate.md` is explicitly non-normative. The implementation ask is an execution handoff rather than protocol authority. The compacted trajectory is source evidence only. `docs/spec/layer-interfaces.md` also labels its “Effect realization” section non-normative guidance.

### 2. Replacement, retention, and normative ownership

Current replacement lineage is explicit:

- `20260729-v2-authority-lives-with-v2.md` supersedes the main-first V2 specification rule.
- `20260729-representations-are-layer-owned.md` fully supersedes the cross-layer wire-profile/catalog outcome.
- `20260729-identity-uses-jcs-jose-authenticated-http.md` replaces X.509, CBOR/COSE L1 artifacts, embedded-card normal requests, custom standards machinery, and application-required TLS. Its JCS/JWS, registered-agent authentication, trust assumptions, and deferrals remain current.
- `20260729-router-order-is-opaque.md` replaces public Router sequence exposure, the old poll route and cursor details, durable/per-recipient Router state, the `transport` package name, and application TLS requirements.
- `20260729-registration-is-registry-bootstrap-admission.md` fully supersedes “registration is out of band” and the interim pre-card request-signature profile. It partially supersedes only the registration portion of the JCS/JOSE/AuthenticatedHttp ADR.
- The deep-Effect and fixed/derived-limit ADRs refine implementation authority without replacing retained JCS/JOSE, layer ownership, Router-order, guarantee, or trust scope.
- The Gate 1 freeze, identity-profile, and HTTP-POST ADRs are partially superseded with precise retained scopes and current owners.

L3, L4, endpoint-daemon, MCP, Transcript, task/norm, and later trust-layer semantics and focused ADRs are expressly untouched. The L3 CBOR/COSE contract therefore remains current for L3; the L1/L2 JCS/JOSE revision does not silently replace it.

Current normative contracts live in:

- `docs/spec/identity.md`: identity semantics, registration, registered-agent authentication, exact public capability/error/configuration contracts.
- `docs/spec/identity-representation.md`: exact L1 JCS/JWK/JWS, bootstrap and registered-agent RFC 9421 profiles, validation order, Registry representations, and derived bounds.
- `docs/spec/router.md`: Router semantics, API, private global feed/order, retries, polling, errors, configuration, and resource behavior.
- `docs/spec/router-representation.md`: exact Router values, Compact-JWE PollCursor, request/results, and derived limits.
- `docs/spec/layer-interfaces.md`: package/type ownership, construction handoffs, dependency graph, and cross-layer laws.
- `docs/spec/README.md`: readiness and decision-family ownership.
- `docs/decisions/20260728-gate-1-architecture-freeze.md`: stable `G1-DEC-*` traceability and acceptance families.

### 3. Implementation obligations and assumptions

An implementer must implement only `identity` and `router` in this run.

For identity, the implementer must:

- Preserve the exact root and `/server` export inventories and Effect signatures.
- Implement immutable closed AgentCard and SignedMessage domain views over exact General JWS representations, nominal verified subtypes, redacted PKCS#8 loading, exact JCS/JWK validation, and the two identity-owned SignedMessage length operations.
- Implement Registry register, lookup, list, and health.
- Keep registration inside Registry bootstrap admission, with admission credential, submitted-key proof, durable nonce claim, version ordering, uniqueness, and idempotency.
- Keep lookup and list public and unauthenticated.
- Implement registered-agent `AuthenticatedHttp` with the exact verification stages and closed errors.
- Use PostgreSQL, Effect SQL/Migrator, private Effect Config, private no-serialization RPC, and the exact declared configuration table.

For Router, the implementer must:

- Preserve its exact root and `/server` export inventories and Effect signatures.
- Implement authenticated send and poll plus readiness.
- Keep one volatile global count-and-byte-bounded ring, one copy per SignedMessage, a coupled retry index, a private unsigned 128-bit order, bounded nonce/card caches, and request-scoped waiters.
- Implement `initial`/`retry`, expected-instance fencing, opaque Compact-JWE PollCursor, conservative `feed_gap`, and `cursor_invalid`.
- Consume identity-owned SignedMessage sizing and derive only Router-owned bounds.
- Enforce immediate request permits, separate held-poll capacity, and configuration fit laws.

Executable artifacts must avoid public client/server classes, service interfaces, options/configuration types, generic codec/wire/serialization APIs, public RPC/middleware machinery, generic signers, direct `process.env` parsing, prefix enumeration, mutable configuration, hot reload, application queues, application TLS policy, and numbered `L1`/`L2` vocabulary. V2 imports must follow the six-package DAG and never import `packages/*`.

The fixed limits include 262,144 opaque bytes, 128 recipients, 471,671 complete SignedMessage bytes, 471,819 send-body octets, a 348-character PollCursor, 422 poll-body octets, and a 472,119-byte one-message batch. Compatibility is exactly `2026.729.1`, with no range negotiation or per-layer version. MCP and simulator/run-evidence versions remain independent.

The safety/trust envelope assumes one correct non-equivocating Registry, one correct non-equivocating Router, one correct durable Ledger, and potentially Byzantine endpoints. A malicious/equivocating Registry and Byzantine Router sequencing are outside the guarantee. Registry outage blocks registration and uncached resolution; Router or Ledger outage can stop progress. Pinned cards and committed records remain verifiable. Router restart or retention loss is observable and requires L3 reconciliation; L2 does not promise durable replay or restart-transparent liveness. Unsigned responses require deployment-provided channel integrity when the threat model includes a network-path attacker. Application processes themselves impose no TLS policy.

Direct consumers affected are Registry/Router binaries, clients, CLI registration, and endpoint-daemon composition through the public capabilities. Transcript may consume public Router evidence contracts but gains no Router implementation dependency or semantic change. L3/L4, simulator, testbed, publishing, deployment, and cutover remain outside this implementation revision.

### 4. Decision-makers, events, and source gaps

The only human named as decision-maker in the relevant ADRs is Tapan Chugh.

The trajectory is sourced from Codex CLI rollout session `019fac90-d26a-7e51-8708-06858bd118bd`. It does not prove that the session account is Tapan Chugh; that is explicitly recorded as a source gap. Structured input outputs also lack a stored actor role.

The decisive follow-on approval is:

- Agent event `msg_0d0c5bdb13a3d3c4016a6ac6d7ff208190b1ff303d49534cbb`, `2026-07-30T03:36:58.067Z`, identifies `docs/architecture/l1-l2-human-review-slate.md` and SHA-256 `d1305a44a1b1a8a351e56687d8f2178e202ef64e65b91a5d36f96e481a01161d`, then asks for `approve slate`.
- User event `msg_019fb12b-5068-7541-8b06-6ffe8c6b92bb`, `2026-07-30T03:57:13.704Z`, says `approve slate`.
- The checked-in slate independently hashes to that exact value.

The registration chain records:

- User event `msg_019fb028-eb9d-7ed3-9000-a1f26175ad45` questioning whether unauthenticated registration belongs in AuthenticatedHttp.
- Agent event `msg_0d0c5bdb13a3d3c4016a6a89b2b15c81909263c0e77e01f9c0` proposing Registry ownership.
- The later exact-slate approval as the explicit human decision.

The exact follow-on slate is also supported by:

- `msg_019fb034-605f-7430-b2b0-2601cbcbb1fe`: numbered layer notation is for documentation only.
- `msg_019fb0e7-b8e8-7a41-815e-ed84688d3e2b` and `msg_019fb0e7-b8f8-7f01-bda8-7e6823f33cd9`: questions about independent Router byte settings.
- `msg_019fb0eb-32b1-7c63-91be-4e4e6f8176a0`: request for analogous cleanup and Effect configuration loading.
- `msg_019fb0ec-9028-7050-b2f6-79071ed5b9ac`: rejection of a complex research detour.
- The exact-slate approval supplies the otherwise absent acceptance of the detailed API, configuration, error, RPC, and numeric-limit tables.

Earlier retained calls and alternatives include:

- V2 authority: branch prompt `fc_0d0c5bdb13a3d3c4016a69a6a257948190b51618dda4813aa0` and answer `fco_019facb5-464c-7ec0-9230-1d147fa2b9ef` selecting V2 ownership.
- Layer ownership: user events `msg_019fae74-8382-7530-b3b9-1d6dd3ed5e3e` and `msg_019fae76-f1c4-7612-902e-9763718af9ab`, plus `fco_019fae76-9fff-7043-95be-d074a0b69464` selecting repetition per layer.
- JOSE/JCS: the MessagePack prompt was aborted at `fco_019fae7e-7de5-7182-927c-91e3ddc595e4`; `fco_019fae87-669d-7071-a217-67d52b651646` later selects JOSE/JSON; `fco_019fae92-c987-7c02-896b-f57d45c730b1` selects canonical network JSON; and `fco_019fae97-3f50-73b1-8e30-1b25eeb257db` selects General JWS.
- Deep-module ownership: `msg_019fae9b-223b-7792-a78d-016a181937d2`, `fco_019fae9c-b6c7-7860-9dc6-99cc761d20d2`, and later `fco_019faea3-ef76-7623-a5a4-08c4221d4071` selecting the authenticated HTTP boundary inside identity.
- AuthenticatedHttp naming/depth and collapsed errors: `fco_019faec0-0da3-7142-a3d0-fcbc6fa4e3d8` and `fco_019faf1f-7822-7bc0-aaad-3b69af0d0e25`.
- Router decisions: `fco_019faea1-3183-74f0-8ff4-250e7bf001fe` renames the package; `fco_019faea8-efeb-7523-bf52-a3902b63ddf1` makes position opaque; `fco_019faec4-022b-7291-a4a1-2a79c4ecefaf` selects opaque continuation and the digest receipt; `fco_019faefc-cd94-7bb3-a64d-7c0a34fb0c02` selects Compact JWE without cursor records; and `fco_019faf09-39ca-7381-aba7-0659ab2d4333` selects one global ring.
- Scope: user events `msg_019faf74-e678-7ab3-8b27-090394ccf237`, `msg_019faf77-25d7-7f41-aa0d-4784aac3162f`, and `msg_019faf78-2bdf-7113-a819-75d66749f12d` restrict the revision to L1/L2, direct restoration of later-layer documents, and reject the cross-layer wire profile.

Recorded reversals and deferrals are preserved rather than normalized:

- MessagePack had no selection; JOSE/JSON was selected later.
- A shared adapter library was selected, then revisited through deep-module discussion, with the later ownership selection placing AuthenticatedHttp inside identity.
- Poll restart fencing was initially deferred at `fco_019faec7-667a-78f0-94b6-53c6f5ceed82`, revisited at `fco_019faeeb-78aa-73c0-9aea-8691300059d6`, and followed by the Compact-JWE/no-server-record decision.
- The initial TLS answer still included non-loopback scheme rejection; user event `msg_019faeff-730d-73a3-9343-72b3d40a69d6` later states TLS is fully a deployment concern.
- The ledger distinguishes a stateless PollCursor from a Router that still has bounded ring, retry, nonce, cache, and waiter state.

Explicit source gaps are:

- No session-account-to-Tapan-Chugh binding.
- No parent locator for retained response items; the session metadata lacks message ID, turn, parent, and stored actor role.
- The literal human spelling `HarnessEndpoin` was normalized by an agent to `HarnessEndpoint`; no later human event confirms the normalized spelling. Neither is introduced here.
- “record this alternative” has an ambiguous referent.
- The MessagePack prompt was aborted.
- Shared-adapter ownership was revisited rather than silently treated as one continuous selection.
- The later TLS statement broadened the earlier structured selection.
- “Stateless Router” cannot be inferred from the stateless cursor decision.
- No original public human event was located for the code-first simulator-kernel decision; this is recorded as a simulator provenance source gap.

### 5. Strongest apparent contradiction

The strongest apparent stale instruction is `docs/architecture/l1-l2-human-review-slate.md`:

- Its status still says `DRAFT — HUMAN REVIEW REQUIRED`.
- Its last section is “Human decisions required”.
- The current implementation ask says the exact slate was approved and authority reconciled.

This is resolvable and is not a blocker. The slate explicitly says it is non-normative and that its choices become current only through approval, ADR/spec reconciliation, candidate freeze, blind review, and maintainer acceptance. Its unchanged bytes are necessary because the approval event identifies that exact SHA-256. The higher authority—accepted ADRs and normative specs—contains the reconciled current choices, while the implementation ask records the exact approval and remaining blind-review gate. The slate is therefore a frozen pre-approval review artifact, not the current open-question register.

I also checked the apparent JCS/JOSE versus CBOR/COSE split. `docs/spec/control-plane.md` retains CBOR/COSE for L3. This is deliberate, not contradictory: `G1-DEC-011`, the layer-owned-representation ADR, the spec readiness matrix, and `v2/VISION.md` all state that this revision changes only L1/L2 and assigns no replacement L3 representation.

No unresolved lineage contradiction remains.

### 6. Implementability and unresolved choices

Yes. After this blind result is accepted, a teammate can implement L1/L2 without chat or choosing public behavior. The repository specifies exact exports, schemas, domain views, trust-state nominality, Effect success/error/requirement channels, client and server Layers, routes, validation order, envelope precedence, configuration keys/defaults/ranges, private order behavior, byte/count limits, fit laws, module batches, tests, and human readability gates.

Deliberate deferrals are:

- Any L3/L4, endpoint-daemon, MCP, or later-layer representation or vocabulary change.
- `HarnessEndpoin` and any normalized spelling.
- Malicious/equivocating Registry tolerance.
- Key rotation, revocation, recovery, delegation, encrypted keys, keychains, HSMs, and external signers.
- Router persistence, replication, failover, Byzantine sequencing, fork detection, stable process identity, and per-recipient indexes/queues.
- Durable L2 replay, offline convergence, restart-transparent liveness, and network push.
- End-to-end body encryption and application-owned TLS.
- Post-Gate-1 action vocabulary, membership transitions, quorums, fairness, takeover, and dispute handling.
- L6/L7/L8 access, institution, trust-root, and governance designs.
- Later MCP replay/acknowledgment/security profiles.
- Negotiated or changed representation limits.
- Physical Transcript compression.
- Container images, deployment manifests, publishing, cutover, V1 retirement, and simulator porting under its separate provenance gate.

The session-account and simulator provenance gaps are source gaps, not missing L1/L2 implementation choices. The approved slate’s stale status is resolved by authority order and artifact identity.

Accidental gaps: none found.

## Independently discovered paths and headings

- `AGENTS.md` — Constitution; Architecture decision records; Decision provenance; Blind teammate review gate; Docs.
- `v2/VISION.md` — Authority; The constitution; Gate 1 profile; Trust and failure envelope; Processes and persistence; Identity; Open-question register.
- `v2/AGENTS.md` — Authority and reading order; Structure; Implementation rules.
- `docs/decisions/README.md` — Canonical reading guidance; Status meanings; Records.
- `docs/decisions/20260728-gate-1-architecture-freeze.md` — Supersession; Normative owner; Acceptance owner; Gate 1 traceability inventory.
- The seven focused current L1/L2 ADRs named in the implementation ask.
- `docs/spec/README.md` — Authority and reading order; L1 and L2 representation readiness; Implementation decision ownership.
- `docs/spec/identity.md` — Registration; AuthenticatedHttp; Registry capability; Private Effect RPC; Error contract; Configuration; Operational bounds.
- `docs/spec/identity-representation.md` — Canonical JSON; AgentCard; SignedMessage; HTTP request framing and ownership; Validation order; Registry routes.
- `docs/spec/router.md` — Effect capability and private RPC; Send; One volatile global feed; Poll; Configuration; Operational bounds.
- `docs/spec/router-representation.md` — PollCursor; Representation limits; Send; Poll.
- `docs/spec/layer-interfaces.md` — Package graph; Type ownership; Construction handoffs; Cross-layer laws.
- `docs/architecture/l1-l2-implementation-ask.md` — Human gates; Authority gate; Blind teammate review; Implementation batch matrix; Explicit deferrals.
- `docs/architecture/l1-l2-human-review-slate.md` — exact APIs, errors, configuration, private RPC, bounds, deferrals, and human decisions.
- `docs/decision-evidence/20260729-l1-l2-implementation-trajectory.md` — Source record; decision sections; Exact implementation slate approved; Cross-cutting source gaps.

## Discovery trail and checks

1. Verified commit, tree, parent, subject, and clean worktree.
2. Recreated a git archive and matched the supplied SHA-256 exactly.
3. Listed the candidate’s decision, evidence, specification, and V2 trees; quarantined names were observed only as names.
4. Discovered the candidate delta from git history without reading the quarantined review addition.
5. Followed the decision index and freeze manifest into the focused ADRs and their supersession sections.
6. Followed normative ownership into the complete L1/L2 semantic and representation chapters and package-interface chapter.
7. Followed the implementation ask to the review slate and independently verified its approved SHA-256.
8. Followed ADR provenance into the safe implementation trajectory and checked the source events and explicit gaps.
9. Searched the non-quarantined authority set for stale routes, X.509/CBOR/COSE, TLS, old configuration names, public clients, and wire-catalog vocabulary.
10. Checked 46 ADRs for valid status, date, decision-maker field, replacement target, and visible Supersession section: passed.
11. Checked all ADR provenance targets and stable anchors: passed. An initial heading-only checker omitted explicit HTML anchors; the corrected checker included them and passed.
12. Checked 193 freeze-manifest rows for duplicate IDs: none.
13. Ran `node scripts/check-architecture-boundaries.js`: passed, scanning 576 V1 sources, six V2 packages, 12 V2 sources, and 35 V2 non-documentation files at version `2026.729.1`.
14. Verified all six V2 manifests and `v2/VERSION` equal `2026.729.1`.
15. Rechecked git status: no repository edits.

## Author interventions

None.

## Per-question verdicts

| Question | Verdict | Reason |
|---|---|---|
| 1 | PASS | Current outcome, resolved problem, authority order, and binding/non-normative boundaries are discoverable. |
| 2 | PASS | Statuses, retained scope, replacements, untouched layers, and normative owners are explicit and consistent. |
| 3 | PASS | Exact implementation obligations, prohibitions, consumers, trust/fault envelope, safety/liveness limits, and compatibility contract are specified. |
| 4 | PASS | The named human, exact approval binding, alternatives, reversals, deferrals, actor limitations, and source gaps are recorded without inferred rationale. |
| 5 | PASS | The strongest stale instruction is resolvable through explicit artifact status and authority order; the apparent L3 representation split is explicitly scoped. |
| 6 | PASS | L1/L2 can be implemented without chat; unresolved choices are explicitly deferred and no accidental gap was found. |

## Blockers

None.

## Overall result

**PASS**

This reviewer result still requires maintainer acceptance before implementation begins.
