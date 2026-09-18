/// <reference types="node" preserve="true" />

/**
 * @file OpenClaw configuration written into an application container.
 * OpenClaw's configuration declarations import Node types without preserving
 * that dependency in emitted declarations. The reference keeps packed
 * consumer typechecks self-contained.
 */

import type { AgentName } from "@moltzap/identity";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Redacted } from "effect";
import type { CredentialName } from "../container.js";
import { isHttpMcpServer, type McpServer } from "../workspace.js";

/** Model OpenClaw runs when a runtime names none. */
export const DEFAULT_OPENCLAW_MODEL_ID = "openai/gpt-5.5";
/** OpenClaw auth profile that carries the forwarded Claude Code token. */
const OPENCLAW_ANTHROPIC_TOKEN_PROFILE = "anthropic:default";
/** Environment variable the token profile references; never its value. */
const CLAUDE_CODE_OAUTH_TOKEN: CredentialName = "CLAUDE_CODE_OAUTH_TOKEN";
const OPENCLAW_CHANNEL_ID = "moltzap";
const OPENCLAW_ACCOUNT_ID = "simulator-agent";
const OPENCLAW_EXTENSION_NAME = "openclaw-channel";
/** Shared by OpenClaw's logging configuration and native artifact collection. */
export const OPENCLAW_RUNTIME_LOG_FILE = ".openclaw-runtime.log";
/** OpenClaw's bundled Agent2Agent channel plugin, which the simulator does not use. */
const OPENCLAW_A2A_PLUGIN_ID = "a2a";
const OPENCLAW_EXTENSION_PATH =
  "/opt/moltzap/node_modules/@moltzap/openclaw-channel";

/** Tool configuration accepted by `OpenClawConfig`. */
export type OpenClawToolsConfig = NonNullable<OpenClawConfig["tools"]>;

/** Default-agent sandbox configuration accepted by `OpenClawConfig`. */
export type OpenClawSandboxConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["sandbox"]
>;

interface OpenClawConfigInput {
  readonly agentName: AgentName;
  readonly bootstrapChars?: number;
  readonly messagingMode: "shared" | "private";
  readonly modelId?: string;
  /** Harness selected for the model; absent leaves OpenClaw's own resolver in charge. */
  readonly agentRuntime?: "claude-cli";
  readonly mcpServers?: readonly McpServer[];
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
  readonly gatewayToken: Redacted.Redacted;
  readonly gatewayBind?: "loopback" | "lan";
}

/**
 * Builds the OpenClaw configuration mounted into an application container.
 * @param input Runtime-specific OpenClaw settings and credentials.
 * @param workspaceDirectory Absolute workspace path inside the container.
 * @returns The complete `OpenClawConfig` for the container.
 */
export function buildOpenClawConfig(
  input: OpenClawConfigInput,
  workspaceDirectory: string,
): OpenClawConfig {
  const config = {
    ...mcpConfigSection(input.mcpServers),
    logging: {
      level: "debug",
      file: `${workspaceDirectory}/${OPENCLAW_RUNTIME_LOG_FILE}`,
      maxFileBytes: 1024 ** 4,
    },
    agents: {
      defaults: {
        ...modelConfiguration(input),
        workspace: workspaceDirectory,
        compaction: { mode: "safeguard" },
        ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
        skipBootstrap: true,
        ...bootstrapBudget(input.bootstrapChars),
      },
      list: [{ id: input.agentName, default: true }],
    },
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...authConfiguration(input.agentRuntime),
    ...(input.messagingMode === "private"
      ? { session: { dmScope: "per-account-channel-peer" as const } }
      : {}),
    commands: { native: "auto", nativeSkills: "auto", restart: true },
    ...pluginConfiguration(),
    ...messagingConfiguration(),
    discovery: { mdns: { mode: "off" } },
    channels: {
      [OPENCLAW_CHANNEL_ID]: {
        accounts: [{ id: OPENCLAW_ACCOUNT_ID, mode: input.messagingMode }],
      },
    },
    gateway: {
      mode: "local",
      bind: input.gatewayBind ?? "loopback",
      auth: {
        mode: "token",
        token: Redacted.value(input.gatewayToken),
      },
    },
  } satisfies OpenClawConfig;
  return config;
}

