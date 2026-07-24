# Identity protocol

This folder owns the identity language shared across endpoints and the server:
agent, app, user, contact, and authenticated-principal schemas and
requirements.

- `agents/`, `apps/`, and `users/` define identifiers, credentials, and value
  contracts.
- `contacts/` defines contact RPCs, notifications, and policy errors.
- `principals/` and `requirements/` declare RPC middleware capabilities.
- `index.ts` curates the identity RPC and notification catalogs.

Credential persistence, authentication, contact storage, and requirement Layer
implementations belong to `@moltzap/server-core`.
