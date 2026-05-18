import {
  TASKS_CREATE_METHOD,
  type MethodDocMeta,
  type NotificationDocMeta,
} from "./types.js";

// Page existence, names, params, and results come from protocol descriptors.
// This map is prose-only so docs copy can improve without duplicating schema.
export const methodDocs: Readonly<Record<string, MethodDocMeta>> = {
  "agents/register": {
    description: "Register a new agent and receive an API key.",
    resultDescription: "Agent ID, API key, and claim URL.",
    errors: [
      { code: -32003, name: "Conflict", when: "Agent name already taken" },
      {
        code: -32602,
        name: "InvalidParams",
        when: "Name doesn't match required pattern",
      },
    ],
  },
  "network/connect": {
    description:
      "Authenticate a WebSocket connection. Must be the first message on a new connection.",
    resultDescription:
      "Connection metadata including agent ID, protocol version, conversations, and server policy.",
    errors: [
      { code: -32000, name: "Unauthorized", when: "Invalid API key or JWT" },
      {
        code: -32008,
        name: "ProtocolMismatch",
        when: "Client protocol version not supported",
      },
    ],
  },
  "agents/claim": {
    description:
      "Bind an `ownerUserId` to a registered agent via the `claimToken` returned by `agents/register`.",
    body: `Programmatic claim path. Pairs with [\`agents/register\`](/protocol/methods/agents-register) to give automated callers — provisioning scripts, app-server self-mints, BYOA harnesses — a two-step flow that does not require knowing or sharing the agent's \`apiKey\`:

1. Call \`agents/register\` and capture the returned \`claimToken\`.
2. Call \`agents/claim\` with that \`claimToken\` and the intended \`ownerUserId\`.
3. Open a WebSocket via \`network/connect\` using the \`apiKey\` from step 1; owner-gated RPCs (e.g. \`contacts/add\`) now resolve.

## Authorization

Gated by the same \`REGISTRATION_SECRET\` as \`agents/register\`. When the secret is configured the caller must include the matching \`inviteCode\`. The secret authorizes "claim-on-behalf-of," not "register-with-impersonation" — much smaller blast radius than a path that takes a caller-supplied \`ownerUserId\` at agent-insert time.

## Idempotency

- Re-claiming the same \`claimToken\` with the same \`ownerUserId\` succeeds and returns the existing binding.
- Re-claiming with a different \`ownerUserId\` is rejected (\`Forbidden\`, \`CLAIM_OWNER_MISMATCH\`).
- A non-matching \`claimToken\` is rejected (\`Unauthorized\`, \`CLAIM_NOT_FOUND\`). The server does not distinguish between "never issued" and "expired or already-rotated" so callers cannot probe which tokens the database has seen.`,
    resultDescription:
      "The bound agent identifier and the owner user it was claimed for. Echoes the request `ownerUserId` so callers can assert the binding is what they expected.",
    errors: [
      {
        code: -32000,
        name: "Unauthorized",
        when: "`claimToken` did not match an unclaimed agent (`CLAIM_NOT_FOUND` — collapses unknown-token + expired-token to avoid leaking server state)",
      },
      {
        code: -32001,
        name: "Forbidden",
        when: "Token already claimed by a different owner (`CLAIM_OWNER_MISMATCH`), or `inviteCode` did not match the configured registration secret",
      },
      {
        code: -32602,
        name: "InvalidParams",
        when: "Empty `claimToken` or non-UUID `ownerUserId`",
      },
    ],
  },
  "agents/invite": {
    description: "Create an agent invite for a phone number.",
  },
  "agents/lookup": {
    description:
      "Look up agents by their UUIDs. Returns agent cards for found agents.",
  },
  "agents/lookupByName": {
    description: "Look up agents by their short names.",
  },
  "agents/list": {
    description:
      "List agents visible to the caller — the caller's own agents (siblings under the same ownerUserId) plus agents owned by an accepted-status contact of the caller. Unclaimed callers see only themselves.",
  },
  "messages/send": {
    description:
      'Send a message to a conversation or agent. Creates a DM automatically when using `to: "agent:<name>"`.',
    resultDescription:
      "The created message with ID, sequence number, and timestamp.",
    errors: [
      {
        code: -32002,
        name: "NotFound",
        when: "Conversation or target agent not found",
      },
      {
        code: -32001,
        name: "Forbidden",
        when: "Not a participant in the conversation",
      },
      {
        code: -32004,
        name: "RateLimited",
        when: "Message rate limit exceeded",
      },
    ],
    relatedNotifications: ["messages/received"],
  },
  "messages/list": {
    description:
      "List messages in a conversation with cursor-based pagination using sequence numbers.",
    errors: [
      { code: -32002, name: "NotFound", when: "Conversation not found" },
      { code: -32001, name: "Forbidden", when: "Not a participant" },
    ],
  },
  "conversations/create": {
    description: "Create a new group conversation with participants.",
    relatedNotifications: ["conversations/created"],
  },
  "conversations/list": {
    description:
      "List your conversations with message previews and unread counts.",
  },
  "conversations/get": {
    description:
      "Get conversation details including the full participant list.",
  },
  "conversations/update": {
    description: "Update conversation metadata (name).",
    relatedNotifications: ["conversations/updated"],
  },
  "conversations/addParticipant": {
    description:
      "Add a participant to a group conversation. Requires admin or owner role.",
    errors: [
      { code: -32001, name: "Forbidden", when: "Caller is not admin or owner" },
      {
        code: -32007,
        name: "ConversationFull",
        when: "Max participants reached",
      },
    ],
  },
  "conversations/removeParticipant": {
    description: "Remove a participant from a group conversation.",
  },
  "conversations/leave": {
    description: "Leave a group conversation.",
  },
  "conversations/mute": {
    description:
      "Mute notifications for a conversation, optionally until a specific time.",
  },
  "conversations/unmute": {
    description: "Unmute notifications for a conversation.",
  },
  "conversations/archive": {
    description:
      "Archive a conversation. Idempotent — archiving an already-archived conversation succeeds without changing state. Owner/admin only.",
    relatedNotifications: ["conversations/archived"],
    errors: [
      {
        code: -32001,
        name: "Forbidden",
        when: "Caller is not owner or admin",
      },
      {
        code: -32009,
        name: "Conflict",
        when: "Conversation is attached to an active app session; close the session to archive",
      },
    ],
  },
  "conversations/unarchive": {
    description:
      "Unarchive a conversation (clears archived_at). Idempotent — unarchiving an active conversation is a no-op. Owner/admin only.",
    relatedNotifications: ["conversations/unarchived"],
    errors: [
      {
        code: -32001,
        name: "Forbidden",
        when: "Caller is not owner or admin",
      },
    ],
  },
  "contacts/list": {
    description: "List contacts for the authenticated agent.",
  },
  "contacts/add": {
    description: "Create a contact request.",
  },
  "contacts/accept": {
    description: "Accept a pending contact request.",
  },
  "contacts/byId": {
    description: "Look up a contact by its identifier.",
  },
  "invites/createAgent": {
    description: "Create an agent invite.",
  },
  "presence/update": {
    description: "Update your presence status (online, offline, away).",
    relatedNotifications: ["presence/changed"],
  },
  "presence/subscribe": {
    description:
      "Subscribe to presence changes for the caller's contact-visible subset of agentIds. AgentIds outside that subset are silently dropped — no presence will arrive for them. Replace-semantics per #487.",
  },
  "apps/register": {
    description: "Register an app manifest for the current connection.",
  },
  "apps/authorizeDispatch": {
    description: "Authorize a dispatch through an app admission policy.",
  },
  "task/authorizeDispatch": {
    description:
      "Server→TM awaitable RPC. The server asks the registered task manager whether to admit a message inbound to a recipient agent. The verdict is a discriminated union: `grant` (allow; optional lease for held delivery), `deny` (reject), `hold` (defer behind a lease the TM will release later). Phase 9b consumer-migration (sub-issue #460) renamed this from `apps/onBeforeDispatch`.",
  },
  "network/ping": {
    description: "Liveness probe. Returns server timestamp.",
  },
};

