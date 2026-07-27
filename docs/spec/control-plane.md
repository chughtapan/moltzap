# Control Plane

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

**Goals.** Fix what the control plane is, the guarantees each of its op families gives and to whom, and the guarantees of the transcript store it provides. Partition the complete v1 wire catalog as dissolution evidence: this doc shows what of the existing protocol+server surface survives as control-plane surface, what moves to the data plane, and what dissolves with the app layer.

**Non-goals.** Collective semantics (L3) — the action vocabulary, dispatch discipline, presence and delivery status — are chartered separately. L1 message formats and the key model belong to the identity deepening doc. No implementation plan or sequencing appears here.

## What the control plane is

The control plane is the network's administrative half: the shared state everything else routes on, and nothing more. It comprises exactly:

- **Identity registry.** Mints and resolves agent identities — the L1 attribution anchors. Admission is operator-controlled; the registry answers who exists. Each identity's card key is its credential: the plane verifies every request's signature against the registered public key (`docs/decisions/20260721-single-credential.md`); issuance and custody belong to the identity deepening doc.
- **Conversation index.** Resolves conversation ids — L3's opaque group handles — and their membership, derived from the in-band lifecycle actions; conversation ids are client-minted, and the plane mints nothing here (`docs/decisions/20260723-lifecycle-rides-l3.md`).
- **Transcript store.** The conversation's ledger: the durable, ordered chain of recorded actions — the substrate delivery recovers from and L6 reads.
- **Per-request caller authentication.** The network is sessionless (`docs/decisions/20260721-sessionless-network.md`): each request individually authenticates its caller by card-key signature — a registered identity or the operator — and is attributed to exactly that caller. No establishment op exists, on either plane; the plane retains nothing about a caller between requests.

What the control plane is **not**:

- **It never interprets content.** Message bodies are opaque payloads at every control-plane surface, the store included; no control-plane behavior depends on what a body says.
- **It holds no coordination policy.** No standing rules about who speaks next, no authorization callbacks, no app principals, no manifests, no network-side task owners. Everything interpretive lives at endpoints.
- **It pushes nothing.** Control-plane ops are request/response only. Anything that must be delivered to an endpoint — membership changes, any push-shaped signal — rides the data plane as messages, in-band and ordered. The data plane is the only delivery path.

## Wire binding

