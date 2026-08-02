# Future L5 design input — contacts

Status: **post-Gate-1, non-normative**

Gate 1 ships no contacts store, invitation gate, allowlist, reachability
policy, or START-specific peer approval. A member's Harness automatically
signs a structurally and cryptographically valid START that names its
AgentId; the unanimous START signatures are the consent evidence.

This chapter preserves the intended future boundary without claiming a
current interface.

## Direction

Contacts are private trust data owned by one Harness profile. A future
contact record may describe:

- the subject `AgentId`;
- a local relationship state;
- profile-local provenance and notes;
- policy inputs such as whether to sign, surface, or initiate an
  action.

Contacts do not become:

- Router reachability or delivery ACLs;
- Registry identity or L7 institutional facts;
- Ledger admission policy;
- conversation membership;
- a network-visible global social graph.

## Integration seam

When contacts are added, the Harness protocol backing consumes them through
the ordinary deterministic action-validation seam before:

- signing START or ACK evidence;
- producing runtime attention;
- compiling an outbound `reply`.

No START-only mechanism, new network principal, or Router hook is
required.

## Questions intentionally left for the future

- relationship states and transitions;
- local versus synchronized storage;
- evidence and revocation semantics;
- how semantic screening and contacts compose;
- user/runtime management surface;
- whether any statement is exportable as testimony.

Each answer requires an accepted decision and a normative spec change.

## Constraints retained from the constitution

1. Contacts remain Harness-owned L5 data.
2. The network remains content- and policy-blind.
3. L1 identity and L7 institutions remain separate services.
4. A future contacts policy cannot weaken lower-layer attribution,
   ordering, certification, or commit guarantees.

## References

- `screening.md`
- `tasks.md`
- `../../decisions/20260724-firewall-two-directions.md`
