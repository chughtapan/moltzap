# `@moltzap/server-core` — retiring package

This package is temporary cutover input. There is no final umbrella MoltZap
server product: the Registry, Router, and each endpoint daemon are independent
processes owned by their domain packages. The current WebSocket server,
conversation/message services, database model, handlers, middleware, binary,
tests, and fixtures describe v1; they are historical migration evidence, not
authority for the four-layer design or its final public interface.

The workspace `AGENTS.md`, `v2/VISION.md`, current ADR outcomes, and normative
`docs/spec/` chapters govern the cutover. Existing server behavior survives
only when that authority assigns it to a final owner.

## Final ownership

- `packages/identity` owns the Registry process and identity, admission, and
  authentication implementation.
- `packages/router` owns the independent content-blind Router process and its
  opaque delivery implementation.
- `packages/client` owns endpoint conversations, certified records, durability
  evidence, private history and recovery, catch-up, tasks, personal trust,
  daemon storage, the daemon server, `moltzapd`, and its single loopback MCP
  endpoint.

The final system has no central conversation server, product Ledger,
Transcript service, profile daemon, or replacement `server-core` umbrella.
Generic documentation tooling that remains useful moves to root `scripts/docs`,
not into another runtime package by default.

## Allowed work

Work in this directory is limited to:

- extracting an accepted implementation, contract, test, fixture, migration,
  or process aid into its final owner;
- relocating generic documentation tooling to root `scripts/docs`;
- adding or adjusting verification that is necessary to prove an extraction,
  prevent a cutover regression, or prove the retired surface is absent; and
- deleting displaced source, exports, binaries, metadata, generated output,
  database machinery, and package wiring.

No new feature, handler, service, middleware requirement, database contract,
public interface, export, subpath, or compatibility shim belongs here. Do not
extend the v1 server graph or treat its persistence and socket semantics as
compatibility requirements. Reuse a mechanism only after moving it under the
current contract of its final owner; otherwise delete it.

Verification runs through `pnpm nx` and follows the final owner's scoped
instructions. A migration is incomplete while executable imports, package
metadata, generated documentation, CI, deployment, or release configuration
still treats `@moltzap/server-core` or `bin/moltzap-server` as a current
product.
