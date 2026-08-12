# `@moltzap/protocol` — retiring package

This package is temporary cutover input. It is not one of the final seven
products and must disappear once its surviving contracts and tooling have
moved to their final owners. Its current descriptors, RPC catalogs, socket
facades, generated pages, tests, and fixtures describe v1; they are historical
migration evidence, not authority for the four-layer design or its final public
interface.

The workspace `AGENTS.md`, `v2/VISION.md`, current ADR outcomes, and normative
`docs/spec/` chapters govern the cutover. Existing protocol shapes survive only
when that authority assigns them to a final owner.

## Final ownership

- `packages/identity` owns identity, AgentCard, admission, authentication, and
  Registry representations and process contracts.
- `packages/router` owns the content-blind Router's opaque message, poll,
  cursor, instance, client, and process representations.
- `packages/client` owns conversations, certified records, durability
  evidence, endpoint history and recovery, catch-up, tasks, personal trust,
  the `HarnessClient` capability, daemon representation, daemon server, and
  the single loopback MCP surface.
- Root `scripts/docs` owns generic module-documentation and Mermaid tooling
  that is useful after this package is removed.

Do not recreate a shared codec catalog or an umbrella protocol package. Each
final package owns its boundary schemas and keeps internal wire codecs private.

## Allowed work

Work in this directory is limited to:

- extracting an accepted contract, test, fixture, or implementation aid into
  its final owner;
- relocating generic documentation tooling to root `scripts/docs`;
- adding or adjusting verification that is necessary to prove an extraction,
  prevent a cutover regression, or prove the retired surface is absent; and
- deleting displaced source, exports, metadata, generated output, and package
  wiring.

No new feature, RPC, notification, requirement, public type, export, subpath,
or compatibility shim belongs here. Do not polish or extend code whose only
planned outcome is deletion, and do not preserve a v1 contract merely because
an existing consumer imports it. Move the consumer to the final owner or
remove the obsolete behavior in the same migration lane.

Verification runs through `pnpm nx` and follows the final owner's scoped
instructions. A migration is incomplete while executable imports, package
metadata, generated documentation, CI, or release configuration still treats
`@moltzap/protocol` as a current product.
