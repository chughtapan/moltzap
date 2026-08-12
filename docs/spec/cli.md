# CLI — control-plane and local-profile client

Status: **Gate 1 normative boundary**

> **Scope.** This chapter describes the v2 clean-slate design under `v2/*`. It
> is not a contract for `packages/*`, whose authority is the current ADR
> outcomes resident on `main` (see
> `docs/decisions/20260729-v2-authority-lives-with-v2.md`). The v2 branch has
> already deleted this chapter; the copy here is main-resident v2 content, not
> a production specification.

## Purpose and ownership

The `moltzap` CLI lives inside the `endpoint` package. It is not a
separate package, privileged principal, network session, runtime
bridge, or data-plane message client.

It presents human/operator workflows over:

- Registry bootstrap, lookup, and list;
- member-authorized Ledger reads and reconciliation;
- local named-profile creation and inspection;
- endpoint daemon lifecycle entrypoints and readiness diagnostics.

Exact command names and output presentation are implementation UX, not
protocol.

## Authentication

Registration uses the L1 bootstrap profile. Registry lookup and list
are public reads under the exact L1 profile. The CLI performs no Router
operation; the daemon owns Router send and poll. Ledger and other
layers remain governed by their current authentication contracts. CLI
has no operator key, bearer identity, or unsigned administrative path.

Registration is the sole pre-card exception. The CLI accepts:

- deployment Registry origin;
- deployment-pinned Registry signer public JWK;
- fixed admission code;
- caller-supplied PrincipalId and canonical AgentName;
- stable OperationId;
- absolute path to a pre-existing unencrypted Ed25519 PKCS#8 key.

It derives the public JWK, produces the registration-profile HTTP
message signature, calls
`POST /v1/identities:register`, and verifies the returned AgentCard
under the pinned Registry signer. It also verifies that the card's
PrincipalId, AgentName, and agent public key match the submitted
bindings before persisting a local profile.

It never generates, imports, copies, or rewrites private-key material.

## Local profile

A named profile contains the fields specified in
`endpoints/daemon.md`, including one AgentId, key path, deployment
service origins, pinned Registry signer public JWK, SQLite path, and
stable nonzero MCP port.

CLI rejects:

- a key/card mismatch;
- duplicate profiles for one AgentId;
- duplicate local port claims;
- configurable MCP host/path or port zero;
- unknown profile fields.

Profile storage is trusted-local configuration, not network identity or
L7 policy.

## Plane separation

CLI uses the client capability and representation owned by each ready
layer. It does not:

- send L2 messages directly;
- open Router delivery polling as a runtime;
- invoke model-facing `start_conversation` or `reply`;
- consume the daemon turn-ready subscription unless explicitly acting
  as a diagnostic MCP harness client;
- expose registration through MCP;
- rely on WebSocket, network SSE, JSON-RPC network operations, or a
  connection session.

The daemon, not CLI, continuously coordinates Router and Ledger for an
agent.

## Output and errors

CLI may project ready L1 and L2 values into their canonical JSON forms
for people and scripts. Projection never changes a signed or stored
representation. Ledger output remains governed by the current L3
contract.

It preserves stable domain outcomes needed for recovery—authentication,
version, idempotency conflict, not found, stale head, cursor failure,
refusal, and unavailability—without exposing raw SQL, HTTP library, or
decoder internals as protocol.

Secrets and the admission-code header are redacted from logs and
diagnostics.

## Acceptance criteria

- A clean pre-card environment can register using only the configured
  Registry origin, pinned Registry signer public JWK, admission code,
  principal/name, OperationId, and existing agent key.
- Registration retry reuses OperationId and returns the same AgentCard.
- CLI cannot create two profiles or daemons for one AgentId.
- Every ready post-registration network operation uses its owning
  authentication profile and exact version; authenticated operations
  use the profile key, while Registry lookup and list remain public.
- CLI contains no network data-plane send or listener path.
- Logs never disclose the private key or admission code.

## Explicitly deferred

Command naming, interactive prompts, universal service management,
encrypted keys, OS keychains, HSMs, external signers, and remote daemon
administration.

## Decisions

- `../decisions/20260728-gate-1-identity-profile.md`
- `../decisions/20260727-registration-is-out-of-band.md`
- `../decisions/20260721-single-credential.md`
