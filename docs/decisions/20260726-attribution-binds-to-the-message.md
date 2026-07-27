---
status: accepted
date: 2026-07-26
decision-makers: Tapan Chugh
---

# Attribution binds to the message, not to the request

## Context and Problem Statement

The interim binding made attribution a property of the request that
carried a message: an RFC 9421 signature over `@method`,
`@target-uri`, a header, and a body digest
(`20260723-interim-signature-profile.md`). That inverts the stack's
own dependency rule. L2 is supposed to depend on L1 — it delivers
messages L1 has already attributed — but under request-signing L1's
guarantee depends on L2's carriage shape, so a transport choice
decided what evidence survived in the record. The symptom was a
carriage question that could not be answered on carriage grounds: a
socket frame has no method or target URI, so signing a send over the
interim WebSocket required synthesizing components that never existed
on the wire, leaving retained evidence only this project's own
conventions could verify.

## Considered Options

- Keep request-signing and pick a carriage that suits it — either
  synthesize the missing components on the socket, or move member
  writes to real HTTP requests.
- Sign the message itself, and let the carriage stop mattering.

## Decision Outcome

Chosen: **attribution binds to the message.** A message carries its own
signature, verifiable from the message and the sender's card alone.
L1 is self-contained; L2 may carry messages however it likes.

- **The canonicalization objection does not apply.** Signing
  structured data requires two implementations to agree on key order
  and number formats; that was the reason to reach for a standard
  HTTP-signing profile. But a message is already one opaque byte
  string, byte-exact at every hop (`identity.md` → Byte preservation;
  law L1.5), so the signature is Ed25519 over those bytes, covering
  the envelope and body together with the signature carried alongside
  the signed part. Simpler than the interim profile, not harder.
- **The carriage question closes rather than resolves.** Whether a
  member's write rides a socket frame, an HTTP request, or a later
  transport changes nothing about attribution or evidence. The target
  wire stays open (`data-plane.md` Q10) and now binds nothing at L1.
- **Retired with it:** the request-signature profile's covered
  components and freshness window, the requirement that the store
  retain request material beside each record, the `nonce` addendum
  that existed to keep hash-dedupe from collapsing identical request
  bytes, and the concession that recipients inherit the router's
  admission-time verification. Each existed only to prop up the
  inverted dependency. The store still retains the sender's card, for
  the reason that has nothing to do with the binding: a record must
  stay verifiable after the registry stops vouching.
- **Restored:** the acceptance criterion the corpus had been hedging —
  a recipient verifies the sender from the message and the card alone,
  with no trust in the router — holds in the first implementation
  rather than being promised for later. Recipients and L6 readers run
  one verification path, and there is no interim-to-target migration
  to schedule.

Register item 5 keeps what it was actually about: rotation and
revocation, the key model proper. How a signature binds to a message
is answered here.

Supersedes `20260723-interim-signature-profile.md` on the binding and
its covered components; the profile's algorithm choice (Ed25519) and
keyid convention (`moltzap://agent/<id>`) stand. The operator key it
also carried forward is retired separately by
`20260727-registration-is-out-of-band.md`.
