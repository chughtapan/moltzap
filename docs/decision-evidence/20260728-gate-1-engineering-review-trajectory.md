# Gate 1 engineering review source-event ledger

This is a curated, non-normative ledger of stored events from Codex session
`019fa633-abe3-7223-8c51-6d061f5c5855`. Timestamps are UTC. A Codex user
event has no native message ID, so its locator is the session, enclosing
`turn_id`, event kind, and exact timestamp. An assistant message also cites
its stored `msg_*` ID. Excerpts below are literal; spelling, capitalization,
and hedges are preserved.

The stored role `user` does not independently authenticate a person's
identity. The linked ADRs name their accountable decision-maker separately.
Repository effects list files changed later; they are not quotations or
evidence that every resulting field was separately approved.

<a id="layer-and-trust-boundaries"></a>

<a id="20260728-layer-boundaries-and-fault-model"></a>

## Gate 1 fixes the layer boundaries and fault model

[ADR: `20260728-layer-boundaries-and-fault-model.md`](../decisions/20260728-layer-boundaries-and-fault-model.md)

1. **Stored user event.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa651-2001-7af3-94e8-ed0ccc360378`; `event_msg.user_message`;
   `2026-07-28T01:22:42.428Z`.

   > I think L2 should just be about equivocation freedom and quorums and reliability should be art of L

2. **Assistant clarification.** Locator: the same session; turn
   `019fa651-2a42-7973-96f5-b8e57152f353`;
   `response_item.message`
   `msg_073ea08a964186bd016a6804a297a4819b9dc2c9674d26e080`;
   `2026-07-28T01:23:48.188Z`.

   > That’s a coherent boundary. I read you as proposing:
   >
   > - **L2:** equivocation-free ordering plus quorum-certificate mechanics; no persistence, replay, or offline convergence.
   > - **L3:** reliability—durable coordination state, retransmission, recovery, and committed actions.
   > - **L4:** decides what quorum means for each task.
   >
   > Did you mean reliability belongs to **L3**?

3. **Stored user correction.** Locator: the same session; turn
   `019fa651-2a42-7973-96f5-b8e57152f353`;
   `event_msg.user_message`; `2026-07-28T01:23:48.201Z`.

   > L3

4. **Stored user boundary statement.** Locator: the same session; turn
   `019fa673-f081-7471-a35c-9531a8b7135c`;
   `event_msg.user_message`; `2026-07-28T02:00:43.995Z`.

   > decouple L1 and L7. L1 identity registry and L7 insitutions are different services

5. **Assistant question and selected option.** Locator: the same session;
   turn `019fa673-f081-7471-a35c-9531a8b7135c`;
   `response_item.message`
   `msg_03555d6e4800000d016a680db19bac819aa44dbb8f27c744af`;
   `2026-07-28T02:02:38.777Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D11 — Architecture issue 8: May the network consult L7 during admission?
   >
   > [omitted: explanation, current admission text, and stakes]
   >
   > **A — L1-only network admission (recommended).** The router and Ledger verify cryptographic identity/key validity, COSE structure, protocol version, technical conversation/epoch fields, and the endpoint threshold certificate. They never query or evaluate L7.
   >
   > [omitted: remainder of option A and options B and C]

6. **Stored user reply.** Locator: the same session; turn
   `019fa676-4d0f-7730-a77d-e78b0b10b701`;
   `event_msg.user_message`; `2026-07-28T02:03:18.728Z`.

   > A

7. **Assistant question and selected option.** Locator: the same session;
   turn `019fa676-4d0f-7730-a77d-e78b0b10b701`;
   `response_item.message`
   `msg_0fe2c00d8ae8d68c016a680e69fec88199bec9f0ebae4810a5`;
   `2026-07-28T02:05:47.140Z`.

   > ### D12 — Architecture issue 9: Is the L2 sequencer trusted?
   >
   > [omitted: explanation, conflict, and stakes]
   >
   > **A — Trust the Gate-1 sequencer (recommended).** State explicitly that Gate 1 tolerates Byzantine endpoints but assumes a correct, non-equivocating sequencer and durable store. L2 safety is conditional on that assumption; outages may stop progress.
   >
   > [omitted: remainder of option A and options B and C]

8. **Stored user reply.** Locator: the same session; turn
   `019fa678-d959-7c61-90c2-b06443b20f73`;
   `event_msg.user_message`; `2026-07-28T02:06:05.728Z`.

   > A

