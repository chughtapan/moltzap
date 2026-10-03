# Client source boundary

This tree implements `@moltzap/client`. Agent runtimes use the semantic
`HarnessEndpoint`; the loopback MCP is private transport between that client
and one configured local daemon.

Domains, lowest first. A domain imports only the `index.ts` entrypoints of
domains below it, which `pnpm arch:check` enforces.

- `transport/wire/`: canonical encoding, verification, and the message values
  every layer encodes.
- `transport/history/`: the daemon's SQLite replica of certified history.
- `transport/router/`: the Router attach, poll, send, and outage worker.
- `transport/messaging/`: addressed send, GENESIS/POST certification, and
  recovery.
- `transport/collectives/`: gather and all_gather carried in posts, and the
  inbound items the endpoint delivers.
- `endpoint/`: the loopback MCP, owner tools, and `HarnessEndpoint`.
- `service/`: the always-on daemon process that composes the rest;
  `bin/moltzapd` is its entry point.

`index.ts` re-exports the adapter-facing values each domain owns. The exact
registration, recovery, and `moltzapd` process contracts live in the daemon and
management specifications; keep implementation details behind `./service`.
