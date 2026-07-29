# Future L6/L7 — oversight and institutions

Status: **post-Gate-1, non-normative except separation laws**

## Boundary

L6 social oversight and L7 institutional trust are higher-layer
services and protocols. Gate 1 deploys neither.

The separation from L1 is binding:

- the Identity Registry publishes AgentCards and cryptographic identity
  facts only;
- each future institution is a separate service and trust domain;
- an institution issues its own versioned, signed, institution-scoped
  statements keyed by `AgentId`;
- no DirectoryEntry combines identity and institutional facts;
- Router and Ledger never query or evaluate institutions.

An endpoint later composes L1 identity with statements from whichever
institutions its local norms and personal-trust configuration
recognize.

## Network admission

Network services perform L1 and mechanical protocol checks only:

- identity and key validity;
- exact schema, version, COSE, and request authentication;
- technical conversation, epoch, Router-instance, and base bindings;
- exact Gate 1 certificate signer set and signatures.

Institutional standing never becomes Router or Ledger admission.
Operational quotas and abuse controls protect resources without
pretending to be social policy.

## L6 monitoring direction

A deterministic monitor is a contract over committed Transcript
records. Given the same self-contained records and monitor version, it
produces the same result.

Judgment that cannot be deterministic is testimony attributed to its
speaker, not hidden inside a monitor or Ledger verdict. Monitoring does
not mutate history or turn an invalid attempt into a committed record.

## L7 institution direction

A future institution statement must be:

- signed by that institution;
- versioned and scoped to the issuing institution;
- keyed to canonical AgentId;
- independently revocable or supersedable by that institution;
- consumed by endpoints under an explicit norm.

It does not rotate L1 keys, edit AgentCards, set a Registry `active`
bit, or globally reconfigure identity. L1 recovery and L7 consequences
remain distinct protocols.

## Gate 1 behavior

- no L7 service or statement schema is shipped;
- no institution is configured or queried;
- no monitor result changes action certification;
- no revocation or institutional-status claim is inferred from
  Registry lookup;
- no endpoint claims semantic L6/L7 conformance.

## Future questions

- institution discovery and trust roots;
- statement vocabulary and revocation;
- norm selection and conflicts among institutions;
- monitor publication and testimony;
- consequences, appeals, and governance;
- privacy and selective disclosure.

These remain questions until separately accepted. They cannot be
answered by extending AgentCard or Ledger rows.

## Separation acceptance criteria

- Registry schemas contain no institution, active, sanction, or policy
  field.
- Router/Ledger dependency graphs contain no institution client.
- A future institution outage cannot prevent L1 verification or
  mechanical reading of committed records.
- The same AgentId may be described differently by independent
  institutions without changing its AgentCard.

## Decisions

- `../decisions/20260724-monitors-are-deterministic-contracts.md`
- `../decisions/20260724-l7-is-policy-attached-to-identity.md`
- `../decisions/20260728-layer-boundaries-and-fault-model.md`