9. **Assistant liveness question and selected option.** Locator: the same
   session; turn `019fa6b1-b793-7142-a60a-f229e3d3f564`;
   `response_item.message`
   `msg_0c10c294c0d66118016a681d759428819aa1ac79e62fa7134c`;
   `2026-07-28T03:09:50.460Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D18 — What liveness may L4 honestly promise?
   >
   > [omitted: conflict, stakes, and source link]
   >
   > **A — Conditional liveness contracts per L4 protocol (recommended).** Every protocol declares its fault budget, quorum rule, required correct/available participants, timing assumption, and abort/retry condition. Safety guarantees remain unconditional within the chosen threat model; progress is guaranteed only while those declared assumptions hold. Gate 1’s simple protocol declares its narrow envelope, while #765 supplies envelopes for real collectives. L6 can later detect bounded-liveness violations against the declared contract.
   >
   > [omitted: estimate, options B and C, and recommendation]

10. **Stored user reply.** Locator: the same session; turn
   `019fa6b4-6940-7f61-803d-165a221e2368`;
   `event_msg.user_message`; `2026-07-28T03:11:09.219Z`.

   > yes, A

Repository effect: the linked ADR, `v2/VISION.md`, and the layer,
component, control-plane, and data-plane documents were rewritten in the
candidate.

Source gaps: this cluster directly covers the L2/L3 placement, L1/L7
separation, and trusted-sequencer assumption. The exact three-process
topology, the full endpoint/Ledger certificate boundary, and every stated
safety consequence were assembled in later assistant-authored plans and
repository edits rather than separately selected in one stored user event.

<a id="registry-trust-assumption"></a>

### Cold-review Registry trust correction

1. **Assistant post-review decision prompt.** Locator: the same session;
   turn `019faac4-5c6c-7152-822a-9ce4ceb74de4`;
   `response_item.message`
   `msg_04973cc9cc8d242e016a693f9780c8819a842923f466fb0175`;
   `2026-07-28T23:47:40.122Z`.

   > [omitted: trajectory and blind-review artifact status]
   >
   > The sole blocker is real: Gate 1 never specifies whether the Identity Registry is trusted/correct or may be Byzantine and equivocate. I did not invent an answer.
   >
   > Choose:
   >
   > - **A — Assume a correct, non-equivocating Registry for Gate 1** (recommended, consistent with the current Router/Ledger envelope).
   > - **B — Tolerate a malicious/equivocating Registry**, requiring a substantially larger design.
   >
   > [omitted: check and commit status]

2. **Stored user reply.** Locator: the same session; turn
   `019fab21-195f-7b61-9806-e17991acfe86`;
   `event_msg.user_message`; `2026-07-28T23:48:21.433Z`.

   > A

Repository effect: the Registry assumption was added to the linked fault-model
ADR, the identity ADR, the Gate 1 manifest, the constitution, and normative
identity and layer contracts in the corrected candidate.

Source gap: the selected option states the Registry correctness and
non-equivocation assumption. The exact affected operations, pinned-card
availability consequences, and placement in the manifest and specifications
were reconciled in later repository edits rather than separately enumerated in
the stored reply.

<a id="identity-profile-and-bootstrap"></a>

<a id="20260728-gate-1-identity-profile"></a>

## Gate 1 fixes one immutable identity profile and Registry bootstrap

[ADR: `20260728-gate-1-identity-profile.md`](../decisions/20260728-gate-1-identity-profile.md)

1. **Assistant question and selected option.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa678-d959-7c61-90c2-b06443b20f73`;
   `response_item.message`
   `msg_0fe2c00d8ae8d68c016a680eecf64481998d102c408ba69b7d`;
   `2026-07-28T02:07:56.225Z`.

   > ### D13 — Architecture issue 10: How are control-plane HTTP requests authenticated?
   >
   > [omitted: explanation, conflict, stakes, and source links]
   >
   > **A — A strict RFC 9421 profile (recommended, completeness 10/10).** Sign with the card’s Ed25519 key and cover `@method`, `@authority`, `@path`, `@query`, `content-digest`, `content-type`, and `moltzap-protocol`.
   >
   > [omitted: remainder of option A and options B and C]

2. **Stored user reply.** Locator: the same session; turn
   `019fa67b-0d67-7662-a77f-d97ee232e231`;
   `event_msg.user_message`; `2026-07-28T02:09:36.495Z`.

   > A

3. **Stored user reversal.** Locator: the same session; turn
   `019fa67c-44b9-7002-b220-b018a5c162a7`;
   `event_msg.user_message`; `2026-07-28T02:09:49.946Z`.

   > defer

4. **Stored user reversal back to the selected option.** Locator: the same
   session; turn `019fa67d-bf08-7ad0-abd0-8c79687735cb`;
   `event_msg.user_message`; `2026-07-28T02:11:26.676Z`.

   > actually assume A and ocnitnue

5. **Assistant lifecycle question and options.** Locator: the same session;
   turn `019fa6b8-4d5b-7992-9145-94741e3b2886`;
   `response_item.message`
   `msg_0c10c294c0d66118016a681efedf00819a9720a4f3097c36ca`;
   `2026-07-28T03:16:25.132Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D21 — Who may rotate or revoke an L1 key?
   >
   > [omitted: conflict, stakes, and source links]
   >
   > **A — Agent-controlled continuity with an offline recovery key (recommended).** Registration binds the stable `AgentId`, an online card key, and a separate offline recovery key. Routine rotation is signed by both old and new online keys; emergency rotation or revocation is signed by the recovery key. The IdentityRegistry checks, signs, and append-logs monotonic `KeyVersionRecord`s but cannot silently substitute a key. Records embed the card plus the registry’s key-state evidence from admission; revocation blocks future admission without invalidating earlier records.
   >
   > [omitted: estimate, pros, risks, and maintenance text for option A]
   >
   > **B — IdentityRegistry operator controls rotation.** The deployment authenticates rotation requests out of band and the registry alone issues, replaces, or revokes card keys. An append-only history makes changes auditable, but a compromised or malicious registry can impersonate any identity.
   >
   > [omitted: estimate and maintenance text for option B]
   >
   > **C — No key rotation.** One key equals one `AgentId`. Compromise retires that identity and creates a new one; institution statements, memberships, and relationships must explicitly relink. Gate 1 becomes straightforward, but the promised stable identity continuity is removed.
   >
   > [omitted: estimate, lifecycle-cost text, recommendation, and source link]

6. **Stored user lifecycle reply.** Locator: the same session; turn
   `019fa6b9-7988-7912-a2dc-861cb4123ccc`;
   `event_msg.user_message`; `2026-07-28T03:16:41.065Z`.

   > out of band.

7. **Assistant key-status question and selected option.** Locator: the same
   session; turn `019fa6b9-7988-7912-a2dc-861cb4123ccc`;
   `response_item.message`
   `msg_0c10c294c0d66118016a681f5607fc819a82749e9198715a22`;
   `2026-07-28T03:17:51.945Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D22 — How fresh must L1 key status be?
   >
   > [omitted: conflict, stakes, source link, and options A and B]
   >
   > **C — Endpoint-configured cache freshness.** Each deployment chooses how long it trusts a resolved card. This maximizes availability and requires no new wire material, but “revoked” has no uniform network meaning; endpoints may disagree for arbitrarily different periods.
   >
   > [omitted: estimate, cost assessment, and recommendation]

8. **Stored user reply.** Locator: the same session; turn
   `019fa6c0-9c1e-7282-b53c-18835fdb56cd`;
   `event_msg.user_message`; `2026-07-28T03:24:29.046Z`.

   > C

9. **Stored user placement statement.** Locator: the same session; turn
   `019fa782-590f-7870-ad21-80ae98638a69`;
   `event_msg.user_message`; `2026-07-28T06:57:12.950Z`.

   > it's a control operatoin right? nothing on the data plane

Repository effect: the linked ADR and identity, control-plane, CLI, and
implementation-plan documents were rewritten in the candidate.

Source gaps: this session does not contain a direct user event selecting
the ADR's complete X.509 card fields, lowercase name rule, bootstrap request
schema, key-file handling, nonce persistence, or complete list of excluded
key-management features. Some identity premises came from earlier accepted
records; the Gate 1 concrete profile was filled out by assistant-authored
review and repository edits. The reply `out of band.` does not by itself
choose the ADR's exact no-rotation profile.