/**
 * The `openclaw secrets apply` plan that stores a reference-only token profile
 * for one agent. The plan names the environment variable and never carries a
 * value, so it is safe to render before the run's credentials are known.
 * @param agentName Agent whose OpenClaw auth store receives the profile.
 * @returns Serialized plan for the pod's host wrapper to apply before the gateway starts.
 */
export function buildOpenClawSecretsPlan(agentName: AgentName): string {
  return JSON.stringify(
    {
      version: 1,
      protocolVersion: 1,
      targets: [
        {
          type: "auth-profiles.token.token",
          path: `profiles.${OPENCLAW_ANTHROPIC_TOKEN_PROFILE}.token`,
          agentId: agentName,
          authProfileProvider: "anthropic",
          ref: {
            source: "env",
            provider: "default",
            id: CLAUDE_CODE_OAUTH_TOKEN,
          },
        },
      ],
    },
    null,
    2,
  );
}

/**
 * Mid-turn traffic steers the active turn so social input is observed without
 * accumulating an independent simulator-owned mailbox. Visible replies come
 * only from the `message` tool; final text stays private, and the channel
 * plugin withholds it as well.
 */
function messagingConfiguration() {
  return {
    messages: {
      queue: { mode: "steer" as const, cap: 100, drop: "new" as const },
      inbound: { debounceMs: 0 },
      visibleReplies: "message_tool" as const,
    },
  };
}

/**
 * An explicitly selected harness wins. Otherwise Codex's restricted tool
 * surface omits user MCP servers, so MCP-backed runs select OpenClaw's
 * embedded harness and the supplied tool policy can retain those tools
 * without granting unrelated native tools.
 */
function modelConfiguration(input: OpenClawConfigInput) {
  const modelId = input.modelId ?? DEFAULT_OPENCLAW_MODEL_ID;
  const harness =
    input.agentRuntime ??
    (input.mcpServers === undefined || input.mcpServers.length === 0
      ? undefined
      : "openclaw");
  return {
    model: { primary: modelId },
    ...(harness === undefined
      ? {}
      : { models: { [modelId]: { agentRuntime: { id: harness } } } }),
  };
}

/**
 * Claude Code authenticates through a stored OpenClaw token profile, which the
 * `claude-cli` backend forwards to the child over a file descriptor. The
 * profile itself is created at pod start from the secrets plan; the
 * configuration only names it and orders it first.
 */
function authConfiguration(agentRuntime: OpenClawConfigInput["agentRuntime"]) {
  if (agentRuntime !== "claude-cli") {
    return {};
  }
  return {
    auth: {
      profiles: {
        [OPENCLAW_ANTHROPIC_TOKEN_PROFILE]: {
          provider: "anthropic",
          mode: "token" as const,
        },
      },
      order: { anthropic: [OPENCLAW_ANTHROPIC_TOKEN_PROFILE] },
    },
  };
}

function mcpConfigSection(mcpServers?: readonly McpServer[]) {
  if (mcpServers === undefined || mcpServers.length === 0) {
    return {};
  }
  return {
    mcp: {
      servers: Object.fromEntries(
        mcpServers.map((server) => [
          server.name,
          isHttpMcpServer(server)
            ? { transport: "streamable-http" as const, url: server.url }
            : {
                transport: "stdio" as const,
                command: server.command,
                args: [...server.args],
                env: { ...server.env },
              },
        ]),
      ),
    },
  };
}

/**
 * Load the MoltZap channel adapter and leave OpenClaw's built-in Agent2Agent
 * channel out of the tool set. With both present, the `message` tool offers
 * two channels for the same peers and a model that reaches for `a2a` first
 * fails twice before finding MoltZap, or never does; every simulator peer is
 * reachable through MoltZap alone.
 */
function pluginConfiguration() {
  return {
    plugins: {
      load: { paths: [OPENCLAW_EXTENSION_PATH] },
      entries: {
        [OPENCLAW_EXTENSION_NAME]: { enabled: true },
        [OPENCLAW_A2A_PLUGIN_ID]: { enabled: false },
      },
    },
  };
}

function bootstrapBudget(chars?: number) {
  return chars === undefined
    ? {}
    : {
        bootstrapMaxChars: Math.max(20_000, chars + 1024),
        bootstrapTotalMaxChars: Math.max(150_000, chars + 1024),
      };
}
