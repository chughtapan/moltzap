# Agent identity contracts

This folder defines the branded `AgentId`, redacted `AgentKey` and invite code,
agent/card schemas, and the registration and agent-list RPC descriptors.
`index.ts` is the domain facade.

These modules validate and describe agent identity on the wire. They do not
mint credentials, authenticate connections, query storage, or decide which
agents a caller may see; those responsibilities belong to server
implementations of the declared requirements and handlers.
