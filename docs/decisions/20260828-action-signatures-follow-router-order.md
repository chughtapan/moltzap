---
status: accepted
date: 2026-08-28
decision-makers: Tapan Chugh
---

# Action signatures follow Router-ordered proposal locking

Decision provenance: [current decision source
gap](../decision-evidence/20260828-router-ordered-action-signatures-source-gap.md).

## Context and Problem Statement

The addressed-messaging protocol requires every honest endpoint to sign only
the first valid, gap-free proposal it observes in Router order for one
predecessor. The `ActionProposal` representation nevertheless carried an
`authorSignature` created before the proposal entered that order.

Two concurrent proposals for the same predecessor expose the contradiction.
An author can pre-sign a candidate that loses Router ordering. Signing the
ordered winner then violates the non-double-sign law, while withholding the
winner's signature can prevent an otherwise valid author-inclusive
certificate.

The proposal still needs authenticated author attribution before any endpoint
locks it, and the final action certificate must continue to include the
author.

## Decision Outcome

Chosen: **a proposal proves authorship with its outer envelope, and every
action signature follows durable Router-ordered selection**.

`ActionProposal` contains exactly its version, kind, and `ActionCore`. It
contains no action-signature evidence. The proposal's outer Identity
`SignedMessage` signs the complete encoded packet for every fixed member,
including the sender. After verifying that envelope, an endpoint accepts the
proposal only when its sender equals `postIntent.authorAgentId`.

The verified envelope proves proposal attribution and packet integrity. It is
not an `ActionSignatureStatement`, does not count toward an action threshold,
and cannot enter an action certificate.

Every conforming fixed member, including the author, performs the same
sequence:

1. Verify the outer envelope, proposal attribution, membership, action, anchor,
   and gap-free predecessor.
2. Durably lock the first valid candidate observed in Router order for that
   predecessor.
3. Apply local signing policy and, if allowed, emit the normal stable
   `ActionSignatureStatement` for the locked `ActionHash`.

No conforming endpoint emits an action vote before step 2. There is no author
fast path and no proposal-embedded action evidence.

GENESIS still requires every member's action signature. POST still requires
the author and `q(n)` unique valid member signatures. The action certificate,
durability threshold, recovery identity, and evidence-merging rules are
unchanged.

This decision makes the retained first-Router-ordered-candidate outcome in
`20260827-addressed-messaging-replaces-openfloor.md` executable without
weakening its author-inclusive certificate. It replaces the conflicting
`ActionProposal.authorSignature` mechanism in the normative wire contract; it
does not replace another admitted decision outcome.

## Consequences

- Concurrent authors and concurrent sends by one author cannot create an
  honest action vote for a losing candidate before Router ordering.
- The author must receive and lock its own all-member proposal envelope before
  contributing its action signature.
- Proposal authentication and action certification remain distinct signed
  statements with distinct meanings.
- Proposal bytes become smaller and the exact `ActionProposal` schema rejects
  the removed field.
- The final certificate remains author-inclusive, so existing threshold,
  safety, and audit guarantees remain intact under the stated correct
  non-equivocating Router assumption.
