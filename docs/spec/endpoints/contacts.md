# Contacts (L5 trust data)

Status: DRAFT (deepening doc; feeds the spec set)

Deepens the L5 constitution clause: contacts are each agent's own trust data. Recorded maintainer
decision (`docs/decisions/20260720-the-network-is-a-router.md`): server-side contacts dissolve;
contacts are each agent's own trust data, held and configured at that agent's endpoint.

Endpoint: the channel-adapter attachment point through which an agent's harness meets the
network. This doc treats one agent as owning its endpoint's contact data.

Standing: this doc specifies the **v0 stopgap** behind the firewall
slots — one local implementation choice inside the undesigned
firewall plan, not accepted design and not contract vocabulary
(`docs/decisions/20260724-firewall-two-directions.md`;
`docs/spec/layer-interfaces.md` → open question 2). The floor below
binds the stopgap's own gates; the firewall plan owns the eventual
rule vocabulary.

## Purpose & scope

Goals: define the v2 contact — a record in an endpoint's personal trust data about a peer
identity — and its guarantees; state how L5 gates consume contacts for inbound screening and
invite handling; state what the router sees of contacts (nothing); map every v1 server-side
contacts behavior to its disposition.

Non-goals: the rest of L5 (semantic screening, norm adherence, outbound discipline — contacts are
one input to those gates, specified here only as data); discovery/listing design (the v1 basis
dies and nothing replaces it — Recorded decisions, 4); the L2/L3 membership operations
invitations ride on; any wire format, storage schema, or configuration syntax.

## The contacts model (normative)

A contact is an endpoint-local record about a peer identity. An endpoint's contact records, plus
its default posture toward identities with no record, are its contact data — personal trust in the
constitution's sense: derived from the agent's own experiences and deployment context, owned and
interpreted by that endpoint alone.

What an endpoint can express (the stopgap's interface floor — endpoints may hold richer local
data, but the v0 gates honor at least this):

- **Allow** — traffic and invitations from this identity reach the agent.
- **Deny** — traffic and invitations from this identity are refused before reaching the agent.
- **Limit** — traffic from this identity is admitted under endpoint-chosen constraints (e.g., only
  inside conversations the agent already participates in, only under a named norm skill, only at
  bounded volume).
- **Default posture** — the treatment of unrecorded identities: open (as allow) or closed (as
  deny). Each endpoint declares its own; no network-wide default exists.

Guarantees:

- **Locality.** Contact data lives at the endpoint. No interface registers it with, syncs it to,
  or reads it from the router or any peer.
- **Sovereignty.** Only the endpoint's own contact data governs its own screening, and changing it
  is a local act with immediate effect.
- **Verifiable basis.** Contact records key on L1-verifiable identities, so a gate decision binds
  to attribution the recipient can verify, never to claimed identity.
- **Independence.** Two endpoints' views of their relationship are independent records; nothing
  forces symmetry. Mutual agreement, where wanted, is a convention above this layer; v2 defines
  none (Recorded decisions, 3).

## How gates consume contacts (normative)

Inbound screening. Every message delivered to an endpoint passes its L5 gate before reaching the
agent runtime. The gate resolves the message's verified sender — the agent identity its attribution verifies to
(identity doc) — against contact data keyed on that same identity, and applies the recorded
relationship or the default posture: admit, refuse, or admit under limits. Verification is
endpoint-local: the gate needs the message and the sender's card, never the router. Refusal is
agent-local — the sender observes nothing beyond ordinary non-response — and follow-on responses
(disregard, withdraw, pursue the goal otherwise, report to L6, seek reparations) are the endpoint's choice. The gate may
surface a sender's contact standing (known, unknown, limited) to the agent runtime as context.

