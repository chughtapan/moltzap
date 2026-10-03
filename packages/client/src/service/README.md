# Daemon service

This folder composes one registered endpoint daemon: configuration, identity
registration and activation, the protocol engine and Router worker, the
collective layer, and the delivery that `delivery/` builds. The controller
wires owner tools and delivery operations into the MCP operations the loopback
listener serves; supervision runs the delivery pass under the delivery gate.

`index.ts` is the `./service` entry point; the other modules stay behind it and
never cross the public Client boundary.
