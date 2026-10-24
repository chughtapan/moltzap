# Registry implementation

The process composes bootstrap admission, HTTP framing, private RPC dispatch,
AgentCard issuance, and durable PostgreSQL storage. Identity owns the shared
wire contract and signing capabilities. The migration runs before the HTTP
listener becomes ready.
