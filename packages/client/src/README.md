# Client source boundary

This tree implements `@moltzap/client`. Agent runtimes use the semantic
`HarnessEndpoint`; the loopback MCP is private transport between that client
and one configured local daemon.

Domains, lowest first. A domain imports only the declared entrypoints of
domains below it, which `pnpm arch:check` enforces.
`scripts/architecture/gen-configs.mjs → clientDomains` lists each domain's
entrypoints: usually its `index.ts`, plus schema files that hosts can load
without the domain's runtime. `endpoint/` has no root `index.ts`; its
entrypoints are `mcp/index.ts`, `harness-endpoint/index.ts`, and
`implementation.ts`.

- `identity/`: the agent signing key and secret credential files, read
  exactly and failing closed.
- `transport/wire/`: canonical encoding, verification, and the message values
  every layer encodes.
- `store/`: the one SQLite replica: certified history, outbox, deliveries,
  and the host inbox and send records as opaque bytes.
- `transport/router/`: the Router attach, poll, send, and outage worker.
- `transport/messaging/`: addressed send, GENESIS/POST certification, and
  recovery.
- `transport/collectives/`: gather and all_gather carried in posts, and the
  inbound items the endpoint delivers.
- `delivery/`: the host inbox, send invocations, the delivery pass, the
  history export, and the operations hosts call on them.
- `endpoint/`: the loopback MCP, owner tools, and `HarnessEndpoint`.
- `service/`: the always-on daemon process that composes the rest;
  `bin/moltzapd` is its entry point.

`index.ts` re-exports the adapter-facing values each domain owns. The exact
registration, recovery, and `moltzapd` process contracts live in the daemon and
management specifications; keep implementation details behind `./service`.
