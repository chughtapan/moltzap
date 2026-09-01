/** @file Definition-time bootstrap material shared by container runtimes. */

import { Schema } from "effect";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { File } from "./container.js";

/**
 * A workspace path proven to land inside its runtime's workspace root, held in
 * the normalized form the bootstrap file is written under. Decoding happens
 * where a runtime is defined, so a path cannot escape later at render time.
 */
const workspaceRelativePath = Schema.transform(
  Schema.String,
  Schema.String.pipe(
    Schema.filter(staysBelowWorkspaceRoot, {
      identifier: "WorkspaceRelativePath",
      message: (issue) =>
        `a workspace file path must stay below the workspace root: ${String(issue.actual)}`,
    }),
    Schema.brand("WorkspaceRelativePath"),
  ),
  {
    strict: true,
    decode: (value) => posix.normalize(value),
    encode: (value) => value,
  },
);

/** A workspace path proven to land inside its runtime's workspace root. */
export type WorkspaceRelativePath = typeof workspaceRelativePath.Type;

/** One file a runtime's options ask to mount into the agent workspace. */
export interface WorkspaceFile {
  readonly relativePath: string;
  readonly content: string;
}

/** One workspace file whose path was checked when the runtime was defined. */
export interface CheckedWorkspaceFile {
  readonly relativePath: WorkspaceRelativePath;
  readonly content: string;
}

/** One stdio MCP server mounted into a runtime container's workspace. */
interface StdioMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** One remote MCP server reached over streamable HTTP. */
interface HttpMcpServer {
  readonly name: string;
  readonly url: string;
}

/** One MCP server reachable from a runtime container. */
export type McpServer = StdioMcpServer | HttpMcpServer;

/**
 * Distinguishes remote streamable-HTTP servers from spawned stdio servers.
 * @param server MCP server whose transport is being selected.
 * @returns Whether the definition carries a remote URL.
 */
export function isHttpMcpServer(server: McpServer): server is HttpMcpServer {
  return "url" in server;
}

const decodeWorkspaceRelativePath = Schema.decodeUnknownSync(
  workspaceRelativePath,
);

const mcpServerUrl = Schema.String.pipe(
  Schema.filter((value) => URL.canParse(value), {
    message: () => "an MCP server url must be a parseable absolute URL",
  }),
);

const decodeMcpServerUrl = Schema.decodeUnknownSync(mcpServerUrl);

/** Digest standing in for material a sanitized configuration must not carry. */
export const configurationDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("ConfigurationDigest"),
);

/** Digest standing in for material a sanitized configuration must not carry. */
export type ConfigurationDigest = typeof configurationDigest.Type;

/** Sanitized ledger record of one mounted workspace file. */
export class WorkspaceFileConfiguration extends Schema.Class<WorkspaceFileConfiguration>(
  "WorkspaceFileConfiguration",
)({
  relativePath: Schema.String,
  contentDigest: configurationDigest,
  redacted: Schema.Tuple(Schema.Literal("content")),
}) {}

/** Sanitized ledger record of one mounted MCP server. */
export class McpServerConfiguration extends Schema.Class<McpServerConfiguration>(
  "McpServerConfiguration",
)({
  name: Schema.String,
  definitionDigest: configurationDigest,
  redacted: Schema.Union(
    Schema.Tuple(
      Schema.Literal("command"),
      Schema.Literal("args"),
      Schema.Literal("environmentValues"),
    ),
    Schema.Tuple(Schema.Literal("url")),
  ),
}) {}

/**
 * Check and normalize every requested workspace path once, at definition time.
 * @param files Workspace files requested by a runtime's options.
 * @returns The frozen snapshot the runtime renders from.
 */
export function snapshotWorkspaceFiles(
  files?: readonly WorkspaceFile[],
): readonly CheckedWorkspaceFile[] {
  return Object.freeze(
    (files ?? []).map((file) =>
      Object.freeze({
        relativePath: decodeWorkspaceRelativePath(file.relativePath),
        content: file.content,
      }),
    ),
  );
}

