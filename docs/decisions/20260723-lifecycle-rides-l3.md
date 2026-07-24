---
status: accepted
date: 2026-07-23
decision-makers: Tapan Chugh
---

# Conversation lifecycle rides in-band at L3

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
  transcript's own entries create and reshape the conversation.

## Decision Outcome

Chosen: **lifecycle rides in-band at L3**, with authority above it.
A conversation begins as its transcript's genesis entry — a
CONVERSATION-START frame addressed to a fresh, client-minted
conversation id (collision-free by size), whose admission creates
the transcript with that frame as entry zero. Membership changes,
departures, and any acceptance are subsequent in-band entries, as
membership ordering already required. There is no control-plane
create op; the conversation registry becomes an index the store
derives from lifecycle entries, and the control plane keeps only
reads (a member lists its conversations; members read transcripts).

Admission of a genesis entry checks attribution and id freshness —
nothing else. Authority is not the plane's: which creations and
invitations are legitimate is a task norm (L4), published upward
and screened by each invitee's gate (L5), exactly as contact
formation is. The mechanics/authority/screening split matches the
rest of the stack.

Escrow: an initiated conversation may be half-open — durable
genesis, invitees yet to speak — and half-open state is
per-conversation coordination state, expiring by bounded timeout
per the sessionless decision; an acceptance, where a norm wants
one, is the invitee's own in-band entry. Escrow semantics,
acceptance quorums, and what ARCHIVE means to non-archivers are
the collective-semantics charter's (#765, cluster 9 — direction
now recorded).

v0 implements genesis entries directly — no interim control-plane
create op is built (option b): v1's creation surface was
app-authored and dies regardless, so there is no baseline worth
migrating. v0's lifecycle entry types are START, member-add, and
leave; escrow and archive ship with the charter.

Consequences: five dissolution verdicts flip from control to data
(the lifecycle notifications were already "in-band,
transcript-ordered"); the control plane's op surface shrinks to
identity ops and reads; conversation ids are client-minted;
first-conversation bootstrap needs no provisioning.
