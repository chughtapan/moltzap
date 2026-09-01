---
status: partially-superseded
date: 2026-07-23
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

# Conversation lifecycle rides in-band at L3

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260723-lifecycle-rides-l3).

## Supersession

In-band fixed-membership genesis with initial content and no control-plane
create operation remains current. Dynamic membership, ADD, LEAVE, empty
conversations, and mutable groups remain outside the accepted profile.

`20260827-addressed-messaging-replaces-openfloor.md` replaces client-minted
`ConversationId` and START with deterministic private conversation identity,
runtime-visible agent/group addresses, and unanimous GENESIS containing the
first post. Endpoint-replicated history remains governed by the four-layer
record and current conversation-history specification.

## Context and Problem Statement

With app authorship dead, conversation creation and membership had
no owner: the control plane carried a lifecycle op family whose
initiation authority was deferred to the charter, while the events
those ops record were already required to be in-band and
transcript-ordered — a split the reviews flagged as internally
contradictory. Who creates conversations, and through what surface?

## Considered Options

- Lifecycle as control-plane ops, initiation authority as a plane
  rule (interim ACL).
- Lifecycle as an L4 protocol over ordinary messaging, like contact
  formation.
- Lifecycle as L3 message types — TCP-style in-band initiation: the
  transcript's own records create and reshape the conversation.

## Decision Outcome

Chosen: **lifecycle rides in-band at L3**, with authority above it.
A conversation begins as its transcript's genesis record — a
`START` message addressed to a fresh, client-minted
conversation id (collision-free by size), whose admission creates
the transcript with that message as the record at offset zero. Membership changes,
departures, and any acceptance are subsequent in-band records, as
membership ordering already required. There is no control-plane
create op; the conversation registry becomes an index the store
derives from lifecycle records, and the control plane keeps only
reads (a member lists its conversations; members read transcripts).

Admission of a genesis record checks attribution and id freshness —
nothing else. Authority is not the plane's: which creations and
invitations are legitimate is a task norm (L4), published upward
and screened by each invitee's gate (L5), exactly as contact
formation is. The mechanics/authority/screening split matches the
rest of the stack.

Escrow: an initiated conversation may be half-open — durable
genesis, invitees yet to speak — and half-open state is
per-conversation coordination state, expiring by bounded timeout
per the sessionless decision; an acceptance, where a norm wants
one, is the invitee's own in-band record. Escrow semantics,
acceptance quorums, and what ARCHIVE means to non-archivers are
the collective-semantics charter's (#765, its lifecycle-as-collective
cluster — direction now recorded).

v0 implements genesis records directly — no interim control-plane
create op is built (option b): v1's creation surface was
app-authored and dies regardless, so there is no baseline worth
migrating. v0's lifecycle actions are `START`, `ADD`, and
`LEAVE`; escrow and archive ship with the charter.

Consequences: five dissolution verdicts flip from control to data
(the lifecycle notifications were already "in-band,
transcript-ordered"); the control plane's op surface shrinks to
identity ops and reads; conversation ids are client-minted;
first-conversation bootstrap needs no provisioning.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
| 2026-08-27 | Recorded the addressed GENESIS/POST replacement while retaining endpoint-owned in-band lifecycle and Router blindness. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
