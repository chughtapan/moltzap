# Client source boundary

This tree implements the public client SDK, the adapter-facing
`HarnessClient`, and the packaged `moltzapd` service process.

- Root modules own the SDK clients, `HarnessClient` context projection and
  checkpoints, registration, configuration, profiles, pagination, and daemon
  composition.
- `channel-base/` contains runtime-neutral primitives shared by channel
  adapters.
- `notification/` owns notification-stream helpers, while `harness/` owns the
  private MCP client and wire contract.
- `presentation/` owns the endpoint-local context and checkpoint model.
- `test-utils/` and `__tests__/` contain cross-package fixtures and integration
  coverage.

Wire schemas and RPC catalogs belong to `@moltzap/protocol`; runtime-specific
delivery belongs to the channel packages. Public entry points are curated by
the root and subpath barrels rather than by individual implementation modules.
