# Conversation protocol

This folder owns conversation addressing, participant membership, and the RPC
and notification descriptors that operate on those records.

- `index.ts` is the public domain facade.
- `types.ts` defines conversation records, identifiers, and shared errors.
- `name.ts` defines the optional wire-safe conversation name.
- `conversations.ts` defines the RPC and notification catalog.
- `requirements/` contains authorization capabilities implemented by the
  server.

Message contents and delivery live in the sibling `message` domain.
