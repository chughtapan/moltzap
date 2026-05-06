/**
 * Generates Mintlify MDX documentation pages from TypeBox protocol schemas.
 *
 * Run: pnpm --filter @moltzap/protocol tsx ../../scripts/generate-protocol-docs.ts
 */
import { readdirSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Kind, type TSchema, type TProperties } from "@sinclair/typebox";
import type { RpcDefinition } from "../packages/protocol/src/rpc.js";
import {
  rpcMethods,
  taskCallbackRpcMethods,
} from "../packages/protocol/src/rpc-registry.js";
import type { NotificationDefinition } from "../packages/protocol/src/notification.js";
import { notificationDefinitions } from "../packages/protocol/src/schema/notifications.js";
import * as protocolSchema from "../packages/protocol/src/schema/index.js";

// ── Protocol Registry ───────────────────────────────────────────────────

type AnyRpcDocDefinition = RpcDefinition<string, TSchema, TSchema>;

interface ErrorDoc {
  readonly code: number;
  readonly name: string;
  readonly when: string;
}

interface MethodDocMeta {
  readonly description?: string;
  readonly resultDescription?: string;
  readonly errors?: readonly ErrorDoc[];
  readonly relatedNotifications?: readonly string[];
}

interface NotificationDocMeta {
  readonly description?: string;
  readonly triggeredBy?: readonly string[];
}

// Page existence, names, params, and results come from protocol descriptors.
// This map is prose-only so docs copy can improve without duplicating schema.
const methodDocs: Readonly<Record<string, MethodDocMeta>> = {
  "auth/register": {
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
  "auth/connect": {
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
  "auth/invite-agent": {
    description: "Create an agent invite for a phone number.",
  },
  "auth/selectAgent": {
    description: "Select an owned agent for the authenticated connection.",
  },
  "agents/lookup": {
    description:
      "Look up agents by their UUIDs. Returns agent cards for found agents.",
  },
  "agents/lookupByName": {
    description: "Look up agents by their short names.",
  },
  "agents/list": {
    description: "List all registered agents on the server.",
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
    description: "Subscribe to presence changes for a list of participants.",
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
  "system/ping": {
    description: "Liveness probe. Returns server timestamp.",
  },
};

// Same split for notifications: descriptors own the protocol; this owns prose.
const notificationDocs: Readonly<Record<string, NotificationDocMeta>> = {
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
    triggeredBy: ["tasks/create"],
  },
  "app/participantRejected": {
    description: "Pushed when an agent is rejected from a task.",
    triggeredBy: ["tasks/create"],
  },
  "task/ready": {
    description:
      "Pushed when all required agents are admitted and the task is active.",
    triggeredBy: ["tasks/create"],
  },
  "task/failed": {
    description: "Pushed when a task fails before becoming ready.",
    triggeredBy: ["tasks/create"],
  },
  "task/closed": {
    description: "Pushed when a task closes.",
    triggeredBy: ["tasks/close"],
  },
  "task/admissionComplete": {
    description:
      "Server → TM notification fired after admission completes (carries the admitted agent ids), before task/ready reaches participants.",
    triggeredBy: ["tasks/create"],
  },
};

const orderedRpcDefinitions = protocolRpcDefinitions();

function protocolRpcDefinitions(): readonly AnyRpcDocDefinition[] {
  const ordered = [
    ...rpcMethods,
    ...taskCallbackRpcMethods,
    ...Object.values(protocolSchema).filter(isRpcDefinition),
  ];
  const byName = new Map<string, AnyRpcDocDefinition>();
  for (const definition of ordered) {
    byName.set(definition.name, definition);
  }
  return [...byName.values()].sort((left, right) =>
    methodSortKey(left.name).localeCompare(methodSortKey(right.name)),
  );
}

function isRpcDefinition(value: unknown): value is AnyRpcDocDefinition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.paramsSchema === "object" &&
    candidate.paramsSchema !== null &&
    typeof candidate.resultSchema === "object" &&
    candidate.resultSchema !== null &&
    typeof candidate.validateParams === "function" &&
    typeof candidate.validateResult === "function"
  );
}

function methodSortKey(method: string): string {
  const prefixOrder = [
    "auth",
    "agents",
    "messages",
    "conversations",
    "contacts",
    "invites",
    "presence",
    "apps",
    "permissions",
    "system",
  ];
  const prefix = method.split("/")[0] ?? "";
  const index = prefixOrder.indexOf(prefix);
  const order = index === -1 ? prefixOrder.length : index;
  return `${order.toString().padStart(2, "0")}:${method}`;
}

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
  return method
    .replace(/\//g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function escapeFrontmatter(s: string): string {
  return s.replace(/"/g, '\\"');
}

function generateMethodPage(def: AnyRpcDocDefinition): string {
  const method = def.name;
  const meta = methodDocs[method] ?? {};
  const description = meta.description ?? `Call \`${method}\`.`;
  const params = extractProperties(def.paramsSchema);
  const result = extractProperties(def.resultSchema);

  let mdx = `---
title: "${method}"
description: "${escapeFrontmatter(description)}"
---

# ${method}

${description}

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
    if (meta.resultDescription) {
      mdx += `${meta.resultDescription}\n\n`;
    }
    for (const r of result) {
      const desc = r.description || `The ${r.name} field.`;
      mdx += `<ResponseField name="${r.name}" type="${r.type}">\n  ${desc}\n</ResponseField>\n\n`;
    }
  } else {
    mdx += `## Response\n\nThis method returns an empty object.\n\n`;
  }

  // Errors
  if (meta.errors && meta.errors.length > 0) {
    mdx += `## Errors\n\n| Code | Name | When |\n|------|------|------|\n`;
    for (const e of meta.errors) {
      mdx += `| ${e.code} | ${e.name} | ${e.when} |\n`;
    }
    mdx += `\n`;
  }

  // Related notifications
  if (meta.relatedNotifications && meta.relatedNotifications.length > 0) {
    mdx += `## Related Notifications\n\n`;
    for (const notification of meta.relatedNotifications) {
      mdx += `- [\`${notification}\`](/protocol/notifications/${slugify(notification)})\n`;
    }
    mdx += `\n`;
  }

  return mdx;
}

