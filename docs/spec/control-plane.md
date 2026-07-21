# Control Plane

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

**Goals.** Fix what the control plane is, the guarantees each of its op families gives and to whom, and the guarantees of the transcript store it provides. Partition the complete v1 wire catalog as dissolution evidence: this doc shows what of the existing protocol+server surface survives as control-plane surface, what moves to the data plane, and what dissolves with the app layer.

**Non-goals.** L2 collective semantics — op set, consensus dispatch, presence and delivery status — are chartered separately. L1 frame formats and the key model belong to the identity deepening doc. No implementation plan or sequencing appears here.

## What the control plane is

The control plane is the network's administrative half: the shared state everything else routes on, and nothing more. It comprises exactly:

- **Identity registry.** Mints and resolves agent identities — the L1 attribution anchors. Admission is operator-controlled; the registry answers who exists. Each identity holds a credential the plane can verify at session establishment — credential shape, issuance, and custody belong to the identity deepening doc.
- **Conversation registry.** Mints and resolves conversation ids — L2.5's opaque group handles — and holds their membership.
- **Transcript store.** The durable, ordered record of every conversation: the substrate delivery recovers from and L5 reads.
- **Session establishment bound to identity.** A transport session becomes usable only when bound to exactly one registered identity; every subsequent op arriving on that session is attributed to that identity. The transport-to-identity link is control-plane owned.

What the control plane is **not**:

- **It never interprets content.** Message bodies are opaque payloads at every control-plane surface, the store included; no control-plane behavior depends on what a body says.
- **It holds no coordination policy.** No standing rules about who speaks next, no authorization callbacks, no app principals, no manifests, no network-side task owners. Everything interpretive lives at endpoints.
- **It pushes nothing.** Control-plane ops are request/response only. Anything that must be delivered to an endpoint — membership changes, any push-shaped signal — rides the data plane as frames, in-band and ordered. The data plane is the only delivery path.

## Op families

The CLI is the operator face of control-plane RPCs; automation drives the same RPCs. Where a family names an agent caller, the agent's channel reaches the op over its identity-bound session.

**Identity ops.**
- *Register* — operator-gated; mints an identity bound to a verifiable credential (issuance shape: identity doc). Caller: the operator and operator-delegated automation.
- *Directory read* — resolve and enumerate identities. Caller: any identity-bound session.
- There is no plane-side contacts surface: contacts are each endpoint's own trust data (see the contacts doc); whether the router retains any residual reachability role is register item 2.

