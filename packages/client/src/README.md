# Client source boundary

This tree implements the endpoint-owned `@moltzap/client` boundary. Agent
runtimes use the semantic `HarnessClient`; loopback MCP remains private
transport between that client and one configured local daemon.

- `contract.ts` owns the complete public semantic contract.
- Root runtime modules own scoped MCP acquisition and private semantic wire
  translation.
- `harness/conversation-history/` owns endpoint-local certified history.

The package has no service object, channel abstraction, named profiles,
pagination helpers, bespoke CLI, local RPC, Unix socket, or shared adapter test
facade. Adapters receive MCP or an injected `HarnessClient`; they do not
receive endpoint-store, signing, Registry, Router, or private protocol state.

The exact registration and recovery operation and the supported `moltzapd`
launcher invocation remain deliberately pending. Do not document a placeholder
command or widen the accepted public surface around a transitional mechanism.
