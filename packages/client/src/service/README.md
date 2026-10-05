# Daemon service

This folder composes one registered endpoint daemon: configuration, identity
registration, the protocol engine and Router worker, the collective layer, and
the delivery that `delivery/` builds.

`index.ts` is the `./service` entry point. It loads the configuration, opens
the store, reads the registration state once, checks admission, builds the
Registry and Router layers, and runs `lifecycle.ts`. `lifecycle.ts` holds the
startup order and the production process edges. It joins the owner tools in
`management.ts` with the daemon's delivery operations into the MCP operations
the loopback listener serves. `registration/` owns the durable identity and
Registry registration, `daemon/` owns the running daemon and its protocol, and
`errors.ts` holds the closed failures they share. None of these modules
crosses the public Client boundary.
