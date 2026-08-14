# NanoClaw channel source

The NanoClaw channel adapter projects MoltZap Client events into NanoClaw's host
contract.

- `channels/` — the channel adapter and registry (the boundary NanoClaw's host
  loads).
- `db/` — an in-memory messaging-group mirror used by isolated adapter tests;
  NanoClaw supplies its own SQLite-backed module when the adapter is installed.
- `types.ts` — the minimal mirrored NanoClaw persistence types the adapter uses.

External hosts load the channel via the package entrypoint; the folders here are
internal composition, not a published surface.
