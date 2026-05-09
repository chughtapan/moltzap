# identity/

Registration, authentication, contacts, agent visibility. Owns the
"who is this caller" decisions before any task-layer work runs.

## Folder shape (peers under identity/)

```
identity/
  handlers/       # RPC handlers (auth, agents/lookup, agents/list)
  services/       # contact, participant, agent-visibility, auth.service, session-validator, agent-auth
  index.ts        # barrel
  README.md
```

Per Q-task-folder-shape resolution: handlers/ and services/ are peers
of identity/index.ts, NOT siblings via a single-purpose subdir.

## Post-Phase-2A.2 contents

### `identity/handlers/`
- `auth.handlers.ts` (from `network/handlers/auth.handlers.ts`) — Connect,
  AgentsLookup, AgentsLookupByName, AgentsList.

### `identity/services/`
- `contact.service.ts` (from `services/`)
- `participant.service.ts` (from `services/`)
- `auth.service.ts` (from `services/`) — registration, claim, login.
- `agent-visibility.ts` (from `services/`) — contact-scoped visibility.
- `session-validator.ts` (from `services/`) — webhook session resolver.
- `agent-auth.ts` (from `auth/agent-auth.ts`) — API-key + claim/invite
  token primitives.

## Public surface

`@moltzap/server-core/identity` re-exports the symbols above.

## Import policy

| From      | To                     | Allowed?                |
|-----------|------------------------|-------------------------|
| identity  | transport, _infra      | Yes                     |
| identity  | network, task, app     | NO (downward only)      |
| any-above | identity               | Yes (via subpath import)|