<a id="endpoint-validation-and-storage"></a>

<a id="20260728-transcript-is-mechanical-atomic-commit"></a>

## Ledger performs mechanical atomic Transcript commit

[ADR: `20260728-transcript-is-mechanical-atomic-commit.md`](../decisions/20260728-transcript-is-mechanical-atomic-commit.md)

1. **Assistant reframe and selected option.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa657-6bb8-7763-820d-44e70ef1520a`;
   `response_item.message`
   `msg_073ea08a964186bd016a6806763b2c819b9f1589edc18889d9`;
   `2026-07-28T01:31:43.008Z`.

   > [omitted: opening response to the preceding user message]
   >
   > The intended flow is:
   >
   > `endpoints validate → endpoints sign → Ledger orders and persists → endpoints verify`
   >
   > [omitted: option A]
   >
   > **B — Store endpoint-certified actions only.** Endpoints first produce an approval certificate, then the Ledger stores only certificate-bearing actions. The Ledger verifies the certificate mechanically without evaluating the action. However, this requires defining who may certify and how the Ledger recognizes a sufficient endpoint quorum—effectively adding a trusted attester, universal quorum rule, or group signature system. Human: 8–12 days; Codex: 16–24 hours. Main risk: endpoint authority quietly becomes lower-layer admission policy.
   >
   > [omitted: closing restatement]

2. **Stored user reply.** Locator: the same session; turn
   `019fa65a-155a-7be3-8cc7-35a0563c6c98`;
   `event_msg.user_message`; `2026-07-28T01:32:29.510Z`.

   > B

3. **Assistant certificate question and selected option.** Locator: the
   same session; turn `019fa65a-155a-7be3-8cc7-35a0563c6c98`;
   `response_item.message`
   `msg_073ea08a964186bd016a68074be7d0819ba2b7e74aef2df144`;
   `2026-07-28T01:35:20.928Z`.

   > ### D5 — Architecture issue 2b: Who authenticates endpoint approval?
   >
   > [omitted: explanation, stakes, and option A]
   >
   > **B — Endpoint threshold certificate.** The endpoints collectively produce a threshold or group signature under a conversation-scoped commit key. The Ledger verifies one signature and knows nothing about quorum composition or task rules. `START` establishes the key; membership changes require rekeying and a new epoch. Human: 2–4 weeks; Codex: 30–50 hours. Pros: purest endpoint authority and no trusted L2 attester. Risks: distributed key generation, recovery, rekeying, flexible quorum policies, and signer accountability substantially enlarge Gate 1. Maintenance: high. **Net:** strongest long-term separation, expensive first implementation.
   >
   > [omitted: option C]

4. **Stored user reply.** Locator: the same session; turn
   `019fa65d-6756-7d61-9849-b26f149c265d`;
   `event_msg.user_message`; `2026-07-28T01:36:07.059Z`.

   > B

5. **Assistant signature-profile question and selected option.** Locator:
   the same session; turn `019fa665-16ad-7231-acde-07ac87c0ea1e`;
   `response_item.message`
   `msg_073ea08a964186bd016a6809fb3190819b9ccc6c8b68304ba0`;
   `2026-07-28T01:46:50.533Z`.

   > ### D8 — Architecture issue 5: What exact bytes do the two signatures cover?
   >
   > [omitted: explanation, contradiction, and stakes]
   >
   > **A — Bind a COSE profile now (recommended, completeness 10/10).** Use separate `COSE_Sign1` profiles for `moltzap/l1-message/v1` and `moltzap/l3-action/v1`. Protected context identifies the object type and algorithm; payloads contain the exact unsigned bytes; signatures remain outside. Store and transport the resulting bytes verbatim. Publish golden vectors plus cross-domain and byte-mutation negatives. Human: 4–6 days; Codex: 8–12 hours. Pros: standardized framing, clear interoperability, fewer custom cryptographic rules. Risk: commits v2 to a CBOR/COSE outer wire and requires proving the selected threshold signature’s COSE compatibility. Maintenance: low.
   >
   > [omitted: option B and recommendation]

6. **Stored user reply.** Locator: the same session; turn
   `019fa667-ac69-7e01-9499-ba901687f58d`;
   `event_msg.user_message`; `2026-07-28T01:47:20.203Z`.

   > A

7. **Assistant evidence-location question and selected option.** Locator:
   the same session; turn `019fa667-ac69-7e01-9499-ba901687f58d`;
   `response_item.message`
   `msg_073ea08a964186bd016a680a87211c819bab3028786ac96900`;
   `2026-07-28T01:49:11.255Z`.

   > ### D9 — Architecture issue 6: Where does historical verification material live?
   >
   > [omitted: conflict, stakes, and options A and B]
   >
   > **C — Inline evidence per record.** Every `TranscriptRecord` includes the sender card and complete epoch descriptor. Human: 3–4 days; Codex: 6–8 hours. Pros: every record verifies independently and rotation is straightforward. Risks: repeated certificates and group metadata enlarge every record and hash-chain operation. Maintenance: low, storage cost high.

8. **Stored user reply.** Locator: the same session; turn
   `019fa670-b4e5-7c73-9105-d95273afed4b`;
   `event_msg.user_message`; `2026-07-28T01:57:12.140Z`.

   > C + eventual compression?

9. **Assistant retry-identity question and selected option.** Locator: the
   same session; turn `019fa67d-bf08-7ad0-abd0-8c79687735cb`;
   `response_item.message`
   `msg_01bfa46407fa7e06016a68105aafe8819899d4f881527c1d35`;
   `2026-07-28T02:13:59.430Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D14 — What identifies a retry across L2, L3, and the control plane?
   >
   > [omitted: conflict, explanation, and stakes]
   >
   > **A — Separate typed IDs for each boundary (recommended).** L2 keys retries by `(SenderId, MessageId)`; L3 keys certified commits by `(ConversationId, MembershipEpoch, TxnId)`; control requests use `(AgentId, OperationId)` from D13. An identical retry returns the original position/result. Reusing an ID with different bytes is rejected as equivocation before Ledger append. Hashes provide integrity, not identity. Human: 4–6 days; Codex: 8–12 hours. Moderate initial work, lowest coupling and maintenance risk.
   >
   > [omitted: options B and C and recommendation]

10. **Stored user reply.** Locator: the same session; turn
    `019fa680-9db7-7740-bde4-d12d5b1a1801`;
    `event_msg.user_message`; `2026-07-28T02:14:34.752Z`.

    > 'A

