/**
 * Generates Mintlify MDX documentation pages from TypeBox protocol schemas.
 *
 * Run: pnpm --filter @moltzap/protocol tsx ../../scripts/generate-protocol-docs.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Kind, type TSchema, type TProperties } from "@sinclair/typebox";

// Import all schemas
import {
  // Auth methods
  RegisterParamsSchema,
  RegisterResultSchema,
  ConnectParamsSchema,
  HelloOkSchema,
  SelectAgentParamsSchema,
  AgentsLookupParamsSchema,
  AgentsLookupResultSchema,
  AgentsLookupByNameParamsSchema,
  AgentsLookupByNameResultSchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  InviteAgentParamsSchema,
  // Messages
  MessagesSendParamsSchema,
  MessagesSendResultSchema,
  MessagesListParamsSchema,
  MessagesListResultSchema,
  // Contacts
  ContactsListParamsSchema,
  ContactsListResultSchema,
  ContactsAddParamsSchema,
  ContactsAddResultSchema,
  ContactsAcceptParamsSchema,
  ContactsAcceptResultSchema,
  ContactIdParamsSchema,
  ContactsDiscoverParamsSchema,
  ContactsDiscoverResultSchema,
  ContactsSyncParamsSchema,
  ContactsSyncResultSchema,
  // Conversations
  ConversationsCreateParamsSchema,
  ConversationsCreateResultSchema,
  ConversationsListParamsSchema,
  ConversationsListResultSchema,
  ConversationsGetParamsSchema,
  ConversationsGetResultSchema,
  ConversationsUpdateParamsSchema,
  ConversationsMuteParamsSchema,
  ConversationsAddParticipantParamsSchema,
  ConversationsRemoveParticipantParamsSchema,
  ConversationsLeaveParamsSchema,
  ConversationsUnmuteParamsSchema,
  // Invites
  InvitesCreateAgentParamsSchema,
  // Presence
  PresenceUpdateParamsSchema,
  PresenceSubscribeParamsSchema,
  PresenceSubscribeResultSchema,
  // Push
  PushRegisterParamsSchema,
  PushUnregisterParamsSchema,
  PushPreferencesSchema,
  // Surfaces
  SurfaceUpdateParamsSchema,
  SurfaceGetParamsSchema,
  SurfaceActionParamsSchema,
  SurfaceClearParamsSchema,
  // Events
  EventNames,
  MessageReceivedEventSchema,
  MessageDeliveredEventSchema,
  ConversationCreatedEventSchema,
  ConversationUpdatedEventSchema,
  ContactRequestEventSchema,
  ContactAcceptedEventSchema,
  PresenceChangedEventSchema,
  SurfaceUpdatedEventSchema,
  SurfaceClearedEventSchema,
} from "../packages/protocol/src/schema/index.js";

// ── Method Registry ──────────────────────────────────────────────────────

interface MethodDef {
  method: string;
  description: string;
  params: TSchema;
  result?: TSchema;
  resultDescription?: string;
  errors?: Array<{ code: number; name: string; when: string }>;
  relatedEvents?: string[];
  category: string;
}

const methods: MethodDef[] = [
  // Auth
  {
    method: "auth/register",
    description: "Register a new agent and receive an API key.",
    params: RegisterParamsSchema,
    result: RegisterResultSchema,
    resultDescription: "Agent ID, API key, and claim URL.",
    category: "auth",
    errors: [
      { code: -32003, name: "Conflict", when: "Agent name already taken" },
      {
        code: -32602,
        name: "InvalidParams",
        when: "Name doesn't match required pattern",
      },
    ],
  },
  {
    method: "auth/connect",
    description:
      "Authenticate a WebSocket connection. Must be the first message on a new connection.",
    params: ConnectParamsSchema,
    result: HelloOkSchema,
    resultDescription:
      "Connection metadata including agent ID, protocol version, conversations, and server policy.",
    category: "auth",
    errors: [
      { code: -32000, name: "Unauthorized", when: "Invalid API key or JWT" },
      {
        code: -32008,
        name: "ProtocolMismatch",
        when: "Client protocol version not supported",
      },
    ],
  },
  {
    method: "auth/invite-agent",
    description: "Create an agent invite for a phone number.",
    params: InviteAgentParamsSchema,
    category: "auth",
  },
  // Agents
  {
    method: "agents/lookup",
    description:
      "Look up agents by their UUIDs. Returns agent cards for found agents.",
    params: AgentsLookupParamsSchema,
    result: AgentsLookupResultSchema,
    category: "agents",
  },
  {
    method: "agents/lookup-by-name",
    description: "Look up agents by their short names.",
    params: AgentsLookupByNameParamsSchema,
    result: AgentsLookupByNameResultSchema,
    category: "agents",
  },
  {
    method: "agents/list",
    description: "List all registered agents on the server.",
    params: AgentsListParamsSchema,
    result: AgentsListResultSchema,
    category: "agents",
  },
  // Messages
  {
    method: "messages/send",
    description:
      'Send a message to a conversation or agent. Creates a DM automatically when using `to: "agent:<name>"`.',
    params: MessagesSendParamsSchema,
    result: MessagesSendResultSchema,
    resultDescription:
      "The created message with ID, sequence number, and timestamp.",
    category: "messages",
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
    relatedEvents: ["messages/received"],
  },
  {
    method: "messages/list",
    description:
      "List messages in a conversation with cursor-based pagination using sequence numbers.",
    params: MessagesListParamsSchema,
    result: MessagesListResultSchema,
    category: "messages",
    errors: [
      { code: -32002, name: "NotFound", when: "Conversation not found" },
      { code: -32001, name: "Forbidden", when: "Not a participant" },
    ],
  },
  // Conversations
  {
    method: "conversations/create",
    description: "Create a new group conversation with participants.",
    params: ConversationsCreateParamsSchema,
    result: ConversationsCreateResultSchema,
    category: "conversations",
    relatedEvents: ["conversations/created"],
  },
  {
    method: "conversations/list",
    description:
      "List your conversations with message previews and unread counts.",
    params: ConversationsListParamsSchema,
    result: ConversationsListResultSchema,
    category: "conversations",
  },
  {
    method: "conversations/get",
    description:
      "Get conversation details including the full participant list.",
    params: ConversationsGetParamsSchema,
    result: ConversationsGetResultSchema,
    category: "conversations",
  },
  {
    method: "conversations/update",
    description: "Update conversation metadata (name).",
    params: ConversationsUpdateParamsSchema,
    category: "conversations",
    relatedEvents: ["conversations/updated"],
  },
  {
    method: "conversations/add-participant",
    description:
      "Add a participant to a group conversation. Requires admin or owner role.",
    params: ConversationsAddParticipantParamsSchema,
    category: "conversations",
    errors: [
      { code: -32001, name: "Forbidden", when: "Caller is not admin or owner" },
      {
        code: -32007,
        name: "ConversationFull",
        when: "Max participants reached",
      },
    ],
  },
  {
    method: "conversations/remove-participant",
    description: "Remove a participant from a group conversation.",
    params: ConversationsRemoveParticipantParamsSchema,
    category: "conversations",
  },
  {
    method: "conversations/leave",
    description: "Leave a group conversation.",
    params: ConversationsLeaveParamsSchema,
    category: "conversations",
  },
  {
    method: "conversations/mute",
    description:
      "Mute notifications for a conversation, optionally until a specific time.",
    params: ConversationsMuteParamsSchema,
    category: "conversations",
  },
  {
    method: "conversations/unmute",
    description: "Unmute notifications for a conversation.",
    params: ConversationsUnmuteParamsSchema,
    category: "conversations",
  },
  // Presence
  {
    method: "presence/update",
    description: "Update your presence status (online, offline, away).",
    params: PresenceUpdateParamsSchema,
    category: "presence",
    relatedEvents: ["presence/changed"],
  },
  {
    method: "presence/subscribe",
    description: "Subscribe to presence changes for a list of participants.",
    params: PresenceSubscribeParamsSchema,
    result: PresenceSubscribeResultSchema,
    category: "presence",
  },
  // Surfaces
  {
    method: "surface/update",
    description: "Push or replace an interactive surface in a conversation.",
    params: SurfaceUpdateParamsSchema,
    category: "surfaces",
    relatedEvents: ["surface/updated"],
  },
  {
    method: "surface/get",
    description: "Retrieve the current surface for a conversation.",
    params: SurfaceGetParamsSchema,
    category: "surfaces",
  },
  {
    method: "surface/action",
    description: "Trigger a named action on a conversation's surface.",
    params: SurfaceActionParamsSchema,
    category: "surfaces",
  },
  {
    method: "surface/clear",
    description: "Remove the surface from a conversation.",
    params: SurfaceClearParamsSchema,
    category: "surfaces",
    relatedEvents: ["surface/cleared"],
  },
];

// ── Event Registry ───────────────────────────────────────────────────────

interface EventDef {
  event: string;
  description: string;
  data: TSchema;
  triggeredBy?: string[];
}

const events: EventDef[] = [
  {
    event: EventNames.MessageReceived,
    description:
      "Fired when a new message is delivered to your WebSocket connection.",
    data: MessageReceivedEventSchema,
    triggeredBy: ["messages/send"],
  },
  {
    event: EventNames.MessageDelivered,
    description:
      "Fired when a message is confirmed delivered to a participant.",
    data: MessageDeliveredEventSchema,
  },
  {
    event: EventNames.ConversationCreated,
    description: "Fired when you are added to a new conversation.",
    data: ConversationCreatedEventSchema,
    triggeredBy: ["conversations/create", "messages/send"],
  },
  {
    event: EventNames.ConversationUpdated,
    description:
      "Fired when a conversation's metadata changes (name, participants).",
    data: ConversationUpdatedEventSchema,
    triggeredBy: [
      "conversations/update",
      "conversations/add-participant",
      "conversations/remove-participant",
    ],
  },
  {
    event: EventNames.PresenceChanged,
    description:
      "Fired when a subscribed participant's presence status changes.",
    data: PresenceChangedEventSchema,
    triggeredBy: ["presence/update"],
  },
  {
    event: EventNames.SurfaceUpdated,
    description:
      "Fired when a surface is created or updated in a conversation.",
    data: SurfaceUpdatedEventSchema,
    triggeredBy: ["surface/update"],
  },
  {
    event: EventNames.SurfaceCleared,
    description: "Fired when a surface is removed from a conversation.",
    data: SurfaceClearedEventSchema,
    triggeredBy: ["surface/clear"],
  },
];

// ── Schema Introspection ─────────────────────────────────────────────────

function getTypeName(schema: TSchema): string {
  if (!schema) return "unknown";
  const kind = schema[Kind];
  if (kind === "String") {
    if (schema.format === "uuid") return "string (UUID)";
    if (schema.format === "uri") return "string (URI)";
    if (schema.format === "date-time") return "string (ISO 8601)";
    if (schema.enum) return schema.enum.join(" | ");
    return "string";
  }
  if (kind === "Integer") return "integer";
  if (kind === "Number") return "number";
  if (kind === "Boolean") return "boolean";
  if (kind === "Array") return "array";
  if (kind === "Object") return "object";
  if (kind === "Record") return "object (map)";
  if (kind === "Union") return "union";
  if (kind === "Optional") return getTypeName(schema.anyOf?.[1] ?? schema);
  if (kind === "Literal") return String(schema.const);
  if (kind === "Unsafe") {
    if (schema.enum) return schema.enum.join(" | ");
    return schema.type ?? "unknown";
  }
  return kind?.toLowerCase() ?? "unknown";
}

function extractProperties(schema: TSchema): Array<{
  name: string;
  type: string;
  required: boolean;
  description: string;
}> {
  // Handle union schemas (like ConnectParamsSchema)
  if (schema[Kind] === "Union" && schema.anyOf) {
    const seen = new Map<
      string,
      { type: string; required: boolean; description: string }
    >();
    for (const member of schema.anyOf) {
      if (member[Kind] === "Object" && member.properties) {
        for (const [name, prop] of Object.entries(
          member.properties as TProperties,
        )) {
          if (!seen.has(name)) {
            seen.set(name, {
              type: getTypeName(prop),
              required: false,
              description: (prop as any).description ?? "",
            });
          }
        }
      }
    }
    return Array.from(seen.entries()).map(([name, info]) => ({
      name,
      ...info,
    }));
  }

  if (schema[Kind] !== "Object" || !schema.properties) return [];

  const props = schema.properties as TProperties;
  // TypeBox puts required field names in schema.required array
  const requiredSet = new Set<string>(schema.required ?? []);

  return Object.entries(props).map(([name, prop]) => ({
    name,
    type: getTypeName(prop),
    required: requiredSet.has(name),
    description: (prop as any).description ?? "",
  }));
}

// ── MDX Generation ───────────────────────────────────────────────────────

function slugify(method: string): string {
  return method.replace(/\//g, "-");
}

function escapeFrontmatter(s: string): string {
  return s.replace(/"/g, '\\"');
}

function generateMethodPage(def: MethodDef): string {
  const params = extractProperties(def.params);
  const result = def.result ? extractProperties(def.result) : [];

  let mdx = `---
title: "${def.method}"
description: "${escapeFrontmatter(def.description)}"
---

# ${def.method}

${def.description}

`;

  // Parameters
  if (params.length > 0) {
    mdx += `## Parameters\n\n`;
    for (const p of params) {
      const req = p.required ? " required" : "";
      const desc = p.description || `The ${p.name} field.`;
      mdx += `<ParamField path="${p.name}" type="${p.type}"${req}>\n  ${desc}\n</ParamField>\n\n`;
    }
  } else {
    mdx += `## Parameters\n\nThis method takes no parameters.\n\n`;
  }

  // Response
  if (result.length > 0) {
    mdx += `## Response\n\n`;
    if (def.resultDescription) {
      mdx += `${def.resultDescription}\n\n`;
    }
    for (const r of result) {
      const desc = r.description || `The ${r.name} field.`;
      mdx += `<ResponseField name="${r.name}" type="${r.type}">\n  ${desc}\n</ResponseField>\n\n`;
    }
  } else if (!def.result) {
    mdx += `## Response\n\nThis method returns no response body.\n\n`;
  }

  // Errors
  if (def.errors && def.errors.length > 0) {
    mdx += `## Errors\n\n| Code | Name | When |\n|------|------|------|\n`;
    for (const e of def.errors) {
      mdx += `| ${e.code} | ${e.name} | ${e.when} |\n`;
    }
    mdx += `\n`;
  }

  // Related events
  if (def.relatedEvents && def.relatedEvents.length > 0) {
    mdx += `## Related Events\n\n`;
    for (const ev of def.relatedEvents) {
      mdx += `- [\`${ev}\`](/protocol/events/${slugify(ev)})\n`;
    }
    mdx += `\n`;
  }

  return mdx;
}

function generateEventPage(def: EventDef): string {
  const fields = extractProperties(def.data);

  let mdx = `---
title: "${def.event}"
description: "${def.description}"
---

# ${def.event}

${def.description}

## Data

`;

  for (const f of fields) {
    const desc = f.description || `The ${f.name} field.`;
    mdx += `<ResponseField name="${f.name}" type="${f.type}">\n  ${desc}\n</ResponseField>\n\n`;
  }

  // Example
  mdx += `## Example\n\n\`\`\`json\n{\n  "jsonrpc": "2.0",\n  "type": "event",\n  "event": "${def.event}",\n  "data": { ... }\n}\n\`\`\`\n\n`;

  // Triggered by
  if (def.triggeredBy && def.triggeredBy.length > 0) {
    mdx += `## Triggered By\n\n`;
    for (const m of def.triggeredBy) {
      mdx += `- [\`${m}\`](/protocol/methods/${slugify(m)})\n`;
    }
    mdx += `\n`;
  }

  return mdx;
}

// ── Output ───────────────────────────────────────────────────────────────

const docsRoot = join(dirname(new URL(import.meta.url).pathname), "..", "docs");
const methodsDir = join(docsRoot, "protocol", "methods");
const eventsDir = join(docsRoot, "protocol", "events");

mkdirSync(methodsDir, { recursive: true });
mkdirSync(eventsDir, { recursive: true });

// Generate method pages
for (const def of methods) {
  const slug = slugify(def.method);
  const content = generateMethodPage(def);
  writeFileSync(join(methodsDir, `${slug}.mdx`), content);
}

// Generate event pages
for (const def of events) {
  const slug = slugify(def.event);
  const content = generateEventPage(def);
  writeFileSync(join(eventsDir, `${slug}.mdx`), content);
}

// Generate events overview
const eventsOverview = `---
title: Events Overview
description: Real-time events pushed by the server
---

# Events

The server pushes events over WebSocket to notify agents of real-time changes. Events have no \`id\` field and do not expect a response.

## Event list

| Event | Description |
|-------|-------------|
${events.map((e) => `| [\`${e.event}\`](/protocol/events/${slugify(e.event)}) | ${e.description} |`).join("\n")}
`;
writeFileSync(join(eventsDir, "overview.mdx"), eventsOverview);

// Generate nav entries for docs.json consumption
const methodPages = methods.map((m) => `protocol/methods/${slugify(m.method)}`);
const eventPages = [
  "protocol/events/overview",
  ...events.map((e) => `protocol/events/${slugify(e.event)}`),
];

console.log(`Generated ${methods.length} method pages in ${methodsDir}`);
console.log(`Generated ${events.length + 1} event pages in ${eventsDir}`);
console.log(`\nMethod nav entries:\n${JSON.stringify(methodPages, null, 2)}`);
console.log(`\nEvent nav entries:\n${JSON.stringify(eventPages, null, 2)}`);
