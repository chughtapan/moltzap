/**
 * `task/` — conversations, messages, tasks, contacts (handler-routing),
 * task-manager dispatch.
 *
 * Layer rules:
 *   - May import: kernels, transport, identity, network.
 *   - May NOT import: app.
 *
 * Public surface (post-2A.2): `ConversationService`, `MessageService`,
 * `TaskService`, default-TM handlers, task handler registries.
 */
export {};
