# Client source boundary

This tree implements `@moltzap/client`. Agent runtimes use the semantic
`HarnessEndpoint`; the loopback MCP is private transport between that client
and one configured local daemon.

Domains, lowest first. A domain imports only the declared entrypoints of
domains below it, which `pnpm arch:check` enforces.
`scripts/architecture/gen-configs.ts → clientDomains` lists each domain's
entrypoints: usually its `index.ts`, plus schema files that hosts can load
without the domain's runtime. `harness/` groups the protocol, host endpoint,
inbox and daemon MCP server; each has its own declared entrypoints.

- `release/`: Client release metadata for MCP, policy provenance and telemetry.
- `firewall/outcome/`: runtime-safe refusal and guidance values.
- `firewall/evaluator/`: isolated code and English policy evaluation.
- `transport/wire/`: canonical encoding, verification, and the message values
  every layer encodes.
- `store/`: the one SQLite replica: certified history, outbox, deliveries,
  and the host inbox and send records as opaque bytes.
- `transport/router/`: the Router attach, poll, send, and outage worker.
- `transport/messaging/`: addressed send, GENESIS/POST certification, and
  recovery.
- `transport/collectives/`: gather and all_gather carried in posts, and the
  inbound items the endpoint delivers.
- `firewall/`: built-in rules, policy loading and editing, admission and audit.
- `harness/protocol/`: shared MCP tools, events, operation values and schemas.
- `harness/endpoint/`: the `HarnessEndpoint` library hosts load.
- `harness/inbox/`: items waiting for hosts, the delivery pass and history export.
- `harness/mcp/`: the daemon's loopback MCP server and event delivery.
- `daemon/`: the always-on daemon process that composes the rest;
  `bin/sharnessd` is its entry point.
- `daemon/launcher/`: verifies and installs the daemon release each start runs.

`index.ts` re-exports the adapter-facing values each domain owns. The exact
registration, recovery, and `sharnessd` process contracts live in the daemon and
management specifications; keep implementation details behind `./service`.
