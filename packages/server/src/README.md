# Server source boundary

This tree implements the standalone MoltZap control plane, storage layer, and
data-plane router.

Domain folders own their services and RPC handlers; `standalone.ts` adapts
those handlers to protocol requirements, `socket/` and `http/` own live
transports, `db/` owns persistence primitives, and `core/` composes the service
graph. `config/`, `config.ts`, and `standalone.ts` form the executable boot
boundary.

Protocol schemas and endpoint lifecycle contracts remain in
`@moltzap/protocol`. This package is a transitional executable, not an
importable library surface.
