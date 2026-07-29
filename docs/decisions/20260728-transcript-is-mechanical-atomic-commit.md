---
status: accepted
date: 2026-07-28
decision-makers: Tapan Chugh
---

# Ledger performs mechanical atomic Transcript commit

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-transcript-is-mechanical-atomic-commit).

## Context and Problem Statement

Prior designs alternately made the Ledger enforce grants and allowed it
to append semantically invalid actions as ineffective records. Both
models put endpoint policy into storage and blur what an acknowledgement
proves.

## Decision Outcome

Chosen: **endpoints certify actions; Ledger validates the exact
certificate profile and commits one canonical record mechanically**.

In one ACID transaction, Ledger reserves the conversation/epoch/TxnId
idempotency key, validates the current base offset and hash, assigns the
next dense offset, advances the hash chain, and makes one canonical
TranscriptRecord readable to every fixed member. It acknowledges only
after commit and stores no per-recipient record copy or delivery row.

Ledger admits only author-submitted START or MULTICAST certificates
whose closed action and COSE bindings are canonical, whose epoch and
Router instance match the transcript, and whose signer set is exactly
the fixed epoch-0 membership with one valid signature per embedded
card. Those are mechanical properties of the Gate 1 certificate
format. Ledger does not evaluate BEGIN order, grants, task quorum
policy, norm legality, content meaning, or result correctness.

Each record is independently verifiable and embeds its complete
verification evidence. Future physical compression is allowed only if
reads reconstruct the identical logical record, hash, and signature
preimage without a live Registry.

Only the action author may append. If the author fails after collecting
signatures, the action may remain uncommitted. An ambiguous result is
resolved by retrying the identical certificate or reading the exact
transaction; takeover and dispute protocols are deferred.

## Consequences

An acknowledgement proves durable, all-member logical visibility.
Invalid attempts rejected by any honest required endpoint never reach
Ledger. Unanimously malicious certification remains outside the Gate 1
validity guarantee.