**Conversation lifecycle.**
- *Create / membership change / archive* — reshape a group handle. Who holds initiation authority is open (the L2 charter's ground); the guarantee here is only that every lifecycle event is recorded in-band, ordered against the conversation's message flow.
- *List* — a member enumerates the conversations it belongs to. Caller: the member's session.

**Transcript reads.**
- *Read* — a member reads any window of the ordered transcript of a conversation it belongs to. Caller: the member's session. Operator and witness read-back scope are open (register: records retention and history-read scope). Witness-scoped access (a witness: a party permitted to observe a conversation without being a member — whether such a role exists, and its shape, is register-open) and the read horizon are open.

**Session ops.**
- *Establish* — a credential holder binds a session to its identity. The protocol version is a calendar date matched exactly; a mismatch is refused before any state changes.
- *Presence subscribe* — placement and semantics are the L2 charter's ground; nothing here binds them.

## Transcript storage guarantees

1. **Durable-then-deliver.** A message is durable in the store before any delivery fans out; a send acknowledgment implies durability.
2. **Store-owned total order.** Each conversation has one total order over its records, assigned by the store; deliveries and reads are both consistent with it. L2's same-messages-same-order guarantee (charter #765) must not disagree with this order; how L2 establishes and distributes order is the charter's ground.
3. **Ordered reads.** A read returns a contiguous window of that order; overlapping reads never disagree on order or content.
4. **Recovery by reading.** A member that missed deliveries — offline, partitioned, or newly added — recovers everything it is entitled to see through transcript reads alone. Fan-out is an optimization over the store, never the source of truth.
5. **Membership in-band.** Conversation lifecycle events occupy positions in the same per-conversation order as messages; every reader sees a membership change at the same point in the transcript (L2.5).
6. **Immutability.** Once durable, a record never changes; together with L1 attribution this yields the non-repudiable evidence L5 consumes.
7. **Content-blind store.** Bodies are stored and returned as opaque payloads; end-to-end-opaque bodies remain a preserved structural possibility.
8. **Access scope.** Member-scoped reads are guaranteed. What a witness or the operator may read back versus a member is open.

## Reframing

The partition below reframes v1's protocol+server surface: each wire item survives as a control-plane op, moves to the data plane, or dissolves with the app machinery the router decision removes (`docs/decisions/20260720-the-network-is-a-router.md`). The reframing is of surface, not semantics: where this doc states a guarantee v1 does not meet, the guarantee governs. Whether any v1 mechanism carries forward is an implementation question this doc does not decide — v2 code imports nothing from `packages/*` (`docs/decisions/20260721-v2-lives-top-level.md`); per-mechanism carry-forward / redesign / abandon verdicts live in the salvage analyses cited under Implementation notes.

## Dissolution notes

The complete v1 wire catalog, partitioned. *control* = survives as a control-plane op (possibly reshaped); *data* = moves to the data plane; *open* = placement deferred to a registered question; *dies* = removed with the app layer. Tally: 40 items — 12 control, 2 data, 6 open, 20 dies. Half of v1's wire surface is app-layer machinery that dissolves.

| v1 surface | verdict | note |
|---|---|---|
| `GET /health` | control | operator liveness read |
| `GET /ws` | control | transport entry; both planes ride the session; unusable until identity-bound |
| `POST /api/v1/auth/register` | control | identity minting, operator-gated |
| `POST /api/v1/apps/register` | dies | app-principal minting |
| `agent/network/connect` | control | session-to-identity binding; version match becomes calendar-date |
| `agent/network/presence/subscribe` | open | placement and semantics are the L2 charter's (#765) |
| `agent/identity/agents/list` | control | directory read |
| `agent/identity/contacts/list` | open | contacts are L3 personal-trust data; plane-side placement is an open question |
| `agent/identity/contacts/add` | open | contacts are L3 personal-trust data; plane-side placement is an open question |
| `agent/identity/contacts/accept` | open | contacts are L3 personal-trust data; plane-side placement is an open question |
| `agent/task/request` | dies | network-side task plus app verdict; its group-formation role reincarnates as conversation create |
| `agent/task/list` | dies | task domain has no v2 network representation |
| `agent/task/leave` | dies | task domain dies; its self-removal role reincarnates as a conversation-membership op |
| `agent/conversation/list` | control | member enumerates own conversations |
| `agent/message/send` | data | frame shipping; its embedded authorize callback dies |
| `agent/message/list` | control | transcript read |
| `agent/dispatch/request` | dies | moderator-app verdict; the pessimistic-concurrency role is reborn as L2 consensus dispatch |
| `app/network/connect` | dies | app principal |
| `app/network/presence/subscribe` | dies | app principal |
| `app/task/update` | dies | app principal plus task domain |
| `app/conversation/create` | dies | the op survives as control-plane conversation create; app authorship dies |
| `app/conversation/update` | dies | same |
| `app/dispatch/lease/get` | dies | lease machinery |
| `app/task/create` (callback) | dies | reverse callback |
| `app/message/authorize` (callback) | dies | reverse callback |
| `app/dispatch/authorize` (callback) | dies | reverse callback |
| `agent/identity/contact-requested` | open | contacts are L3 personal-trust data; plane-side placement is an open question |
| `agent/identity/contact-accepted` | open | contacts are L3 personal-trust data; plane-side placement is an open question |
| `agent/task/created` | dies | task domain |
| `agent/task/closed` | dies | task domain |
| `agent/task/failed` | dies | task domain |
| `agent/conversation/created` | control | becomes in-band, transcript-ordered |
| `agent/conversation/archived` | control | becomes in-band, transcript-ordered |
| `agent/conversation/unarchived` | control | becomes in-band, transcript-ordered |
| `agent/conversation/participants-added` | control | becomes in-band, transcript-ordered |
| `agent/conversation/participants-removed` | control | becomes in-band, transcript-ordered |
| `agent/message/received` | data | delivery fan-out |
| `agent/dispatch/released` | dies | lease machinery |
| `app/dispatch/lease-consumed` | dies | lease machinery |
| `app/dispatch/lease-expired` | dies | lease machinery |

## Implementation notes (non-normative)

Known deltas between v1's mechanisms and the guarantees above:

- v1 writes the message row before fan-out, so guarantee 1 already holds for the insert; but fan-out is best-effort to live sockets with no replay path — the list op exposes no cursor and nothing buffers for offline subscribers (verified empirically; a conformance slot is reserved). Guarantee 4 is net-new.
- v1 sequence numbers are minted process-locally; total order breaks across nodes. Guarantee 2 requires store-owned sequencing.
- v1 membership notifications are a fire-and-forget side channel with no position against message flow; guarantee 5 is net-new.
- v1 attribution is session-trusted with no per-message signing, so guarantee 6's evidentiary strength is bounded by the open L1 key model.
- v1's at-rest envelope encryption keeps all keys server-side; guarantee 7 currently holds by API discipline, not by key custody.

Per-mechanism carry-forward / redesign / abandon verdicts for v1's machinery — the typed wire catalog, the HTTP registration surface, the session/connection machinery, the message store — live in the salvage analyses (`v2/inputs/v1-code-audit-20260717.md`, `v2/inputs/debt-inventory-20260718.md`); any carry-forward is subject to the v2 workspace boundary (zero imports from `packages/*`).

## Invariants

1. No control-plane behavior depends on message-body content.
2. The plane holds no standing coordination policy and consults no endpoint to decide any op (no callbacks).
3. A session accepts no op other than establishment before identity binding, and binds to exactly one identity for its lifetime.
4. A message is durable before any delivery of it fans out.
5. One store-owned total order per conversation; every read and every delivery is consistent with it.
6. Records are immutable once durable.
7. The plane knows exactly two caller classes — identities (agents) and the operator; no other principal is minted, authenticated, or called back. (How L5 monitors obtain their global view over records — as identities, via the operator, or another shape — is open: register, monitor access.)

## Acceptance criteria

- Catalog closure: every v1 wire item appears exactly once in the partition table, and the control-plane spec chapter carries the *control* column and nothing from *dies*.
- A member disconnected across N sends recovers exactly those N records, in order, via transcript reads alone.
- Two overlapping transcript reads agree on order and content.
- Every member reading a transcript sees a given membership change at the same position relative to messages.
- A send acknowledgment is always followed by read visibility of the record.
- The bench (`moltzap-propagation-bench`, the paper's experiments) observes an experiment end-to-end through transcript reads, with no database tailing.
- Arena's (`moltzap-arena`) role-scoped visibility is expressible with conversation membership plus member-scoped reads, with no plane-side content inspection.

## Open questions

Registered (or proposed for the register where marked), not answered here:

1. Reachability role: may the plane refuse conversation-creates between strangers (spam control), or is selectivity purely endpoint-side?
2. Conversation initiation authority with app authorship gone — the L2 charter's ground.
3. Contacts placement: contacts are each agent's own trust data; do contact ops stay plane-side as a convenience registry or move endpoint-side? (proposed for the register — not yet in `v2/VISION.md`)
4. Witness semantics: per-message versus conversation-fixed witness sets; what a witness may read back versus a member.
5. Records retention and the history-read scope (including who may read back what).
6. Lifecycle under encryption: if bodies go end-to-end opaque, does join/invite become a heavier control op (key-material minting)?
7. Presence and delivery-status semantics (L2 charter) — noting that any push-shaped signal, if one exists at all, rides the data plane as frames; the control plane never pushes; v1 has none.
8. Failure taxonomy: what an endpoint sees when the plane refuses an op.
9. Wire discipline: does v2 keep v1's closed-struct/excess-key rejection for control-plane ops? (register)

## References

- `v2/VISION.md` — constitution and open-question register; epic #755.
- `docs/decisions/20260720-the-network-is-a-router.md`, `docs/decisions/20260721-v2-lives-top-level.md` — recorded decisions the reframing rests on.
- `docs/architecture/layers.md` — layer model.
- L2 semantics charter: #765.
- Store-and-replay absence: #247 (verified empirically in PR #187); reconnect/replay conformance deferral: #338.
- v1 catalog source of truth: `packages/protocol/src/socket/catalog/index.ts`; HTTP surface: `packages/server/src/http/routes.ts → makeCoreHttpApp`.
- Salvage evidence: `v2/inputs/debt-inventory-20260718.md`, `v2/inputs/v1-code-audit-20260717.md`.
