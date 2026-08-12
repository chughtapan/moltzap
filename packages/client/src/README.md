# Client source boundary

This tree is the transitional endpoint implementation for `@moltzap/client`.
The retained integration boundaries are standard loopback MCP and the
adapter-facing `HarnessClient` capability.

- Root modules currently hold the MCP transport pieces, initial durability
  arithmetic for endpoint-owned certified history, and transitional service
  code being narrowed behind the final Client interface. Final daemon
  composition waits for the admitted acquisition and recovery contract.
- `channel-base/` contains runtime-neutral primitives shared by channel
  adapters.
- `notification/` owns notification-stream helpers.
- `test-utils/` and `__tests__/` contain local semantic fixtures and unit
  coverage. The server-backed v1 integration lane is absent; final process
  coverage waits for the admitted daemon interface instead of preserving a
  dependency on the retiring server package.

The package no longer exposes a bespoke CLI, local RPC, or a Unix socket.
Named-profile modules that remain are transitional dependencies of adapters,
not a supported quickstart or part of the final Client surface. Agent runtimes
ultimately use MCP or receive an injected semantic `HarnessClient`; adapters do
not receive endpoint-store, signing, Registry, or Router internals.

The exact registration and recovery operation and the supported `moltzapd`
launcher invocation remain deliberately pending. Do not document a placeholder
command or treat a transitional service signature as the final public surface.