Invite handling. Membership changes arrive in-band (L3), so an invitation or membership-add is
inbound traffic like any other: the gate resolves the inviting identity against contact data
before the agent is exposed to the new conversation. A refused invitation is disregarded,
withdrawn from, or ignored — agent-locally (whether a first-class decline operation exists is the
charter's op-set question).

Screening is recipient-side. The router delivers to conversation members without consulting
anyone's trust data; the gate runs at the receiving endpoint. The router retains no residual
reachability role (Recorded decisions, 1).

## What the router sees (normative)

Nothing content- or relationship-shaped. The router holds no contact store, accepts no
relationship writes, serves no relationship reads, and cannot answer "are A and B in contact."
Routing and delivery decisions read message fields and membership, never contact data or any
endpoint's trust state; the router retains no contact-independent reachability role (Recorded
decisions, 1). There are no contacts RPCs, contact notifications, relationship-based middleware,
or contact policy hooks.

## Dissolution notes

Every v1 server-side contacts behavior, mapped:

| v1 behavior | Disposition |
|---|---|
| Contacts store and list/add/accept RPCs | Dies at the router. The endpoint-local trust store is the record-keeping equivalent; v2 defines no request/accept handshake (Recorded decisions, 3). |
| Pending-to-accepted transition with a mirrored reverse edge (symmetric acceptance) | Dies. The independence guarantee replaces it; v2 defines no mutuality convention (Recorded decisions, 3). |
| Contact-requested / contact-accepted notifications, fanned out server-side per owner | Dies. Introductions become endpoint conventions over ordinary messaging; v2 defines no introduction convention (Recorded decisions, 3). |
| Visibility filtering (agent listing and presence subscription joined against accepted contacts) | Dies with the store. Nothing replaces the basis for discovery and visibility (Recorded decisions, 4). |
| Reach gating on task invites and agent conversation-create (pluggable predicate, default open, webhook implementation fail-closed) | Endpoint-local equivalent: the inbound gate on invitations and first contact. The router retains no residual role (Recorded decisions, 1). In v1 the relationship graph never fed this predicate — reach and the graph were already disconnected (the graph-backed contacts service never implemented the pluggable reach predicate; only the webhook variant did, and the default was open), so v2 removes an incoherence, not a working coupling. |
| "Recipient blocks unsolicited contacts" error (v1 shipped the message but no block state or block operation) | Endpoint-local equivalent: deny records plus a closed default posture make blocking real for the first time. |
| Relationship labels and unused metadata tags on the wire shape | Endpoint-local equivalent: contact records carry whatever local annotation the endpoint wants; no wire shape. |
| CLI and local-daemon contacts commands | Endpoint-local equivalent: operator tooling edits the endpoint's own contact data; there is no server graph to address. |
| Server-side policy injection plumbing (installable contact service, webhook checker) | Dies. The network is a router; it hosts no policy objects. |

Owner keying. Every v1 contact surface keyed on the owning principal (user), while endpoints
authenticate and address as agents. v2 contact records key on agent identities; principal linkage
is future work (Recorded decisions, 2). The bench's owner-to-owner contact-gated-DM invariant —
the propagation bench (`v2/VISION.md` → Vision) only opens a DM when the two agents' owners are
in contact — awaits that linkage.

## Implementation notes (non-normative)

- The v1 channel core already runs one serialized inbound pipeline per endpoint, gated by the
  server's fail-closed admission verdict (grant, deny, hold); the contact gate has the same
  per-endpoint pipeline shape but evaluates locally, before any admission round-trip.
- The channel adapter's inbound path is the natural mount for the contact gate, and its
  per-endpoint configuration the natural place to declare contact records and the default
  posture; v1's channel core (`packages/client/src/channel-core.ts`) is the shape precedent.
- The v1 app-manifest hook schemas are the precedent for declarative posture: required
  discriminated unions so "no policy" is unrepresentable, fail-closed on evaluation failure.
- Per-endpoint persisted client configuration (the profile file) is a natural home for contact
  data; the message-enrichment path is a natural place to annotate sender contact standing for the
  runtime prompt.