11. **Assistant atomic-commit question and selected option.** Locator: the same session;
   turn `019fa680-9db7-7740-bde4-d12d5b1a1801`;
   `response_item.message`
   `msg_01bfa46407fa7e06016a68114cf330819885ce744c42faf872`;
   `2026-07-28T02:17:57.062Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D15 — What does “committed for every member” mean physically?
   >
   > [omitted: framing and stakes]
   >
   > **A — One canonical append with universal recoverability (recommended).** Commit one `TranscriptRecord` under its immutable `MembershipEpoch`. The same ACID transaction assigns its conversation offset, advances the hash chain, and reserves its L3 idempotency key. The writer receives an acknowledgment only after commit. Every epoch member can subsequently read that record; live fan-out can lag or fail without weakening commitment. No per-recipient delivery status in Gate 1. Human: 4–6 days; Codex: 8–12 hours. Lowest conceptual and operational risk.
   >
   > [omitted: options B and C and recommendation]

12. **Stored user reply.** Locator: the same session; turn
    `019fa684-006b-7723-80ab-3f9f8bd77a80`;
    `event_msg.user_message`; `2026-07-28T02:18:16.624Z`.

    > A

13. **Assistant recovery question and options.** Locator: the same session;
    turn `019fa684-006b-7723-80ab-3f9f8bd77a80`;
    `response_item.message`
    `msg_01bfa46407fa7e06016a6811da95a88198a5c25135befd9468`;
    `2026-07-28T02:20:27.353Z`.

    > [omitted: prior decision-record acknowledgement]
    >
    > ### D16 — Must L3 resume an interrupted protocol attempt?
    >
    > Reply **A, B, or C**.
    >
    > The current design says:
    >
    > > “A member that reconnects mid-protocol abandons the in-flight fold and re-syncs from committed state—the protocol’s messages are gone, and there is nothing to replay.”
    >
    > [omitted: machine-local source link]
    >
    > That conflicts with the earlier decision that L3 owns durable coordination and recovery.
    >
    > ELI10: if a group is halfway through an action when something restarts, must it continue the exact attempt, or may it discard that attempt and safely begin again?
    >
    > Stakes: **P0**, confidence **9/10**.
    >
    > **A — Persist and resume the exact attempt.** Each endpoint durably journals accepted L3 messages and their L2 ordering receipts. Peers reconcile missing frames and resume the same `TxnId`; the Ledger still stores only completed actions. This requires a recovery protocol and a defined surviving-journal threshold. Human: 2–4 weeks; Codex: 4–8 days. Stronger continuity, high distributed-state complexity.
    >
    > **B — Abort and retry from the latest commit (recommended).** L3 retransmits while an attempt is live, but any restart or unrecoverable delivery gap abandons that attempt. The engine starts a fresh `TxnId` from the latest committed offset. L3 guarantees that committed actions are never lost or duplicated and that interrupted actions can be retried—not that partial coordination survives. L4 protocols must therefore be restart-safe; L6 sees only completed certificates. Human: 4–6 days; Codex: 8–14 hours. Lowest complexity and clearest failure semantics.
    >
    > **C — Add a separate opaque L3 recovery spool.** Store encrypted protocol frames temporarily in a content-blind service distinct from the Ledger, then delete them after commit or abort. This permits resume without trusting endpoint-local journals but adds another storage service, retention rules, and key management. Human: 3–5 weeks; Codex: 1–2 weeks. High operational and privacy complexity.
    >
    > **Recommendation: B.** It keeps the Ledger as a chain of agreements while giving L3 an honest reliability contract: retry whole incomplete work, recover completed work exactly. It would narrow the earlier wording from “durable coordination” to “reliable coordination with durable committed state.”

14. **Stored user recovery deferral.** Locator: the same session; turn
    `019fa686-c9d9-7892-9f73-c3b9474ab5fb`;
    `event_msg.user_message`; `2026-07-28T02:21:19.298Z`.

    > sure, it's fine for now. we can add recovery protocols later

15. **Assistant certificate-revision question and selected option.** Locator:
    the same session; turn `019fa686-c9d9-7892-9f73-c3b9474ab5fb`;
    `response_item.message`
    `msg_01bfa46407fa7e06016a681299513481988ec767db3da78604`;
    `2026-07-28T02:23:38.342Z`.

    > [omitted: prior decision-record acknowledgement]
    >
    > ### D17 — Does Gate 1 need threshold cryptography, or only endpoint certification?
    >
    > [omitted: prior design, explanation, stakes, and source link]
    >
    > **A — COSE multi-signatures in Gate 1; threshold compression later (recommended).** Use `COSE_Sign` with one independently verifiable signature per participating endpoint. The Ledger verifies signature mechanics but never decides whether the signer set satisfies the task’s quorum. Endpoints make that judgment. This requires no shared secret, preserves signer accountability for L6, and matches the original “signature set” design; certificate size grows linearly with signers. FROST becomes an optional versioned compression profile later. Human: 5–8 days; Codex: 10–16 hours. Low cryptographic risk.
    >
    > [omitted: options B and C and recommendation]

16. **Stored user reply and deferral.** Locator: the same session; turn
    `019fa6b1-b793-7142-a60a-f229e3d3f564`;
    `event_msg.user_message`; `2026-07-28T03:08:12.711Z`.

    > I think we can hack our way around a bit: keep A, but then for the next turn agents can dispute the chain? like that can be solution we don't have to implement now

17. **Assistant transcript-read question.** Locator: the same session; turn
    `019fa6c0-9c1e-7282-b53c-18835fdb56cd`;
    `response_item.message`
    `msg_0542a02212a59ab4016a6821233dd8819bac6eac40929f245e`;
    `2026-07-28T03:25:32.325Z`.

    > [omitted: prior decision-record acknowledgement]
    >
    > ### D23 — Which membership epoch authorizes transcript reads?
    >
    > [omitted: framing, stakes, options A through C, recommendation, and source link]

18. **Stored user reply.** Locator: the same session; turn
    `019fa6c2-2da4-7dc3-85e6-5c2a40f3af89`;
    `event_msg.user_message`; `2026-07-28T03:26:11.457Z`.

    > defer

Repository effect: the linked ADR and transcript, Ledger, endpoint, and
data-plane documents were rewritten in the candidate.

Source gaps: the source cluster selects endpoint certification and one
canonical append. Exact closed certificate fields, exact-signer-set checks,
author-only append, ACID operation order, hash preimages, and ambiguous-result
recovery were specified later by assistant-authored plans and edits.

<a id="conversation-protocol-and-deferrals"></a>

<a id="20260728-open-floor-v1"></a>

## Gate 1 uses OpenFloorV1 with fixed membership and unanimity

[ADR: `20260728-open-floor-v1.md`](../decisions/20260728-open-floor-v1.md)

1. **Assistant question and selected option.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa65d-6756-7d61-9849-b26f149c265d`;
   `response_item.message`
   `msg_073ea08a964186bd016a6808016478819b958cdf7365454845`;
   `2026-07-28T01:38:28.303Z`.

   > ### D6 — Architecture issue 3: Must Gate 1 support changing membership?
   >
   > [omitted: explanation, conflict, and stakes]
   >
   > **A — Fixed membership in Gate 1 (recommended).**
   >
   > [omitted: remainder of option A and options B and C]