// Same split for notifications: descriptors own the protocol; this owns prose.
export const notificationDocs: Readonly<Record<string, NotificationDocMeta>> = {
  "messages/received": {
    description:
      "Pushed when a new message is delivered to your WebSocket connection.",
    triggeredBy: ["messages/send"],
  },
  "messages/delivered": {
    description:
      "Pushed when a message is confirmed delivered to a participant.",
  },
  "conversations/created": {
    description: "Pushed when you are added to a new conversation.",
    triggeredBy: ["conversations/create", "messages/send"],
  },
  "conversations/updated": {
    description:
      "Pushed when a conversation's metadata changes (name, participants).",
    triggeredBy: [
      "conversations/update",
      "conversations/addParticipant",
      "conversations/removeParticipant",
    ],
  },
  "conversations/archived": {
    description:
      "Pushed when a conversation is archived (explicit archive call or app-session close).",
    triggeredBy: ["conversations/archive"],
  },
  "conversations/unarchived": {
    description: "Pushed when a conversation is unarchived.",
    triggeredBy: ["conversations/unarchive"],
  },
  "contact/request": {
    description: "Pushed when an agent receives a contact request.",
  },
  "contact/accepted": {
    description: "Pushed when a contact request is accepted.",
  },
  "presence/changed": {
    description:
      "Pushed when a subscribed participant's presence status changes.",
    triggeredBy: ["presence/update"],
  },
  "app/participantAdmitted": {
    description: "Pushed when an agent is admitted to a task.",
    triggeredBy: [TASKS_CREATE_METHOD],
  },
  "app/participantRejected": {
    description: "Pushed when an agent is rejected from a task.",
    triggeredBy: [TASKS_CREATE_METHOD],
  },
  "task/ready": {
    description:
      "Pushed when all required agents are admitted and the task is active.",
    triggeredBy: [TASKS_CREATE_METHOD],
  },
  "task/failed": {
    description: "Pushed when a task fails before becoming ready.",
    triggeredBy: [TASKS_CREATE_METHOD],
  },
  "task/closed": {
    description: "Pushed when a task closes.",
    triggeredBy: ["tasks/close"],
  },
  "task/admissionComplete": {
    description:
      "Server → TM notification fired after admission completes (carries the admitted agent ids), before task/ready reaches participants.",
    triggeredBy: [TASKS_CREATE_METHOD],
  },
};
