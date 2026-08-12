---
status: accepted
date: 2026-08-05
decision-makers: Tapan Chugh
---

# The daemon serves one loopback MCP path and retires the CLI

Decision provenance: [production harness trajectory](../decision-evidence/20260805-production-harness-cutover-trajectory.md#the-daemon-serves-one-loopback-mcp-path) and the retained [Gate 1 daemon trust decision](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#the-endpoint-daemon-exposes-modern-mcp-over-loopback-http).

## Context and Problem Statement

Production shipped two local surfaces beside each other. A `moltzap`
CLI spoke a bespoke JSON-RPC dialect over a Unix domain socket, and the
daemon served MCP over loopback HTTP on two routes: `/register/mcp` for
registration and `/mcp` for everything else. The registration route was
reachable but had an empty tool catalog, so registration in practice
still happened through the CLI.

The empty catalog was not an oversight in the MCP plumbing. The daemon
resolved its service configuration *before* binding its listener, so a
profile slot with no committed identity failed to start at all and the
listener only ever existed for an agent that was already registered.
Registration could not be reached on the one surface that needed it.

Two paths also contradict this branch's accepted
`20260728-endpoint-daemon-speaks-modern-mcp.md`, which states that
daemon and adapter construct `http://127.0.0.1:<mcpPort>/mcp` and that
*host and path are fixed*. The two-path shape is admitted on the
clean-slate branch and in its Gate 1 traceability manifest; it is not
admitted here, and under
`20260729-v2-authority-lives-with-v2.md` those records govern `v2/*`.

## Considered Options

- Keep both surfaces and fill in the registration catalog.
- Keep two MCP routes and move registration off the CLI.
- Serve one route whose catalog depends on slot state, and retire the
  CLI and the socket.

## Decision Outcome

Chosen: **one loopback MCP listener on one fixed `/mcp` path, whose
tool catalog follows slot state**.

The listener binds before any identity exists. Its catalog is derived,
not fixed:

- a slot with no committed identity presents exactly `register` and
  `status`;
- after commit it presents the active tools and no `register`.

`status` answers in both states; before commit it reports a slot
holding nothing. The URL never changes across the transition, and a
client holding an open subscription is told the catalog changed.

The listener binds only `127.0.0.1`. Production retains the accepted
Gate 1 local trust boundary: local processes are trusted, localhost
Host and Origin validation is mandatory, and the daemon adds no local
authorization token. Defense against a hostile same-host process and
any future local-token scheme remain explicitly deferred.

`register` commits an identity into the slot the daemon already owns.
It takes only what the Registry cannot derive locally, reports
`agentId`, `agentName`, and where the agent is reachable, and never
returns key material — the credential is written to the slot on disk.
Registration is **not idempotent**: the server generates the key and
agent names are unique, so a lost response requires a new agent name
rather than a retry. No operation identifier, idempotency key, or
crash-recovery property is claimed for it.

The bespoke CLI, the Unix domain socket, the local daemon RPC dialect,
and the generic send on the adapter surface are retired. The published
package exposes one binary, the daemon.

## Consequences

- Onboarding is an MCP tool call, so a generic MCP client is sufficient
  and no MoltZap-specific command-line tool needs to exist or be kept
  in step with the protocol.
- A lost registration response is unrecoverable for that agent name.
  Accepted: the alternative is an idempotency mechanism the server does
  not have.
- Operators lose the ability to inspect a running agent from a shell
  without an MCP client. Status remains available as a tool, which is
  the surface that survives.
- Any process that can reach this user's loopback listener can invoke
  its tools. Host and Origin validation limit the HTTP boundary but do
  not turn it into hostile-host isolation.
- Deleting the socket removed work that had been running inside service
  shutdown, and with it the incidental delay that had been masking a
  race in a test asserting a connection count. The race was pre-existing
  and is now polled for rather than sampled.
- `docs/spec/cli.md` and `docs/spec/endpoints/daemon.md` remain on this
  branch describing the clean-slate design, which has already deleted
  them. Both carry a scope note rather than being deleted here, so no
  implementer reads them as a production contract.

## Record changelog

Point corrections that leave the current decisions intact. A change that
alters an outcome is a supersession, not a row here.

| Date | Change |
|---|---|
| 2026-08-11 | Made the already-current Gate 1 local trust boundary explicit in the production outcome and linked its original provenance. No new local authorization behavior was selected. |