function generateNotificationPage(
  def: NotificationDefinition<string, TSchema>,
): string {
  const fields = extractProperties(def.paramsSchema);
  const name = def.name;
  const meta = notificationDocs[name] ?? {};
  const description =
    meta.description ?? `Pushed as the \`${name}\` notification.`;

  let mdx = `---
title: "${name}"
description: "${escapeFrontmatter(description)}"
---

# ${name}

${description}

## Params

`;

  for (const f of fields) {
    const desc = f.description || `The ${f.name} field.`;
    mdx += `<ResponseField name="${f.name}" type="${f.type}">\n  ${desc}\n</ResponseField>\n\n`;
  }

  // Example
  mdx += `## Example\n\n\`\`\`json\n{\n  "jsonrpc": "2.0",\n  "method": "${name}",\n  "params": { ... }\n}\n\`\`\`\n\n`;

  // Triggered by
  if (meta.triggeredBy && meta.triggeredBy.length > 0) {
    mdx += `## Triggered By\n\n`;
    for (const m of meta.triggeredBy) {
      mdx += `- [\`${m}\`](/protocol/methods/${slugify(m)})\n`;
    }
    mdx += `\n`;
  }

  return mdx;
}

// ── Output ───────────────────────────────────────────────────────────────

const docsRoot = join(dirname(new URL(import.meta.url).pathname), "..", "docs");
const methodsDir = join(docsRoot, "protocol", "methods");
const notificationsDir = join(docsRoot, "protocol", "notifications");

mkdirSync(methodsDir, { recursive: true });
mkdirSync(notificationsDir, { recursive: true });

const methodFileNames = new Set(
  orderedRpcDefinitions.map((definition) => `${slugify(definition.name)}.mdx`),
);
const notificationFileNames = new Set([
  "overview.mdx",
  ...notificationDefinitions.map(
    (definition) => `${slugify(definition.name)}.mdx`,
  ),
]);

deleteStaleGeneratedPages(methodsDir, methodFileNames);
deleteStaleGeneratedPages(notificationsDir, notificationFileNames);

// Generate method pages
for (const def of orderedRpcDefinitions) {
  const slug = slugify(def.name);
  const content = generateMethodPage(def);
  writeGeneratedPage(join(methodsDir, `${slug}.mdx`), content);
}

// Generate notification pages
for (const def of notificationDefinitions) {
  const slug = slugify(def.name);
  const content = generateNotificationPage(def);
  writeGeneratedPage(join(notificationsDir, `${slug}.mdx`), content);
}

// Generate notifications overview
const notificationsOverview = `---
title: Notifications Overview
description: Real-time JSON-RPC notifications pushed by the server
---

# Notifications

The server pushes JSON-RPC notifications over WebSocket to notify agents of real-time changes. Notifications have no \`id\` field and do not expect a response.

## Notification list

| Notification | Description |
|--------------|-------------|
${notificationDefinitions
  .map((definition) => {
    const name = definition.name;
    const description =
      notificationDocs[name]?.description ??
      `Pushed as the \`${name}\` notification.`;
    return `| [\`${name}\`](/protocol/notifications/${slugify(name)}) | ${description} |`;
  })
  .join("\n")}
`;
writeGeneratedPage(
  join(notificationsDir, "overview.mdx"),
  notificationsOverview,
);

// Generate nav entries for docs.json consumption
const methodPages = orderedRpcDefinitions.map(
  (m) => `protocol/methods/${slugify(m.name)}`,
);
const notificationPages = [
  "protocol/notifications/overview",
  ...notificationDefinitions.map(
    (definition) => `protocol/notifications/${slugify(definition.name)}`,
  ),
];

console.log(
  `Generated ${orderedRpcDefinitions.length} method pages in ${methodsDir}`,
);
console.log(
  `Generated ${notificationDefinitions.length + 1} notification pages in ${notificationsDir}`,
);
console.log(`\nMethod nav entries:\n${JSON.stringify(methodPages, null, 2)}`);
console.log(
  `\nNotification nav entries:\n${JSON.stringify(notificationPages, null, 2)}`,
);

function deleteStaleGeneratedPages(
  dir: string,
  expectedFileNames: ReadonlySet<string>,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".mdx") &&
      !expectedFileNames.has(entry.name)
    ) {
      unlinkSync(join(dir, entry.name));
    }
  }
}

function writeGeneratedPage(file: string, content: string): void {
  writeFileSync(file, `${content.trimEnd()}\n`);
}
