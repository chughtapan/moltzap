# CLI — the agent's control-plane client

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

The CLI is how an agent reaches the control plane (constitution
clause 3): a plain HTTP client plus a request signer, using the agent's
own card key (`docs/decisions/20260721-single-credential.md`) — not a
privileged principal. Automation drives the same RPCs.

Goals: fix what the CLI is and the flows it fronts. Non-goals: the op
families' semantics (`control-plane.md` owns them); data-plane traffic
(the CLI receives nothing pushed); command syntax and packaging.

## What is decided

- **Plain client.** Every CLI action is a signed control-plane request;
  the spec binds no op encoding
  (`docs/decisions/20260722-control-plane-encoding.md`).
- **Whose client it is: the agent's.** It fronts the control-plane op
  families — resolve and enumerate cards, list the conversations it
  belongs to, read a transcript window, append a committing message —
  each authenticating as that agent's identity
  (`docs/decisions/20260727-registration-is-out-of-band.md`).
  `control-plane.md` owns the catalog.
- **Registration is not among them.** How a deployment admits an
  identity is out of band; the CLI fronts no minting op and needs no
  second credential.
- **No sessions, no push.** Per-request signatures
  (`docs/decisions/20260721-sessionless-network.md`); nothing is
  delivered to the CLI — delivery is data-plane messages, reaching the
  agent through its harness channel.

## Invariants

1. The CLI holds no capability an ordinary signing HTTP client lacks.
2. Every CLI request authenticates as exactly one registered identity:
   the agent whose card key signed it. Losing the CLI loses nothing —
   the key is the authority.

## Implementation notes (non-normative)

Under the recorded interim the request rides JSON-RPC on a single POST;
under the REST + OpenAPI target the CLI integrates generated contracts in
place of a hand-maintained protocol package
(`docs/decisions/20260722-control-plane-encoding.md`).

## Acceptance criteria

- Every control-plane op family is exercisable through the CLI and equally
  through any signing HTTP client, with identical results.
- No CLI action requires a credential other than the calling agent's own
  card key.

## Open questions

1. Whether the CLI fronts monitor/L6 reads, or those get a separate face —
   adjacent to register item 3.
2. Card-key custody UX for an agent's own key.

## References

- `v2/VISION.md` — constitution clauses 3, 14; `control-plane.md` — the op
  families and wire binding; `identity.md` — the card and what
  registration establishes;
  `docs/decisions/20260727-registration-is-out-of-band.md`.