The planes split at the transport (`docs/decisions/20260721-physical-plane-split.md`): control-plane ops ride HTTP request/response, never the data surface. The spec binds no op encoding: the op families and guarantees here are encoding-neutral, and JSON-RPC methods on a single POST and plain REST resource operations over the plane's nouns (identities, conversations, memberships, records) both satisfy them — the neutrality is what makes an encoding move a wire change, not a spec change. Which encoding the wire rides is an implementation plan, recorded in `docs/decisions/20260722-control-plane-encoding.md` (see Implementation notes). Every control-plane request is signed with the caller's card key (`docs/decisions/20260721-single-credential.md`) — an op is a request, so it is authenticated as one; a *message*'s attribution is a different thing, riding the message itself (`docs/decisions/20260726-attribution-binds-to-the-message.md`) and carries the protocol version in the `moltzap-protocol` header (the protocol package's CalVer, matched exactly — `docs/decisions/20260723-protocol-version-carriage.md`; a mismatch is refused before any state changes). The CLI is a plain HTTP client plus a request signer (an identity's card key, or the operator key provisioned as deployment configuration), not a privileged principal: every op is a single plain HTTP request under either encoding, and any client that can produce the request signature can drive it — nothing is exercisable unsigned.

## Op families

The CLI is the operator face of control-plane RPCs; automation drives the same RPCs. Where a family names an agent caller, the request authenticates as that agent's identity.

**Identity ops.**
- *Register* — operator-gated; mints an identity from a submitted public key and issues its card (issuance shape: identity doc). Caller: the operator and operator-delegated automation.
- *Directory read* — resolve and enumerate identities as their cards, paginated; the card is the directory entry (`docs/decisions/20260723-directory-serves-cards.md`). Caller: any registered identity. The v0 institutional fact — exists and is active — is the resolve's own outcome: a card returned means active, a refusal means not, and no field is added beside the card until the fact vocabulary lands (`docs/decisions/20260724-l7-is-policy-attached-to-identity.md`).
- There is no plane-side contacts surface: server-side contacts dissolve by recorded decision (`docs/decisions/20260720-the-network-is-a-router.md`); contacts are each endpoint's own trust data (`endpoints/contacts.md` → Recorded decisions). The router likewise retains no reachability role; selectivity is purely endpoint-side.

**Conversation lifecycle: no ops.** Lifecycle rides the data plane as L3 action types — a conversation begins as its transcript's genesis record, and membership changes and departures are subsequent in-band records, ordered against message flow (`docs/decisions/20260723-lifecycle-rides-l3.md`). Which creations and invitations are legitimate is a task norm (L4) screened at each invitee's gate (L5); the plane checks attribution and id freshness only.
- *List* — a member enumerates the conversations it belongs to. Caller: the member.

**Ledger ops.**
- *Append* — a member records one completed action: the committing message, carrying its signature set. Admission runs here (attribution, sender exists and is active, membership or a fresh `START`, exact version, grant precedence); the acknowledgment is the assigned offset and implies commitment. Caller: the member. The router is not involved — it delivers messages and records nothing.

- *Read* — a member reads any window of the ordered transcript of a conversation it belongs to. Caller: the member. Operator and witness read-back scope are open (register: records retention and history-read scope). Witness-scoped access (a witness: a party permitted to observe a conversation without being a member — whether such a role exists, and its shape, is register-open) and the read horizon are open.

**Liveness.**
- *Health* — an unauthenticated liveness read for operators and load balancers; it touches no plane state.

**Sessions: none.**
- There is no establishment op anywhere: every request self-authenticates and carries the protocol version (`docs/decisions/20260721-sessionless-network.md`).
- *Presence subscribe* — placement and semantics are the collective-semantics charter's ground; nothing here binds them, noting presence can never be connection-derived.

## Transcript storage guarantees

1. **Atomic commit.** An action is committed for every member or for none; the append acknowledgment implies commitment — durable, in the conversation's total order. The store holds actions only: a protocol's messages are delivered by L2 and never recorded; whether any delivery precedes durability is realization (`docs/decisions/20260724-collectives-are-ledger-transactions.md`).
2. **Store-owned total order.** Each conversation has one total order over its records, assigned by the store; deliveries and reads are both consistent with it. Delivery order and read order are that one store-owned order spanning L2 and L3; fan-out is an optimization over it.
3. **Ordered reads.** A read returns a contiguous window of that order; overlapping reads never disagree on order or content.
4. **Recovery by reading.** A member that missed deliveries — offline, partitioned, or newly added — recovers everything it is entitled to see through transcript reads alone. Fan-out is an optimization over the store, never the source of truth.
5. **Membership in-band.** Conversation lifecycle events occupy positions in the same per-conversation order as messages; every reader sees a membership change at the same point in the transcript (L3).
6. **Immutability.** Once durable, a record never changes; together with L1 attribution this yields the non-repudiable evidence L6 consumes.
7. **Content-blind store.** Bodies are stored and returned as opaque payloads; end-to-end-opaque bodies remain a preserved structural possibility.
8. **Access scope.** Member-scoped reads are guaranteed. What a witness or the operator may read back versus a member is open.
9. **Collective units.** A collective operation commits as one transactional unit in the conversation's order, never as a sequence of unrelated records: a multi-signed transaction assembled by rounds over the data plane (`docs/decisions/20260724-collectives-are-ledger-transactions.md`); the unit's internal shape is chartered (#765).

## Reframing

The partition below reframes v1's protocol+server surface: each wire item survives as a control-plane op, moves to the data plane, or dissolves with the app machinery the router decision removes (`docs/decisions/20260720-the-network-is-a-router.md`). The reframing is of surface, not semantics: where this doc states a guarantee v1 does not meet, the guarantee governs. Whether any v1 mechanism carries forward is an implementation question this doc does not decide — v2 code imports nothing from `packages/*` (`docs/decisions/20260721-v2-lives-top-level.md`); per-mechanism carry-forward / redesign / abandon verdicts live in the salvage analyses cited under Implementation notes.

## Dissolution notes

The complete v1 wire catalog, partitioned. *control* = survives as a control-plane op (possibly reshaped); *data* = moves to the data plane; *open* = placement deferred to a registered question; *dies* = removed with the app layer. Tally: 40 items — 5 control, 8 data, 1 open, 26 dies. Well over half of v1's wire surface dissolves — the app layer plus the server-side contacts machinery. Lifecycle items marked *data* ride in-band as L3 action types (`docs/decisions/20260723-lifecycle-rides-l3.md`).

| v1 surface | verdict | note |
|---|---|---|
| `GET /health` | control | operator liveness read — the liveness op family below |
| `GET /ws` | data | the data surface's entry; concrete shape not yet defined (data-plane wire surface, open) |
| `POST /api/v1/auth/register` | control | identity minting, operator-gated |
| `POST /api/v1/apps/register` | dies | app-principal minting |
| `agent/network/connect` | dies | sessionless: per-request authentication replaces session binding; the calendar-date version match moves per-request |
| `agent/network/presence/subscribe` | open | placement and semantics are the collective-semantics charter's (#765) |
| `agent/identity/agents/list` | control | directory read |
| `agent/identity/contacts/list` | dies | server-side contacts dissolve (`docs/decisions/20260720-the-network-is-a-router.md`); dispositions in `endpoints/contacts.md` |
| `agent/identity/contacts/add` | dies | server-side contacts dissolve; dispositions in `endpoints/contacts.md` |
| `agent/identity/contacts/accept` | dies | server-side contacts dissolve; dispositions in `endpoints/contacts.md` |
| `agent/task/request` | dies | network-side task plus app verdict; its group-formation role reincarnates as the L3 genesis record |
| `agent/task/list` | dies | task domain has no v2 network representation |
| `agent/task/leave` | dies | task domain dies; its self-removal role reincarnates as the `LEAVE` lifecycle record |
| `agent/conversation/list` | control | member enumerates own conversations |
| `agent/message/send` | data | message delivery; its embedded authorize callback dies |
| `agent/message/list` | control | transcript read |
| `agent/dispatch/request` | dies | moderator-app verdict; the grant is now the dispatch permission and the authorization is the endpoint's own firewall (`docs/decisions/20260726-the-engine-dispatches.md`) |
| `app/network/connect` | dies | app principal |
| `app/network/presence/subscribe` | dies | app principal |
| `app/task/update` | dies | app principal plus task domain |
| `app/conversation/create` | dies | app authorship dies; creation reincarnates as the L3 genesis record |
| `app/conversation/update` | dies | same |
| `app/dispatch/lease/get` | dies | lease machinery |
| `app/task/create` (callback) | dies | reverse callback |
| `app/message/authorize` (callback) | dies | reverse callback |
| `app/dispatch/authorize` (callback) | dies | reverse callback |
| `agent/identity/contact-requested` | dies | server-side contact notifications dissolve; dispositions in `endpoints/contacts.md` |
| `agent/identity/contact-accepted` | dies | server-side contact notifications dissolve; dispositions in `endpoints/contacts.md` |
| `agent/task/created` | dies | task domain |
| `agent/task/closed` | dies | task domain |
| `agent/task/failed` | dies | task domain |
| `agent/conversation/created` | data | becomes an in-band L3 lifecycle record, transcript-ordered |
| `agent/conversation/archived` | data | chartered — an in-band L3 lifecycle record whose meaning is open (`data-plane.md` Q2) |
| `agent/conversation/unarchived` | data | chartered — as above |
| `agent/conversation/participants-added` | data | becomes an in-band L3 lifecycle record, transcript-ordered |
| `agent/conversation/participants-removed` | data | becomes an in-band L3 lifecycle record, transcript-ordered |
| `agent/message/received` | data | delivery fan-out |
| `agent/dispatch/released` | dies | lease machinery |
| `app/dispatch/lease-consumed` | dies | lease machinery |
| `app/dispatch/lease-expired` | dies | lease machinery |

## Implementation notes (non-normative)

Known deltas between v1's mechanisms and the guarantees above:

- v1's single-row insert is trivially atomic for a lone message, but v1 has no notion of a multi-message transactional unit, so guarantee 1's collective case is net-new; fan-out is best-effort to live sockets with no replay path — the list op exposes no cursor and nothing buffers for offline subscribers (verified empirically; a conformance slot is reserved). Guarantee 4 is net-new.
- v1 sequence numbers are minted process-locally; total order breaks across nodes. Guarantee 2 requires store-owned sequencing.
- v1 membership notifications are a fire-and-forget side channel with no position against message flow; guarantee 5 is net-new.
- v1 attribution is session-trusted with no per-message signing, so guarantee 6's evidentiary strength is bounded by the open L1 key model.
- v1's at-rest envelope encryption keeps all keys server-side; guarantee 7 currently holds by API discipline, not by key custody.

By recorded decision (`docs/decisions/20260722-control-plane-encoding.md`) the wire rides JSON-RPC for now, with REST plus OpenAPI contracts as the target. The interim JSON-RPC wire anchors on v1's descriptor machinery — the `defineRpc` catalogs with schemas, requirement middleware, strict decode, and doc generation (`packages/protocol/src/transport/descriptor.ts`) — rebound from the socket mux to an HTTP protocol. The REST target re-anchors on the HTTP-route surface (`packages/server/src/http/routes.ts → makeCoreHttpApp`) plus the same schema-first patterns, with OpenAPI-generated contracts the CLI consumes directly in place of a separate protocol package. Either way the socket machinery — the two role-inverted engines and method-presence routing (`packages/protocol/src/transport/mux.ts`), reverse callbacks, the app client — has no successor on the control plane; the data plane keeps it only as its interim wire (`docs/decisions/20260722-data-plane-layering.md`).

Per-mechanism carry-forward / redesign / abandon verdicts for v1's machinery — the typed wire catalog, the HTTP registration surface, the session/connection machinery, the message store — live in the salvage analyses (`v2/inputs/v1-code-audit-20260717.md`, `v2/inputs/debt-inventory-20260718.md`); any carry-forward is subject to the v2 workspace boundary (zero imports from `packages/*`).

## Invariants

1. No control-plane behavior depends on message-body content.
2. The plane holds no standing coordination policy and consults no endpoint to decide any op (no callbacks).
3. Every control-plane request is individually authenticated as exactly one caller — a registered identity or the operator; the plane holds no session state between requests.
4. An action is committed for every member or for none; an acknowledgment implies commitment. Ordering delivery against durability is realization.
5. One store-owned total order per conversation; every read and every delivery is consistent with it.
6. Records are immutable once durable.
7. The plane knows exactly two caller classes — identities (agents) and the operator; no other principal is minted, authenticated, or called back. (How L6 monitors obtain their global view over records — as identities, via the operator, or another shape — is open: register, monitor access.)

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

1. Witness semantics: per-message versus conversation-fixed witness sets; what a witness may read back versus a member.
2. Records retention and the history-read scope (including who may read back what).
3. Lifecycle under encryption: if bodies go end-to-end opaque, does join/invite become a heavier lifecycle record (key-material minting)?
4. Presence and delivery-status semantics (collective-semantics charter) — noting that any push-shaped signal, if one exists at all, rides the data plane as messages; the control plane never pushes; v1 has none.
5. Failure taxonomy: what an endpoint sees when the plane refuses an op.
6. Wire discipline: does v2 keep v1's closed-struct/excess-key rejection for control-plane ops? (register)

## References

- `v2/VISION.md` — constitution and open-question register; epic #755.
- `docs/decisions/20260720-the-network-is-a-router.md`, `docs/decisions/20260721-v2-lives-top-level.md` — recorded decisions the reframing rests on.
- `docs/decisions/20260721-physical-plane-split.md`, `docs/decisions/20260721-sessionless-network.md`, `docs/decisions/20260721-single-credential.md`, `docs/decisions/20260722-control-plane-encoding.md` — the wire-binding decisions.
- `docs/architecture/layers.md` — layer model.
- Collective-semantics charter: #765.
- Store-and-replay absence: #247 (verified empirically in PR #187); reconnect/replay conformance deferral: #338.
- v1 catalog source of truth: `packages/protocol/src/socket/catalog/index.ts`; HTTP surface: `packages/server/src/http/routes.ts → makeCoreHttpApp`.
- Salvage evidence: `v2/inputs/debt-inventory-20260718.md`, `v2/inputs/v1-code-audit-20260717.md`.
