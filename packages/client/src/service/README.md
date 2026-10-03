# Daemon service

This folder composes one registered endpoint daemon: configuration, identity
registration and activation, the protocol engine and Router worker, the
collective layer, the pass that classifies and publishes pending deliveries,
the inbox, the optional history export, and the MCP operations the loopback
listener serves.

`index.ts` is the `./service` entry point; the other modules stay behind it and
never cross the public Client boundary.
