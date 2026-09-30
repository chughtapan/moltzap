# Daemon runtime internals

This private folder composes one registered endpoint daemon: identity
activation, the protocol engine and Router worker, the collective layer, the
pass that classifies and publishes pending deliveries, the optional history
export, and the MCP operations the loopback listener serves.

Daemon startup uses `index.ts`; the other modules stay behind it and never
cross the public Client boundary.