/**
 * Copy the requested MCP servers so later mutation cannot reach a rendered one.
 * @param servers MCP servers requested by a runtime's options.
 * @returns The frozen snapshot, absent when no servers were requested.
 */
export function snapshotMcpServers(
  servers?: readonly McpServer[],
): readonly McpServer[] | undefined {
  return servers === undefined
    ? undefined
    : Object.freeze(
        servers.map((server) =>
          Object.freeze(
            isHttpMcpServer(server)
              ? { name: server.name, url: decodeMcpServerUrl(server.url) }
              : {
                  name: server.name,
                  command: server.command,
                  args: Object.freeze([...server.args]),
                  env: Object.freeze({ ...server.env }),
                },
          ),
        ),
      );
}

/**
 * Digest text that a sanitized configuration records instead of carrying.
 * @param value Text whose digest stands in for the text itself.
 * @returns The lowercase SHA-256 digest.
 */
export function digestText(value: string): ConfigurationDigest {
  return Schema.decodeUnknownSync(configurationDigest)(
    createHash("sha256").update(value, "utf8").digest("hex"),
  );
}

/**
 * Record which files a runtime mounts without recording their contents.
 * @param files Checked workspace files a runtime mounts.
 * @returns The sanitized workspace records.
 */
export function workspaceConfiguration(
  files: readonly CheckedWorkspaceFile[],
): readonly WorkspaceFileConfiguration[] {
  return files.map((file) =>
    WorkspaceFileConfiguration.make({
      relativePath: file.relativePath,
      contentDigest: digestText(file.content),
      redacted: ["content"],
    }),
  );
}

/**
 * Record which MCP servers a runtime mounts without recording their secrets.
 * @param servers MCP servers a runtime mounts, if any.
 * @returns The sanitized MCP server records.
 */
export function mcpConfiguration(
  servers?: readonly McpServer[],
): readonly McpServerConfiguration[] {
  return (servers ?? []).map(sanitizedMcpServer);
}

/**
 * Place one checked workspace path under a runtime's workspace root.
 * @param root Absolute workspace directory inside the container.
 * @param relativePath Path already proven to stay below that root.
 * @returns The absolute in-container path.
 */
export function workspaceFilePath(
  root: `/${string}`,
  relativePath: WorkspaceRelativePath,
): `/${string}` {
  return `${root}/${relativePath}`;
}

/**
 * One bootstrap file. Mode 0o600 because these may carry private runtime
 * configuration, gateway credentials, or tool environment values.
 * @param path Absolute in-container path the file is materialized at.
 * @param content Exact file content.
 * @returns The frozen file the run-scoped Secret materializes.
 */
export function bootstrapFile(path: `/${string}`, content: string): File {
  return Object.freeze({ path, content, mode: 0o600 });
}

function staysBelowWorkspaceRoot(value: string): boolean {
  // A backslash is an ordinary character to posix.normalize, so a Windows-style
  // separator would survive normalization and reach the container verbatim.
  if (value.includes("\\") || posix.isAbsolute(value)) {
    return false;
  }
  return value !== "." && value !== ".." && !value.startsWith("../");
}

/**
 * Sanitizes one MCP definition without retaining credential material. Stdio
 * definitions keep only environment keys; remote definitions keep only their
 * origin so capability-bearing paths cannot be confirmed from run evidence.
 * @param server MCP server whose definition is being recorded.
 * @returns The value-free configuration projection.
 */
function sanitizedMcpServer(server: McpServer): McpServerConfiguration {
  const { definition, redacted } = isHttpMcpServer(server)
    ? {
        definition: JSON.stringify({
          name: server.name,
          origin: new URL(server.url).origin,
        }),
        redacted: ["url"] as const,
      }
    : {
        definition: JSON.stringify({
          name: server.name,
          command: server.command,
          args: server.args,
          environmentKeys: Object.keys(server.env).sort((left, right) =>
            left.localeCompare(right),
          ),
        }),
        redacted: ["command", "args", "environmentValues"] as const,
      };
  return McpServerConfiguration.make({
    name: server.name,
    definitionDigest: digestText(definition),
    redacted,
  });
}
