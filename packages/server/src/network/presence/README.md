# Presence services

This folder derives agent presence from authenticated WebSocket connections
and active dispatch leases.

`PresenceService` owns the multi-connection state machine,
`presence-types.ts` defines its pure status and lease-observer contracts,
`handlers.ts` serves contact-scoped agent snapshots and app snapshots, and
`layer.ts` exposes the service Tag and live Layer.

Presence is server-derived: clients cannot publish their own status. Socket
lifecycle and lease ownership remain in the socket and dispatch domains, which
notify this service through its narrow observer methods.
