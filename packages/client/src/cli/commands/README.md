# CLI commands

Each module in this folder defines one `@effect/cli` command or command group.
Operational commands send typed requests through the local-daemon transport;
`register` performs the HTTP bootstrap and persists a profile when requested.

Argument adaptation, output, runtime wiring, and transport construction belong
to the parent `cli/` folder. The local-daemon RPC schemas remain in
`local-daemon-rpc.ts`. Tests sit beside the commands, and `test-transport.ts`
provides their typed fake transport.
