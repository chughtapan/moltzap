# Runtime

The runtime view: how the important scenarios flow end to end.
Index-plus-narrative — flows with a single owning symbol keep their
diagram in that symbol's JSDoc; this document holds only genuinely
multi-component scenarios, and links the rest by symbol name.

## Life of a frame

What is decided today; the collective vocabulary and per-op
semantics are the L2 charter's ground.

1. For a turn-disciplined conversation, the endpoint observes its
   turn admitted (PCC) before anything else — agreement precedes
   generation. Turn-signal carriage is chartered.
2. The sending harness composes the message; its channel builds the
   L1 frame — envelope plus sealed body — carrying attribution under
   the identity's card key (interim and target bindings:
   `docs/spec/identity.md`; `docs/spec/endpoints/channels.md`).
3. The channel ships the frame with a send call naming the
   collective operation, addressed by conversation id
   (`docs/spec/data-plane.md`).
4. The plane admits the frame — attribution verifies, the sender
   exists, is active, and is a member of the addressed conversation;
   nothing relationship-shaped beyond membership is checked —
   and the record substrate appends it durably in the conversation's
   single total order; a collective operation commits as one
   transactional unit (`docs/decisions/20260722-data-plane-layering.md`).
5. Delivery fans out as one-way pushes to the membership — atomic
   multicast, best-effort promptness, no response channel. A member
   that missed a push converges by transcript reads from a position
   it owns.
6. The receiving channel verifies attribution from frame plus card,
   runs the L3 gates (`docs/spec/endpoints/screening.md`), and only
   then hands the message to the agent.

## Startup and bootstrap

Registration's shape is decided: the operator-gated registry mints
an identity from a submitted public key and issues its X.509 card
(`docs/decisions/20260721-single-credential.md`,
`docs/spec/identity.md`). Open: operator provisioning and
first-conversation bootstrap (`docs/spec/cli.md`, open questions).

## Crosscutting concepts

Error propagation across layers is register item 8 — the failure
taxonomy: what an endpoint sees when the plane refuses. Versioning
needs no runtime scenario: the protocol version is a calendar date
carried and matched per request; there is no handshake
(`docs/decisions/20260721-sessionless-network.md`).
