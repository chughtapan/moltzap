/**
 * `identity/` — registration, claim, login, contacts, participants, agent visibility.
 *
 * Owns: agents, owners, contacts, participants, session validators, agent-visibility
 * decisions, agent-auth (admin claim flow), and the identity-conceptual handlers
 * (Connect, AgentsLookup, AgentsLookupByName, AgentsList).
 *
 * Layer rules:
 *   - May import: kernels + transport.
 *   - May NOT import: network, task, app.
 *
 * Public surface: `AuthService`, `ContactsService`, `ParticipantService`,
 * `SessionValidator`, `agentVisibility`, identity handler registries.
 *
 * Populated in 2A.2 (folder moves). Empty in 2A.1.
 */
export {};
