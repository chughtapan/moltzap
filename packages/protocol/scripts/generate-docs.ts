/**
 * @file Generates Mintlify MDX documentation pages from TypeBox
 * schemas + JSDoc on the matching `defineRpc` / `defineNotification`
 * call sites. Run from the package or repository root with
 * `pnpm docs:generate`.
 */
import { FileSystem, Path } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notificationDefinitions } from "#socket/catalog";
import {
  generateMethodPage,
  generateNotificationPage,
  slugify,
} from "./docs/render.js";
import { collectRpcJsDoc, type RpcJsDoc } from "./docs/rpc-jsdoc.js";
import { protocolRpcDefinitions } from "./docs/schema.js";
import { JSON_INDENT } from "./docs/types.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..", "..", "..");

const PROTOCOL_SOURCE_FILES = [
  "packages/protocol/src/identity/apps/manifest.ts",
  "packages/protocol/src/identity/agents/agents.ts",
  "packages/protocol/src/identity/agents/registration.ts",
  "packages/protocol/src/identity/contacts/contacts.ts",
  "packages/protocol/src/network/connect.ts",
  "packages/protocol/src/network/presence.ts",
  "packages/protocol/src/conversation/conversations.ts",
  "packages/protocol/src/message/messages.ts",
  "packages/protocol/src/message/dispatch.ts",
  "packages/protocol/src/task/tasks.ts",
];

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const docsRoot = path.resolve(workspaceRoot, "docs");
  const methodsDir = path.resolve(docsRoot, "protocol", "methods");
  const notificationsDir = path.resolve(docsRoot, "protocol", "notifications");

  const jsdocMap = yield* collectRpcJsDoc(workspaceRoot, PROTOCOL_SOURCE_FILES);
  const orderedRpcDefinitions = protocolRpcDefinitions();
  yield* fs.makeDirectory(methodsDir, { recursive: true });
  yield* fs.makeDirectory(notificationsDir, { recursive: true });

  const methodFileNames = new Set(
    orderedRpcDefinitions.map((d) => `${slugify(d.name)}.mdx`),
  );
  const notificationFileNames = new Set([
    "overview.mdx",
    ...notificationDefinitions.map((d) => `${slugify(d.name)}.mdx`),
  ]);
  yield* deleteStaleGeneratedPages(fs, path, methodsDir, methodFileNames);
  yield* deleteStaleGeneratedPages(
    fs,
    path,
    notificationsDir,
    notificationFileNames,
  );

  for (const def of orderedRpcDefinitions) {
    const slug = slugify(def.name);
    const content = generateMethodPage(def, jsdocMap.get(def.name));
    yield* writeGeneratedPage(
      fs,
      path.resolve(methodsDir, `${slug}.mdx`),
      content,
    );
  }
  for (const def of notificationDefinitions) {
    const slug = slugify(def.name);
    const content = generateNotificationPage(def, jsdocMap.get(def.name));
    yield* writeGeneratedPage(
      fs,
      path.resolve(notificationsDir, `${slug}.mdx`),
      content,
    );
  }
  yield* writeGeneratedPage(
    fs,
    path.resolve(notificationsDir, "overview.mdx"),
    renderNotificationsOverview(jsdocMap),
  );

  const methodPages = orderedRpcDefinitions.map(
    (m) => `protocol/methods/${slugify(m.name)}`,
  );
  const notificationPages = [
    "protocol/notifications/overview",
    ...notificationDefinitions.map(
      (d) => `protocol/notifications/${slugify(d.name)}`,
    ),
  ];

  yield* Effect.log(
    `Generated ${orderedRpcDefinitions.length} method pages in ${methodsDir}`,
  );
  yield* Effect.log(
    `Generated ${notificationDefinitions.length + 1} notification pages in ${notificationsDir}`,
  );
  yield* Effect.log(
    `Method nav entries: ${JSON.stringify(methodPages, null, JSON_INDENT)}`,
  );
  yield* Effect.log(
    `Notification nav entries: ${JSON.stringify(notificationPages, null, JSON_INDENT)}`,
  );
}).pipe(Effect.withSpan("generate-docs"));

function renderNotificationsOverview(
  jsdocMap: ReadonlyMap<string, RpcJsDoc>,
): string {
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
    ...notificationDefinitions.map((d) =>
      renderNotificationOverviewRow(d, jsdocMap),
    ),
    "",
  ].join("\n");
}

function renderNotificationOverviewRow(
  definition: { readonly name: string },
  jsdocMap: ReadonlyMap<string, RpcJsDoc>,
): string {
  const name = definition.name;
  const description =
    jsdocMap.get(name)?.description ??
    `Pushed as the \`${name}\` notification.`;
  const oneLine = description.replace(/\s+/g, " ").trim();
  const firstSentence = oneLine.split(". ")[0] ?? "";
  const summary = firstSentence + (oneLine.includes(". ") ? "." : "");
  return `| [\`${name}\`](/protocol/notifications/${slugify(name)}) | ${summary} |`;
}

function deleteStaleGeneratedPages(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
  expectedFileNames: ReadonlySet<string>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    for (const name of entries) {
      if (!name.endsWith(".mdx")) {
        continue;
      }
      if (expectedFileNames.has(name)) {
        continue;
      }
      yield* fs
        .remove(path.resolve(dir, name))
        .pipe(Effect.catchAll(() => Effect.void));
    }
  });
}

function writeGeneratedPage(
  fs: FileSystem.FileSystem,
  file: string,
  content: string,
): Effect.Effect<void> {
  return fs
    .writeFileString(file, `${content.trimEnd()}\n`)
    .pipe(Effect.catchAll(() => Effect.void));
}

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)));