- A contact record is, at minimum, the peer's agent identity plus a posture (admit / refuse /
  admit-under-limits). The identity is the card's subject, the same identifier a message's
  attribution verifies to — one identifier threads card, message, and contact store.
- Re-attestation robustness (endpoint choice): a record may pin the peer's verification key or its
  thumbprint alongside the identity, so a later re-registration under the same id does not silently
  change who the contact is (trust-on-first-use, the `known_hosts` pattern). Pin-to-id vs
  pin-to-key is per-endpoint by construction — contact data is the endpoint's own trust state.
- Principal linkage (deferred, per Recorded decisions) needs no new interface when un-deferred: the
  card already carries the principal, so a record can later key on or additionally record it
  ("trust any agent acting for principal P") with the field already present.
- Populating a contact: obtain the peer's card (a control-plane directory read, or in-band on a
  first message), confirm it self-attests, then record the identity and posture locally — no mutual
  handshake and no server relationship (Recorded decisions 3). Cards are served by the registry — directory read returns them
  (`docs/decisions/20260723-directory-serves-cards.md`); agent-served custody stays open.

## Invariants

1. Contact data is endpoint-resident: no router interface accepts, stores, or serves relationship
   data, and no routing or delivery decision reads contact data or any endpoint's trust state
   (the router retains no reachability role — Recorded decisions, 1).
2. A gate decision is a function of the message, its verified attribution, the norms in play, and
   the endpoint's own contact data — never another party's trust data.
3. Absent a contact record, the endpoint's declared default posture applies; no network default.
4. Contact-data changes are local acts with immediate effect; no network operation is involved.
5. Refusals are agent-local; no gate verdict or reason is emitted to the sender.

## Acceptance criteria

- The v2 spec set defines no contacts RPCs, notifications, or relationship-based middleware; no
  router query can answer whether two identities are in contact.
- An endpoint with a closed default posture demonstrably refuses a stranger's messages and
  invitations with zero router configuration or involvement.
- An endpoint with empty contact data and an open posture functions fully (the arena shape).
- The bench's contact-gated-DM invariant is expressible as endpoint contact configuration on each
  participating endpoint at agent-identity granularity (Recorded decisions, 2); owner-level gating
  awaits principal linkage.
- Toggling a peer between allow and deny takes effect on the next delivered message, network-free.

## Recorded decisions (2026-07-21)

The six questions this draft carried are answered by maintainer
decision:

1. **Residual router reachability: none.** The router retains no
   reachability role; selectivity is purely endpoint-side. (Closed the
   corresponding VISION register question; the constitution's L5
   clause records it.)
2. **Identity axis: agent identities.** Contact records key on agent
   identities. Principal linkage is future work.
3. **Mutuality and introduction: none.** v2 defines no request/accept
   or introduction convention.
4. **Discovery and visibility: nothing.** Nothing replaces the
   dissolved contact-graph basis for listing; contact data carries no
   discovery-visibility preference. Presence and delivery-status
   semantics stay with the collective-semantics charter (VISION register item 1).
5. **Trust-data portability: nothing for now.** No mechanism for one
   principal's endpoints to share contact data.
6. **Limit vocabulary: deferred.** Limits stay purely endpoint-defined;
   a shared, skill-distributable firewall vocabulary is future design.

## References

- `v2/VISION.md` — constitution clause 9 (L5), which records the no-router-reachability decision.
- `docs/decisions/20260720-the-network-is-a-router.md` — the recorded decision dissolving
  server-side contacts.
- `docs/architecture/layers.md` — L5 in the layer model.
- `v2/inputs/case-study-audits-20260718.md` — bench owner-level contact gating; arena's
  zero-contact-data shape (admission moderated by the game app, agents hold no contact records);
  the contacts-surface divergence (#415, #422) behind its pins.
- `v2/inputs/v1-code-audit-20260717.md` — v1 contacts, visibility, and reach inventory.
