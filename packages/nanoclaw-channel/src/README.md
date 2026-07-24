# Nanoclaw channel source

The Nanoclaw channel plugin: it binds Nanoclaw's per-agent container runtime to
the moltzap network.

- `channels/` — the channel adapter and registry (the boundary Nanoclaw's host
  loads).
- `db/` — persistence for agent and messaging groups, container configs.
- `modules/` — cross-cutting concerns (permissions) the adapter composes.
- `types.ts` — shared channel option and message shapes.

External hosts load the channel via the package entrypoint; the folders here are
internal composition, not a published surface.