2. **Stored user reply.** Locator: the same session; turn
   `019fa660-03a6-7672-bc7e-98a72ac8b731`;
   `event_msg.user_message`; `2026-07-28T01:38:58.207Z`.

   > A

3. **Assistant liveness question and selected option.** Locator: the same
   session; turn `019fa6b1-b793-7142-a60a-f229e3d3f564`;
   `response_item.message`
   `msg_0c10c294c0d66118016a681d759428819aa1ac79e62fa7134c`;
   `2026-07-28T03:09:50.460Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D18 — What liveness may L4 honestly promise?
   >
   > [omitted: conflict, stakes, and source link]
   >
   > **A — Conditional liveness contracts per L4 protocol (recommended).** Every protocol declares its fault budget, quorum rule, required correct/available participants, timing assumption, and abort/retry condition. Safety guarantees remain unconditional within the chosen threat model; progress is guaranteed only while those declared assumptions hold. Gate 1’s simple protocol declares its narrow envelope, while #765 supplies envelopes for real collectives. L6 can later detect bounded-liveness violations against the declared contract.
   >
   > [omitted: estimate, options B and C, and recommendation]

4. **Stored user reply.** Locator: the same session; turn
   `019fa6b4-6940-7f61-803d-165a221e2368`;
   `event_msg.user_message`; `2026-07-28T03:11:09.219Z`.

   > yes, A

5. **Assistant NormPin question.** Locator: the same session; turn
   `019fa6b6-317b-7c62-b2fd-06f6d6ff8cb8`;
   `response_item.message`
   `msg_0c10c294c0d66118016a681ea579e4819a8156e9fa86293e03`;
   `2026-07-28T03:14:54.431Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D20 — What does a `NormPin` actually identify?
   >
   > [omitted: conflict, stakes, options A through C, recommendation, and source links]

6. **Stored user reply.** Locator: the same session; turn
   `019fa6b8-4d5b-7992-9145-94741e3b2886`;
   `event_msg.user_message`; `2026-07-28T03:15:24.688Z`.

   > defer

7. **Stored user timeout statement.** Locator: the same session; turn
   `019fa712-7e97-7a52-b247-9aa3d82466e1`;
   `event_msg.user_message`; `2026-07-28T04:53:55.065Z`.

   > actually TTL only is fine for gate 1

8. **Assistant protocol proposal.** Locator: the same session; turn
   `019fa782-590f-7870-ad21-80ae98638a69`;
   `response_item.message`
   `msg_0ef6d7028d223fad016a68588cf5ec819b9e3e72dcbcae3b5b`;
   `2026-07-28T07:21:52.312Z`.

   > Perfect. Gate 1 ships an explicit built-in L4 norm, `OpenFloorV1`: every fixed member is always eligible, so every endpoint’s L4 provider requests BEGIN and L2’s first ordered BEGIN wins.
   >
   > [omitted: remainder of the stored message]

Repository effect: the linked ADR and the conversation, endpoint, and
implementation-plan documents were rewritten in the candidate.

Source gaps: no direct user event in this session names `OpenFloorV1` or
separately accepts the complete BEGIN/ACK/final-signature flow, automatic
START signing, unanimity for both START and MULTICAST, the 90-second value,
or the closed content union. Those details are assistant proposals retained
by the later repository rewrite. The fixed-membership option quoted above
also mentioned pre-consent and threshold keys that later assistant work
replaced.

<a id="transport-and-mcp-boundaries"></a>

<a id="20260728-network-wire-is-http-post-polling"></a>

## Gate 1 uses closed HTTP POST operations and bounded Router polling

[ADR: `20260728-network-wire-is-http-post-polling.md`](../decisions/20260728-network-wire-is-http-post-polling.md)

1. **Assistant retry-identity question and selected option.** Locator:
   session `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa67d-bf08-7ad0-abd0-8c79687735cb`;
   `response_item.message`
   `msg_01bfa46407fa7e06016a68105aafe8819899d4f881527c1d35`;
   `2026-07-28T02:13:59.430Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D14 — What identifies a retry across L2, L3, and the control plane?
   >
   > [omitted: conflict, explanation, and stakes]
   >
   > **A — Separate typed IDs for each boundary (recommended).** L2 keys retries by `(SenderId, MessageId)`; L3 keys certified commits by `(ConversationId, MembershipEpoch, TxnId)`; control requests use `(AgentId, OperationId)` from D13. An identical retry returns the original position/result. Reusing an ID with different bytes is rejected as equivocation before Ledger append. Hashes provide integrity, not identity. Human: 4–6 days; Codex: 8–12 hours. Moderate initial work, lowest coupling and maintenance risk.
   >
   > [omitted: options B and C and recommendation]

2. **Stored user reply.** Locator: the same session; turn
   `019fa680-9db7-7740-bde4-d12d5b1a1801`;
   `event_msg.user_message`; `2026-07-28T02:14:34.752Z`.

   > 'A

3. **Assistant restart-fence question and proposed option.** Locator: the
   same session; turn `019fa6b4-6940-7f61-803d-165a221e2368`;
   `response_item.message`
   `msg_0c10c294c0d66118016a681e1a5da4819a91f4d42fc2aa66ef`;
   `2026-07-28T03:12:37.877Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D19 — How does an L2 restart fence the old order?
   >
   > [omitted: conflict and stakes]
   >
   > **A — Durable sequencer epoch fence (recommended).** On startup, the sole sequencer acquires an exclusive store-backed lease and atomically advances a monotonic `SequencerEpoch`. Every L2 delivery carries `(SequencerEpoch, ConversationSequence)`, and each L3 transaction binds to exactly one epoch. Seeing a new epoch aborts older in-flight folds; delayed old-epoch traffic is ignored. The Ledger may mechanically reject a certificate from a closed epoch, without judging task semantics. Only the epoch counter is durable—no message payloads or replay journal—so reliability remains in L3. Human: 4–6 days; Codex: 8–12 hours. Low ongoing risk.
   >
   > [omitted: options B and C and recommendation]

