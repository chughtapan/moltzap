# Database cryptography

This folder owns encryption-at-rest primitives for server persistence:
envelope encryption, typed DEK/KEK/master-key material, payload serialization,
key wrapping and rotation, and the Effect service Layer. `barrel.ts` curates
the internal crypto surface.

The boundary accepts and returns key material or encrypted payloads; it does
not own conversation policy or database selection. Database-backed key
lifecycle operations depend only on the shared `Db` contract.
