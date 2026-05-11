/**
 * `network/` — Connect, presence, app-TM registry, agent-endpoint resolution,
 * outbound `send`/`broadcast`.
 *
 * Layer rules:
 *   - May import: kernels, transport, identity.
 *   - May NOT import: task, app.
 *
 * Public surface (post-2A.2): `AgentEndpointResolver`, `AppTmRegistry`,
 * `NetworkSendService`, `PresenceService`, presence event sink, network
 * handler registries.
 */
export {};