4. **Stored user deferral.** Locator: the same session; turn
   `019fa6b6-317b-7c62-b2fd-06f6d6ff8cb8`;
   `event_msg.user_message`; `2026-07-28T03:13:06.331Z`.

   > future problem

5. **Assistant closed-schema question and selected option.** Locator: the
   same session; turn `019fa6c2-2da4-7dc3-85e6-5c2a40f3af89`;
   `response_item.message`
   `msg_09ef334e2bc02940016a6821735eb8819aa4a17715e036afb5`;
   `2026-07-28T03:26:52.896Z`.

   > [omitted: prior decision-record acknowledgement]
   >
   > ### D24 — How should v2 handle unknown wire fields?
   >
   > [omitted: conflict and stakes]
   >
   > **A — Closed schemas everywhere.** Reject every unknown field or protected header. Any core wire addition requires a protocol-version change. This is easiest to reason about and test, but makes harmless experimentation and independent extensions expensive. Human: 3–5 days; Codex: 6–10 hours. Low ambiguity, high evolution friction.
   >
   > [omitted: options B and C and recommendation]

6. **Stored user reply.** Locator: the same session; turn
   `019fa6c3-1878-7381-b92a-71bd8b9eb264`;
   `event_msg.user_message`; `2026-07-28T03:27:11.545Z`.

   > A

7. **Stored user request.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa6c5-c7ac-7d91-a406-caf4c53e83a2`;
   `event_msg.user_message`; `2026-07-28T03:32:17.022Z`.

   > latest spec. 2026 july

8. **Stored user carrier change.** Locator: the same session; turn
   `019fa6ce-2760-7311-ac3a-91b995f4de45`;
   `event_msg.user_message`; `2026-07-28T03:39:16.358Z`.

   > I think lets actually migrate to HTTP POST polling for now?

9. **Stored user boundary correction.** Locator: the same session; turn
   `019fa6d3-57eb-7d00-a65d-a039f6f8b911`;
   `event_msg.user_message`; `2026-07-28T03:44:56.395Z`.

   > okay, actually lets simplify this: the wire format is something we can own. the endponts basically create an MCP compatible endpoint (stdio server) that delivers events and procesess any actions / norms / etc

10. **Assistant restatement.** Locator: the same session; the same turn;
   `response_item.message`
   `msg_0367538141dba836016a6825ed9254819a95ad9565ef88c3c0`;
   `2026-07-28T03:45:52.606Z`.

   > [omitted: opening response and component diagram]
   >
   > MCP becomes the local harness-facing ABI; it no longer constrains the network wire.
   >
   > [omitted: remainder of the stored message]

Repository effect: the linked ADR and the data-plane, control-plane, daemon,
and implementation-plan documents were rewritten in the candidate.

Source gaps: the retained user event asks, “I think lets actually migrate to
HTTP POST polling for now?”; another direct user event separates the owned
network wire from local MCP. The exact operation paths, deterministic-CBOR
catalog, 25-second bound, cursor fields, feed-gap behavior, retry modes, and
Router-instance fencing were assistant-authored details, not separately
selected by a stored user event.

<a id="20260728-endpoint-daemon-speaks-modern-mcp"></a>

## The endpoint daemon exposes modern MCP over loopback HTTP

[ADR: `20260728-endpoint-daemon-speaks-modern-mcp.md`](../decisions/20260728-endpoint-daemon-speaks-modern-mcp.md)

1. **Stored user reversal of the earlier stdio shape.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa6ee-9dbc-7073-b403-0708950aceb8`;
   `event_msg.user_message`; `2026-07-28T04:14:43.733Z`.

   > I think this is making me seem that the local daemon is not stdio mcp but maybe HTTP mcp that must be alive.

2. **Assistant restatement.** Locator: the same session; the same turn;
   `response_item.message`
   `msg_02cc728d3bd5e780016a682cfd8e7c8198bf4c348e480aeaa9`;
   `2026-07-28T04:15:58.966Z`.

   > Locked. The endpoint is one independently supervised local daemon exposing MCP 2026-07-28 Streamable HTTP at `/mcp`.
   >
   > [omitted: remainder of the stored message]

3. **Stored user trust deferral.** Locator: the same session; turn
   `019fa6f1-23f2-7ee3-a905-2689082dd942`;
   `event_msg.user_message`; `2026-07-28T04:18:26.761Z`.

   > I think local process security is deferred for now. assume trusted

4. **Assistant question and stored user reply.** Assistant locator: the same
   session; turn `019fa6fb-33fb-74f3-a603-9ea8206b5b69`;
   `response_item.message`
   `msg_07a8b2a338a4a925016a6831d2d2b481999445fe3bfe7845f9`;
   `2026-07-28T04:36:38.496Z`.

   > D42 — Whole-adapter concurrency (architecture, high confidence)
   >
   > [omitted: concrete example]
   >
   > A — One active adapter (recommended).
   >
   > [omitted: remainder of option A and options B and C]

   Stored user locator: the same session; turn
   `019fa703-87d4-7213-9080-73b794305921`;
   `event_msg.user_message`; `2026-07-28T04:37:34.722Z`.

   > only one per daemon; both cannot race

Repository effect: the linked ADR and daemon, endpoint, channel, and
implementation-plan documents were rewritten in the candidate.

Source gaps: the pinned MCP commit, exact discovery metadata, error codes,
subscription frames, port/profile rules, compare-and-swap watermarks,
delivery-loss behavior, and persisted receipt design were specified by
assistant-authored review and repository edits rather than separate user
selections.

<a id="20260728-model-surface-is-start-reply-listen"></a>

## The model surface is start_conversation, reply, and listen

[ADR: `20260728-model-surface-is-start-reply-listen.md`](../decisions/20260728-model-surface-is-start-reply-listen.md)

