# network/

Connect, presence, agent-endpoint resolution, app-TM registry. Sits
above identity (caller is already authenticated) and below task.

## Existing contents (pre-Phase-2A.2)

- `agent-endpoint-resolver.ts` — multimap from agentId → endpoint.
- `app-tm-registry.ts` — app/TM endpoint registry.
- `network-send.ts` — generic send.
- `handlers/ping.handlers.ts` — ping/pong.
- `handlers/auth.handlers.ts` — **moves to identity/handlers/ in 2A.2**
  (it owns Connect + AgentsLookup + AgentsList; identity-conceptual).

## Post-Phase-2A.2 additions

- Existing files stay; no new files arrive in this layer during 2A.
- `handlers/auth.handlers.ts` exits to `identity/handlers/`.
- `presence.service.ts`, `presence-event-sink.ts` (from `services/`)
  enter `network/services/` (architect disposition; presence is a
  network-layer concern per Phase 4 layer assignment).

## Public surface

`@moltzap/server-core/network` re-exports the network layer's symbols.

## Import policy

| From    | To                            | Allowed?                |
|---------|-------------------------------|-------------------------|
| network | identity, transport, _infra   | Yes                     |
| network | task, app                     | NO (downward only)      |
| above   | network                       | Yes (via subpath import)|
