# Server source boundary

This tree implements the standalone MoltZap control plane, storage layer, and
data-plane router.

Domain folders own their services and RPC handlers; `moltzap/` adapts those
handlers to protocol requirements, `socket/` and `http/` own live transports,
`db/` owns persistence primitives, and `core/` composes the service graph.
`config/`, `config.ts`, and `standalone.ts` form the executable boot boundary.

Protocol schemas and endpoint lifecycle contracts remain in
`@moltzap/protocol`. The package root is intentionally empty; only the
documented test-utils subpath is importable by other packages.
