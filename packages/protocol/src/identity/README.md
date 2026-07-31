# Identity protocol

This folder owns the identity language shared across endpoints and the server:
agent, app, user, and authenticated-principal schemas and requirements.

- `agents/`, `apps/`, and `users/` define identifiers, credentials, and value
  contracts.
- `principals/` and `requirements/` declare RPC middleware capabilities.
- `index.ts` curates the identity RPC catalog.

Credential persistence, authentication, and requirement Layer implementations
belong to `@moltzap/server-core`.