1. **Assistant revised shared-core question and selected option.** Locator:
   session `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa662-a495-7952-8cba-eed4d6fb2a9b`;
   `response_item.message`
   `msg_073ea08a964186bd016a6809349fc8819bbf6e3f36b64bef81`;
   `2026-07-28T01:43:27.325Z`.

   > [omitted: repository finding and proposed component tree]
   >
   > ### Revised D7 — Where does the shared core stop?
   >
   > **A — Shared mechanics and enforcement (recommended).** `SharedCore` owns L1–L4 plus the ordering and fail-closed execution of L5. A runtime adapter supplies personal policy, semantic-screen implementations, and model-specific context through callbacks, but cannot reorder or bypass the pipeline. Human: 5–7 days; Codex: 10–14 hours. This keeps norm interpretation consistent and threshold shares inaccessible while retaining runtime-specific judgment.
   >
   > [omitted: option B, recommendation, and closing question]

2. **Stored user reply.** Locator: the same session; turn
   `019fa665-16ad-7231-acde-07ac87c0ea1e`;
   `event_msg.user_message`; `2026-07-28T01:44:30.706Z`.

   > a

3. **Stored user surface statement.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa6e6-c3cd-7021-843b-567e410eb018`;
   `event_msg.user_message`; `2026-07-28T04:06:09.204Z`.

   > I think we need a start conversation and then reply? no generic send

4. **Assistant restatement.** Locator: the same session; the same turn;
   `response_item.message`
   `msg_0bef6629d48e79d2016a682ae19150819885192a9b5c104dce`;
   `2026-07-28T04:07:00.657Z`.

   > [omitted: opening response and mapping diagram]
   >
   > `reply` consumes the event’s one-shot transaction handle, so it cannot target an arbitrary conversation. There is no `send(conversationId, ...)`, no generic completion tool, and no public `begin/update/commit/abort`; SharedCore runs those mechanics internally.
   >
   > [omitted: closing sentence]

5. **Stored request-user-input call, decoded field projection.** Locator: the
   same session; turn
   `019fa6e6-c3cd-7021-843b-567e410eb018`;
   `response_item.function_call`
   `fc_0bef6629d48e79d2016a682aff7cc081989f1079734419e212`;
   call `call_Y79Pxu7l1uYNZ1HeLiTPu4vW`;
   `2026-07-28T04:07:38.767Z`.

   The block below projects decoded fields from the stored JSON arguments.
   JSON escaping and blockquote layout are display normalization; omission
   markers identify the unretained structured fields.

   > [omitted: outer structured-call keys before the question field]
   >
   > D34 - Does `reply` choose an action, or only supply content for one the engine already selected?
   >
   > [omitted: question rationale, stakes, recommendation, and long-form option analysis]
   >
   > `[{"label":"34A Engine-selected (Recommended)","description":"Use reply(txnId, body); the transaction already binds the conversation, action, norm snapshot, and deadline."},{"label":"34B Runtime selects","description":"Let reply include one action chosen from the granted event’s allowed-action set."},{"label":"34C Action tools","description":"Expose each legal action as its own MCP tool instead of one reply tool."}]`
   >
   > [omitted: remaining structured-call delimiters]

6. **Stored function output.** Locator: the same session and turn;
   `response_item.function_call_output`;
   call `call_Y79Pxu7l1uYNZ1HeLiTPu4vW`;
   `2026-07-28T04:08:03.324Z`.

   > `{"answers":{"reply_action_binding":{"answers":["34C Action tools"]}}}`

7. **Stored user correction.** Locator: the same session; turn
   `019fa6ea-1304-7b13-8c7a-8a392fda14dc`;
   `event_msg.user_message`; `2026-07-28T04:09:46.377Z`.

   > B shaped for now; weather we create custom tools per action etc., is future work?

8. **Stored user delivery statement.** Locator: the same session; turn
   `019fa6fb-33fb-74f3-a603-9ea8206b5b69`;
   `event_msg.user_message`; `2026-07-28T04:28:28.943Z`.

   > I think notifications should just push the new messages to the agent. Lets just do that for now?

Repository effect: the linked ADR and daemon, endpoint, channel, and
implementation-plan documents were rewritten in the candidate.

Source gaps: the function output is not stored with actor role `user`; the
later direct user event is the source that explicitly changes the shape back
to B. The exact listen notification schema, OperationId derivation, durable
reply receipt, fingerprint, error set, and watermarks were later
assistant-authored details, not separately selected user events.

<a id="packages-version-and-simulator"></a>

<a id="20260728-six-deep-packages-one-version"></a>

## V2 has six deep packages and one Moltzap version

[ADR: `20260728-six-deep-packages-one-version.md`](../decisions/20260728-six-deep-packages-one-version.md)

1. **Stored user package direction.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa9c1-4907-7a00-878b-994029d0f7a3`;
   `event_msg.user_message`; `2026-07-28T17:24:05.630Z`.

   > I don't like the package names. I think they should be somewhat more netwroking vernacular. The simulator is also stable-ish now so you want to look at and build on top of that as well. The architecture shuold follow osterhout's principals of software deisgn

2. **Assistant package proposal.** Locator: the same session; the same turn;
   `response_item.message`
   `msg_073ea17e67c725ad016a68ebeec9988198afa282808774c6a1`;
   `2026-07-28T17:50:40.402Z`.

   > Locked: six deep packages — `identity`, `transport`, `transcript`, `endpoint`, `simulator`, and `testbed`.
   >
   > [omitted: remainder of the stored message]

3. **Stored user version correction.** Locator: the same session; the same
   turn; `event_msg.user_message`; `2026-07-28T18:04:14.872Z`.

   > actually lets do one shared version

Repository effect: the linked ADR and package/version sections of the
architecture and implementation-plan documents were added or rewritten in
the candidate.

Source gaps: the user event supplies networking-vernacular naming,
simulator/build-on-it, Ousterhout-principles, and one-version directions.
The exact six names, dependency graph, ownership table, exports, binaries,
CalVer location, and independent-version exceptions were assistant-authored
details without a later direct user event enumerating them.

<a id="20260728-simulator-is-the-system-driver"></a>

## V2 owns one simulator as the system driver

[ADR: `20260728-simulator-is-the-system-driver.md`](../decisions/20260728-simulator-is-the-system-driver.md)

