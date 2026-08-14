---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# Gate 1 uses OpenFloorV1 with fixed membership and unanimity

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-open-floor-v1).

## Supersession

OpenFloorV1 remains the accepted fixed-membership action protocol: START and
MULTICAST action validity require every fixed member's signature, BEGIN/ACK
contention and the 90-second volatile-attempt TTL remain task semantics, and no
non-unanimous action-certificate rule is introduced. A durability threshold is
not an action-validity threshold.

`20260811-four-layer-endpoint-replicated-harness.md` replaces the committed
Ledger head, author-only append, central receipt, and Ledger availability
dependency with certified endpoint heads, endpoint durability votes,
any-member evidence assembly, and member catch-up. The current action protocol
remains here and in `docs/spec/harness/tasks.md`; the replacement record and
`docs/spec/conversation-history.md` own how a unanimous action becomes durable
history.

## Context and Problem Statement

Gate 1 needs one complete conversation protocol without prematurely
shipping dynamic membership, a user-provided norm runtime, configurable
quorums, fairness machinery, or durable partial attempts.

## Decision Outcome

Chosen: **START plus MULTICAST under a built-in protocol-versioned
OpenFloorV1 norm**.

`start_conversation` names the other members by immutable AgentName,
includes the initial content, and produces one epoch-0 START. The daemon
adds self, resolves and canonicalizes AgentIds, and rejects unknown,
duplicate, or explicit-self entries. Each named endpoint automatically
signs a structurally and cryptographically valid START containing it.
START has no invitation store, BEGIN, or ACK round; the unanimous START
signatures are its consent evidence.

After START, every fixed member is eligible. When no transaction is
open, any eligible member may emit BEGIN. The first valid BEGIN in
shared L2 order after the committed Ledger head wins. Every fixed
member may ACK the candidate; unanimous ACK evidence creates a volatile
reply grant for its author. After the author supplies content, it sends
the exact proposed action to every member. Each member independently
validates and signs that final action binding, and the author may append
only after collecting exactly one action signature from every member.
An ACK and a final action signature are distinct evidence.

Every live transaction has one protocol-fixed 90-second
local-observation TTL. Expiry abandons the volatile attempt and permits
a fresh BEGIN without changing committed records. There is no explicit
pass, abort, renewal, takeover, dispute, or recovery protocol. Safety
is timing-independent; timely progress requires Router, Ledger, and
every member to remain available and responsive within the TTL. Gate 1
makes no fairness claim.

The action content is a nonempty array whose elements are exactly one
closed-union arm, `{text: string}` or `{data: JsonValue}`. Raw bytes,
files, media, metadata, and addressed-turn semantics are deferred.

## Consequences

OpenFloorV1 exercises the generic endpoint protocol engine without
putting task policy into Router or Ledger. A withholding member may
halt progress. New norms, dynamic membership, and non-unanimous quorums
require later accepted protocol contracts.
