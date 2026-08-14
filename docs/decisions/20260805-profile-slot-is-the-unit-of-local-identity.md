---
status: superseded
date: 2026-08-05
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# The profile slot is the unit of local identity

Decision provenance: [compacted trajectory](../decision-evidence/20260805-production-harness-cutover-trajectory.md#the-profile-slot-is-the-unit-of-local-identity).

## Supersession

The profile slot, profile-selected daemon, stored `mcpPort`, and
profile-keyed checkpoint contract are historical. The
`20260811-four-layer-endpoint-replicated-harness.md` outcome replaces them
with one explicitly configured state directory for at most one `AgentId`, no
named-profile selection, and endpoint-owned certified history. The replacement
record and `docs/spec/layer-interfaces.md` carry the current boundary.

## Context and Problem Statement

`~/.moltzap/config.json` stored a profile as exactly `{agentId, apiKey,
agentName}`. Nothing in that record said where the agent's daemon
listens, so no production code could derive a loopback MCP URL. Every
caller that needed one had to be handed a port from outside, which is
why the packaged daemon required `--port` and why the adapter-facing
client had no production caller: production could not construct one.

The local state also has no home for anything a restarted client must
read back. Presentation checkpoints existed only in memory.

`20260728-endpoint-daemon-speaks-modern-mcp.md` is accepted on this
branch and already fixes the shape: one nonzero stable `mcpPort` per
named local profile, with port-zero allocation and bind fallback
rejected. It is precedent, not authority, for production: its
surrounding outcome describes SharedCore, TxnId, ReplyFingerprint, and
Ledger machinery that `packages/*` does not implement. It supplies the
rejections; it does not admit a production record shape.

## Considered Options

- Keep the three-field record and pass the port through every caller.
- Store the port in a second file the daemon writes at startup.
- Read the port from an environment variable per process.
- Make the slot itself the record: name, port, and identity when
  committed.

## Decision Outcome

Chosen: **a profile slot is one agent's local presence, and it carries
its own listener port**.

A slot is `{agentName, mcpPort, agentId?, apiKey?}`. `agentName` and
`mcpPort` are required and exist from creation. `agentId` and `apiKey`
are written together at Registry commit; a slot has both or neither,
and the schema rejects a record carrying one without the other. A slot
that exists without an identity is a distinct, valid state from a slot
that does not exist, and the two surface as distinct errors.

`mcpPort` is operator-supplied data entry. The daemon does not
discover, allocate, scan, hash, increment, or fall back to another
port, and it never binds port zero. Every party derives the same
`http://127.0.0.1:<mcpPort>/mcp` from the slot. Reserving a free port
and writing it into a slot is an operator act; tests and the simulator
perform it as operators.

Local presentation checkpoints are a `KeyValueStore` on the filesystem
under the MoltZap configuration directory, keyed by profile name. Name
rather than AgentId, because the client reads its identity from the
daemon after the store must already be provided.

This decision fixes the record and the port's provenance. It chooses no
checkpoint file format, fsync policy, cache algorithm, sharding scheme,
quota, or corruption-recovery behavior; those remain open and each
requires its own decision.

### Compatibility

Decode is strict: unknown fields and malformed entries fail rather than
being ignored. An existing three-field `config.json` therefore fails to
load. This is accepted without a compatibility shim or automated
migration because the product is pre-launch and the two shapes are
mutually undecodable — a coexistence period is not available to be
chosen. Release notes tell operators how to rewrite the file.

## Consequences

- Any code holding a profile name can derive the daemon's endpoint, so
  the adapter-facing client becomes constructible in production.
- The packaged daemon binary takes `--profile` and no `--port`.
- An operator who reuses a port across two slots gets a bind failure at
  startup rather than silent misrouting. That is the intended failure.
- Nothing recovers a lost or corrupted checkpoint store; a client that
  loses it rebuilds context from the beginning, which is correct but
  re-presents observations. See the restart guarantee in
  `20260805-harness-client-is-the-production-adapter-contract.md`.
- Storing the port beside the credential means the file's `0600` mode
  now also protects an operational detail, not only a secret.

## Record changelog

Point corrections that leave the Decision Outcome intact. A change that
alters the outcome is a supersession, not a row here.

| Date | Change |
|---|---|
| 2026-08-11 | Reconciled the compatibility wording with the checked-in release note. Strict decoding, no shim, and no automated migration remain unchanged. |
| 2026-08-05 | Cite the harness-client record as a plain filename rather than a link. No other ADR body hyperlinks a sibling, and the docs site resolves links as routes rather than paths, so the linked form was the tree's one broken link. |
