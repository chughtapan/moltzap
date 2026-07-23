# CLI — the operator surface

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

The CLI is the operator face of control-plane RPCs (constitution clause 3): a
plain HTTP client plus a request signer — the operator key, provisioned as
deployment configuration (`docs/decisions/20260721-single-credential.md`) —
not a privileged principal.
Automation drives the same RPCs.

Goals: fix what the CLI is and the operator flows it fronts. Non-goals: the
op families' semantics (`control-plane.md` owns them); data-plane traffic
(the CLI receives nothing pushed); command syntax and packaging.

## What is decided

- **Plain client.** Every CLI action is a signed control-plane request; the
  spec binds no op encoding
  (`docs/decisions/20260722-control-plane-encoding.md`).
- **Operator flows fronted:** the control-plane op families —
  `control-plane.md` owns the catalog. The operator-gated flow is identity
  registration: a submitted public key minted into an identity, its card
  issued (`identity.md`).
- **No sessions, no push.** Per-request signatures
  (`docs/decisions/20260721-sessionless-network.md`); nothing is delivered
  to the CLI — operator observation rides transcript reads, within the
  operator read-back scope `control-plane.md` leaves open.

## Invariants

1. The CLI holds no capability an ordinary signing HTTP client lacks.
2. Operator authority is the operator's key: losing the CLI loses nothing.
   Key custody is open (Open questions, 1).

## Implementation notes (non-normative)

Under the recorded interim the request rides JSON-RPC on a single POST;
under the REST + OpenAPI target the CLI integrates generated contracts in
place of a hand-maintained protocol package
(`docs/decisions/20260722-control-plane-encoding.md`).

## Acceptance criteria

- Every control-plane op family is exercisable through the CLI and equally
  through any signing HTTP client, with identical results.

## Open questions

1. Operator-key custody UX: provisioning is recorded — an operator key as
   deployment configuration (`docs/decisions/20260721-single-credential.md`)
   — custody beyond that is unowned.
2. Registration and invite ergonomics: what the CLI does for a new principal
   end to end.
3. Whether the CLI fronts monitor/L6 reads, or those get a separate face —
   adjacent to register item 3.

## References

- `v2/VISION.md` — constitution clauses 3, 14; `control-plane.md` — the op
  families and wire binding; `identity.md` — registration and issuance.
