---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Representation limits are fixed or derived

Decision provenance: [configuration simplification questions](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#configuration-simplification-and-effect-config) and [exact implementation slate approval](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#exact-implementation-slate-approved).

## Context and Problem Statement

The initial implementation plan exposed separate operator settings for
received request bytes, decoded opaque-body bytes, complete
SignedMessage bytes, and recipient count. Several of those values
describe nested forms of one closed representation. Letting operators
configure every enclosing form independently creates combinations that
can admit a value at one boundary and reject the same conforming value
at the next.

Configuration should express deployment inputs and independent
resource tradeoffs. Protocol acceptance constants and consequences of
closed Schemas should have one owner and one calculation.

## Considered Options

- Expose an independent environment key for every nested byte and count
  boundary.
- Keep one coarse global request-body limit for every route.
- Fix primitive acceptance limits and derive each enclosing exact
  representation maximum.
- Add an application request queue in front of a separate request
  concurrency limit.
- Use one immediate concurrency permit and leave connection backlogs to
  Node, the operating system, and deployment.
- Reject every unknown variable under a MoltZap prefix with a custom
  environment enumerator.
- Let Effect Config read only declared keys and ignore unrelated
  entries.

## Decision Outcome

Chosen: **primitive protocol limits are fixed, enclosing
representation limits are derived, and configuration retains only
independent deployment and resource choices**.

### Binding outcome

The maximum decoded opaque body is 262,144 bytes. A SignedMessage has
at most 128 recipients. Those are fixed acceptance semantics and have
no environment keys. Under the closed identity representation they
derive a maximum complete SignedMessage of 471,671 UTF-8 JCS bytes.
Identity owns that calculation and exposes only
`SignedMessage.maximumEncodedByteLength` and
`SignedMessage.encodedByteLength`.

Router consumes the identity-owned SignedMessage length. It owns its
own exact send, poll, PollCursor, and poll-result calculations. The
derived maximum send request is 471,819 received body octets; the
maximum PollCursor is 348 ASCII characters; the derived maximum
PollCursor request is 422 received body octets; and a one-message
maximum batch is 472,119 UTF-8 JCS bytes. Registry likewise derives a
separate pre-parse body cap for each closed Registry route.

There is no Registry or Router request-queue setting, generic
request-body setting, complete-SignedMessage setting, opaque-body
setting, or recipient-count setting. Request admission uses one
immediate Effect concurrency permit and returns 429 `overloaded` when
no permit is available. Node, operating-system, proxy, and deployment
connection backlogs are not application queues.

Count and byte controls remain distinct only where they protect
independent resource cases, such as many tiny retained messages versus
a few large ones. Total active-request concurrency and held-poll
capacity remain distinct so waiting polls cannot consume every request
permit. The exact retained process configuration and cross-field fit
laws live in the owning identity and Router semantic chapters.

Router configuration must admit one maximum SignedMessage by retained
count and bytes and must fit one maximum message plus one maximum
PollCursor within both poll count and response-byte limits. Arithmetic
is overflow-checked. Tests compare each package's calculator with
actual Effect Schema, JCS, JWS, or JWE encodings only for
representations that package owns.

Router private order is an unsigned 128-bit value. Assigning
`2^128 - 1` succeeds and makes local health unready for fresh appends.
A later verified initial send that would need a greater order returns
429 `overloaded` without mutation. Retained retries and polls continue.
PollCursor rejects a decoded order outside that range.

Effect Config reads only the exact declared keys. It rejects invalid
declared values and invalid cross-field combinations but ignores
unrelated or unused same-prefix variables. No second
prefix-enumeration subsystem is added.

### Guarantee

Every accepted primitive representation fits every mandatory enclosing
representation under valid configuration. An operator cannot create a
contradiction by independently tuning two names for the same bytes.
Finite resource exhaustion remains closed and observable without
leaking private order or implementation causes.

### Mechanism

Identity- and Router-owned size calculators, Effect Schema encoders,
Effect Config refinements, immediate semaphores, bounded state, and
cross-field startup validation realize the outcome.

## Consequences

Operators have fewer knobs, and route caps may change only when their
owning closed representation or fixed primitive limit changes. Such a
change updates the MoltZap version and normative representation
contract rather than deployment configuration. Tests target exact
maxima and one-unit overflow at each owning boundary.
