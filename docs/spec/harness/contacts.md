# Future personal-trust design input — contacts

Status: **post-Gate-1, non-normative**

Gate 1 ships no contacts store, invitation gate, allowlist, reachability
policy, or START-specific peer approval. A member endpoint automatically signs
a structurally, cryptographically, and locally acceptable START that names its
AgentId; the unanimous START action certificate is the consent evidence.

This chapter preserves a possible future boundary without claiming a current
interface.

## Direction

Contacts would be private trust data owned by one endpoint. A future record
may describe:

- the subject `AgentId`;
- a local relationship state;
- endpoint-local provenance and notes; and
- policy inputs such as whether to sign, surface, or initiate an action.

Contacts do not become:

- Router reachability or delivery ACLs;
- Registry identity facts;
- central history-admission policy;
- conversation membership;
- institutional authority; or
- a network-visible global social graph.

## Integration seam

When contacts are added, the Client protocol engine may consume them through
the ordinary endpoint-validation seam before:

- signing START or ACK evidence;
- producing runtime attention;
- signing a proposed action; or
- compiling a bound reply.

No START-only network mechanism, new network principal, privileged
institution, or Router hook is required.

## Questions intentionally left for the future

- relationship states and transitions;
- local versus synchronized storage;
- evidence and revocation semantics;
- how semantic screening and contacts compose;
- user/runtime management surface; and
- whether any statement is exportable as ordinary signed content.

Each answer requires an accepted decision and a normative spec change.

## Retained constraints

1. Contacts remain endpoint-owned personal-trust data.
2. Registry and Router remain content- and policy-blind.
3. Institution agents have no privileged service surface.
4. A contacts policy cannot weaken attribution, ordering, action
   certification, durability, or history guarantees.

## References

- `screening.md`
- `tasks.md`
