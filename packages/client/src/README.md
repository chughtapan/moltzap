# Client source boundary

This tree implements the endpoint-owned `@moltzap/client` boundary. Agent
runtimes use the semantic `HarnessEndpoint`; loopback MCP remains private
transport between that client and one configured local daemon.

- `contract.ts` owns the complete public semantic contract.
- Root runtime modules own scoped MCP acquisition and private semantic wire
  translation.
- `endpoint/` owns the closed protocol, durable replica, Router worker,
  recovery, GENESIS/POST certification, and pending host delivery state.
- `daemon/` and `server.ts` compose one registered endpoint into the loopback
  MCP server used by runtimes; `bin/moltzapd.mjs` is the process entry point.

The exact registration, recovery, and `moltzapd` process contracts live in the
normative daemon and management specifications. Keep implementation details
behind `./server`; do not widen the accepted public root surface around them.
