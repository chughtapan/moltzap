/**
 * Generates Mintlify MDX documentation pages from TypeBox protocol schemas.
 *
 * Run from the package or repository root with `pnpm docs:generate`.
 */
import { readdirSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { notificationDefinitions } from "../src/rpc-registry.js";
import { notificationDocs } from "./docs/metadata.js";
import {
  generateMethodPage,
  generateNotificationPage,
  slugify,
} from "./docs/render.js";
import { protocolRpcDefinitions } from "./docs/schema.js";
import { JSON_INDENT } from "./docs/types.js";

const orderedRpcDefinitions = protocolRpcDefinitions();
const scriptDir = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(scriptDir, "..", "..", "..", "docs");
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

for (const def of orderedRpcDefinitions) {
  const slug = slugify(def.name);
  const content = generateMethodPage(def);
  writeGeneratedPage(join(methodsDir, `${slug}.mdx`), content);
}

for (const def of notificationDefinitions) {
  const slug = slugify(def.name);
  const content = generateNotificationPage(def);
  writeGeneratedPage(join(notificationsDir, `${slug}.mdx`), content);
}

writeGeneratedPage(
  join(notificationsDir, "overview.mdx"),
  renderNotificationsOverview(),
);

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
console.log(
  `\nMethod nav entries:\n${JSON.stringify(methodPages, null, JSON_INDENT)}`,
);
console.log(
  `\nNotification nav entries:\n${JSON.stringify(notificationPages, null, JSON_INDENT)}`,
);

function renderNotificationsOverview(): string {
  return [
    "---",
    "title: Notifications Overview",
    "description: Real-time JSON-RPC notifications pushed by the server",
    "---",
    "",
    "# Notifications",
    "",
    "The server pushes JSON-RPC notifications over WebSocket to notify agents of real-time changes. Notifications have no `id` field and do not expect a response.",
    "",
    "## Notification list",
    "",
    "| Notification | Description |",
    "|--------------|-------------|",
    ...notificationDefinitions.map(renderNotificationOverviewRow),
    "",
  ].join("\n");
}

function renderNotificationOverviewRow(definition: {
  readonly name: string;
}): string {
  const name = definition.name;
  const description =
    notificationDocs[name]?.description ??
    `Pushed as the \`${name}\` notification.`;
  return `| [\`${name}\`](/protocol/notifications/${slugify(name)}) | ${description} |`;
}

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
