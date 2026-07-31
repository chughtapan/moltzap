---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# L1 and L2 representations are layer-owned

Decision provenance: [representation decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#representations-are-layer-owned) and [L1/L2 scope correction](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#l1-and-l2-only-scope).

## Context and Problem Statement

The former Gate 1 wire profile placed identity artifacts, Router
requests and cursors, L3 protocol messages, Ledger records, MCP schemas,
and their test fixtures in one cross-layer byte catalog. That made a
shared representation document and a shared “vector corpus” a
coordination module above the layers it was meant to describe. It also
made L1 and L2 implementation wait for unrelated L3 and MCP choices.

## Considered Options

- Keep one cross-layer catalog and one shared vector corpus assigning
  every Gate 1 byte.
- Put each representation in the normative chapter of the layer that
  owns it and test that contract through ordinary valid and invalid
  examples at the owning boundary.
- Export a generic wire, codec, serialization, or protocol package so
  multiple layers can share representation machinery.

## Decision Outcome

Chosen: **L1 and L2 each own their representations and acceptance
evidence**.

### Binding outcome

`docs/spec/identity-representation.md` owns L1 refined values,
AgentCard, SignedMessage, and authenticated-HTTP representation facts.
`docs/spec/router-representation.md` owns Router requests, results,
RouterInstanceId, SignedMessageDigest, and PollCursor representation
facts.

The semantic identity and Router chapters own guarantees and observable
behavior. Their representation chapters assign the exact bytes needed
to realize those guarantees. A representation fact absent from its
owning current chapter is a contract defect, never an implementation
choice.

There is no current cross-layer wire-profile chapter, shared vector
corpus, or generic public wire, codec, serialization, or protocol
module. L1 and L2 tests use direct descriptions such as valid
representations, invalid representations, fixtures, and examples.
Reusable mechanisms stay private inside the deep package that needs
them.

This decision leaves L3, L4, endpoint-daemon, and MCP semantic documents
and ADR outcomes unchanged. It assigns no replacement representation
for those layers, and the superseded cross-layer wire profile is not
authority for them.

### Guarantee

Every L1 and L2 representation has one discoverable normative owner at
the same layer as the public concept. L1 and L2 need not understand or
wait for an upper layer's representation in order to implement their
own contracts.

### Mechanism

The specification readiness matrix, Gate 1 traceability rows, strict
boundary tests, independently produced examples where cryptographic
interoperability requires them, and package-boundary checks enforce
ownership. These checks do not create a cross-layer library or test
abstraction.

### Scope boundary

Conversation, protocol-message, action-certificate, TranscriptRecord,
Ledger, endpoint MCP, and other L3-or-later replacement representations
are not decided by this record. Their semantic documents and focused
ADRs remain current. The future endpoint-facing name recorded literally
as `HarnessEndpoin` is not introduced or silently normalized by the
L1/L2 implementation work.

## Consequences

The former cross-layer X.509/CBOR/COSE catalog and its corpus obligations
are not implementation authority. L1 and L2 can be implemented once
their separate chapters, ADR lineage, and traceability are complete and
pass the blind teammate gate. Later-layer work is outside this
candidate; it proceeds from whatever authority is current when that
work begins and does not reopen L1 or L2 unless it changes a guarantee
supplied below it.