1. **Stored user direction.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019fa9c1-4907-7a00-878b-994029d0f7a3`;
   `event_msg.user_message`; `2026-07-28T17:24:05.630Z`.

   > [omitted: preceding sentence about package names]
   >
   > The simulator is also stable-ish now so you want to look at and build on top of that as well.
   >
   > [omitted: following sentence about architecture]

2. **Assistant porting proposal.** Locator: the same session; the same turn;
   `response_item.message`
   `msg_050571577920926d016a68edd0f3008199bdc412c135ac23e3`;
   `2026-07-28T17:58:43.113Z`.

   > Locked: the simulator rewrite becomes a reproducible upstream baseline first—rebased, constitution-aligned, fully tracked, non-vacuously checked, green, and identified by an immutable commit SHA.
   >
   > [omitted: remainder of the stored message]

3. **Stored user challenge to later terminology.** Locator: the same session;
   turn `019faa9c-a8f8-72f3-b902-819730297f42`;
   `event_msg.user_message`; `2026-07-28T21:23:41.617Z`.

   > simulator/wire-profile source? what s this?

Repository effect: the linked ADR, simulator handoff input, package
architecture, and implementation-plan documents were added or rewritten in
the candidate.

Source gaps: the exact retained kernel APIs, `StackProvider` ownership,
RunLedger separation, immutable-SHA handoff mechanics, testbed boundary, and
legacy exclusions were assistant-authored. The stored user event calls the
simulator “stable-ish”; it does not say “stable enough,” and it does not
separately accept every porting gate. A machine-local worktree path supplied
later in the session is omitted from this repository artifact.

<a id="repository-freeze-and-review-tooling"></a>

<a id="20260728-gate-1-architecture-freeze"></a>

## Gate 1 starts with a repository-native architecture freeze

[ADR: `20260728-gate-1-architecture-freeze.md`](../decisions/20260728-gate-1-architecture-freeze.md)

1. **Stored user ordering requirement.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019faa35-8308-7072-a4dc-7ba8b6ebb85d`;
   `event_msg.user_message`; `2026-07-28T19:31:03.576Z`.

   > I like this: the entire plan and the durable record of all decions must first be updated in the repo and all previous things be reconcilled so that a cold reader can review everything.

2. **Assistant proposal immediately before execution.** Locator: the same
   session; the same turn; `response_item.message`
   `msg_0a59fc7a75687fd4016a6907a037b4819ba26209dd13bc3652`;
   `2026-07-28T19:50:26.521Z`.

   > [omitted: opening `<proposed_plan>` tag]
   >
   > # MoltZap v2 Gate 1 — Repository-First Architecture Freeze
   >
   > [omitted: section heading]
   >
   > Before simulator landing, package scaffolding, or product code, land a documentation-first PR on `main`.
   >
   > [omitted: remainder of the stored plan]

3. **Stored user reply.** Locator: the same session; turn
   `019faa49-1c6e-7380-95ca-ee2eab6febde`;
   `event_msg.user_message`; `2026-07-28T19:52:26.138Z`.

   > go

Repository effect: the linked manifest ADR and the candidate's ADR,
specification, architecture, evidence, and input-document changes followed.

Source gaps: `go` follows the full assistant plan and authorizes work in
context; it is not a separate item-by-item user quotation approving every
trace row, normative owner, acceptance family, deferral, or later
conflict-resolution edit.

<a id="20260728-adrs-link-source-events-and-require-blind-review"></a>

## ADRs link source events and require blind review

[ADR: `20260728-adrs-link-source-events-and-require-blind-review.md`](../decisions/20260728-adrs-link-source-events-and-require-blind-review.md)

1. **Stored user process request.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019faaa8-01ab-77b3-ab54-6db6d51f1a08`;
   `event_msg.user_message`; `2026-07-28T21:36:05.605Z`.

   > can we formalize the ADR process in the root AGENTS.md

2. **Stored user gate and provenance request.** Locator: the same session;
   turn `019faab0-a8c0-7860-93c2-c1759dd02f69`;
   `event_msg.user_message`; `2026-07-28T21:45:32.585Z`.

   > one gate we should add: after updating ADRs: we should do cold team mate review, where they are asked to answer speciic questions without being pointed at the ADR or the specific files? that forces you to check how good the organization and quality is. Also another thing we should add is that each ADR should link to "compacted session trajectories" -- basically what was the actual context and the circumstances; we are trying to teach the agents "blame" back to humans rather than treating any piece of written text as fixed and trying to see where uncertaininty and rushed decisions were maybemade

3. **Assistant implementation proposal.** Locator: the same session; the
   same turn; `response_item.message`
   `msg_0eb82b1dcd48e94e016a6924544044819abd564a3539d645da`;
   `2026-07-28T21:51:18.365Z`.

   > There’s no existing trajectory format.
   >
   > [omitted: remainder of the stored message]

Repository effect: the linked ADR, root `AGENTS.md`, decision index, and
decision-evidence area were added or rewritten in the candidate.

Source gaps: the exact six blind-review questions, 45-minute bound, artifact
fields, rerun rules, and PASS/FAIL details were written by the assistant
after the user requested the gate. The stored user request does not supply
those exact words.

<a id="adr-process-source-fidelity-correction"></a>

## ADR-process source-fidelity correction

[Related ADR: `20260728-adrs-link-source-events-and-require-blind-review.md`](../decisions/20260728-adrs-link-source-events-and-require-blind-review.md)

1. **Stored user correction.** Locator: session
   `019fa633-abe3-7223-8c51-6d061f5c5855`; turn
   `019faac4-5c6c-7152-822a-9ce4ceb74de4`;
   `event_msg.user_message`; `2026-07-28T22:07:03.743Z`.

   > go through the actual old trajectories that are stored and compact them. I'm worries your current evidence thing is a bit too editorialized. This is like git blame not a psychoanalysis

2. **Assistant acknowledgement.** Locator: the same session; the same turn;
   `response_item.message`
   `msg_0354b57134abd05c016a6928136a788198bbcfdcf700ff27fe`;
   `2026-07-28T22:07:17.564Z`.

   > You’re right. The current trajectory files infer a narrative from ADRs and commits; that is too editorialized for what should behave like `git blame`.
   >
   > [omitted: remainder of the stored message]

Repository effect: this revision replaces the prior topical narrative with
source-located events, mechanical file effects, and explicit gaps.

Source gap: no later event in the stored source approves this ledger's exact
selection of excerpts or headings. They are the compactor's implementation
of the correction above and remain reviewable against the cited session.
