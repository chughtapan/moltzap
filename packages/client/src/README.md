# Client source boundary

This tree implements the public client SDK, the packaged `moltzapd` service
process, and the `moltzap` CLI.

- Root modules own the SDK clients, `MoltZapService`, channel dispatch,
  registration, configuration, profiles, pagination, and local-daemon RPC.
- `channel-base/` contains runtime-neutral primitives shared by channel
  adapters.
- `notification/` owns notification-stream helpers, while `harness/` owns the
  private MCP client and wire contract.
- `cli/` owns executable argument parsing for `moltzapd` and the `moltzap`
  control CLI.
- `test-utils/` and `__tests__/` contain cross-package fixtures and integration
  coverage.

Wire schemas and RPC catalogs belong to `@moltzap/protocol`; runtime-specific
delivery belongs to the channel packages. Public entry points are curated by
the root and subpath barrels rather than by individual implementation modules.
