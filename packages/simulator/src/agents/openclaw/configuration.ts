/** @file Native OpenClaw configuration rendered into an application container. */

import type { AgentName } from "@moltzap/protocol/identity";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  AgentDefaultsConfig,
  ToolsConfig,
} from "openclaw/plugin-sdk/config-types";
import { Redacted } from "effect";
import {
  isHttpMcpServer,
  type McpServer,
  SIMULATOR_PROFILE_NAME,
} from "../workspace.js";

const DEFAULT_OPENCLAW_MODEL_ID = "openai/gpt-5.5";
const OPENCLAW_CHANNEL_ID = "moltzap";
const OPENCLAW_EXTENSION_NAME = "openclaw-channel";

/** Native OpenClaw tool exposure and execution configuration. */
export type OpenClawToolsConfig = ToolsConfig;

/** Native OpenClaw sandbox configuration for the runtime's default agent. */
export type OpenClawSandboxConfig = NonNullable<AgentDefaultsConfig["sandbox"]>;

interface OpenClawConfigInput {
  readonly agentName: AgentName;
  readonly modelId?: string;
  readonly mcpServers?: readonly McpServer[];
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
  readonly gatewayToken: Redacted.Redacted;
  readonly gatewayBind?: "loopback" | "lan";
  readonly channelPath?: string;
}

/**
 * Build the complete OpenClaw configuration mounted into one container.
 * @param input Runtime-specific OpenClaw settings and credentials.
 * @param workspaceDirectory Absolute workspace path inside the container.
 * @returns The native OpenClaw configuration.
 */
export function buildOpenClawConfig(
  input: OpenClawConfigInput,
  workspaceDirectory: string,
): OpenClawConfig {
  return {
    ...mcpConfigSection(input.mcpServers),
    agents: {
      defaults: {
        model: { primary: input.modelId ?? DEFAULT_OPENCLAW_MODEL_ID },
        workspace: workspaceDirectory,
        compaction: { mode: "safeguard" },
        ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
        skipBootstrap: true,
      },
      list: [{ id: input.agentName, default: true }],
    },
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    commands: { native: "auto", nativeSkills: "auto", restart: true },
    ...pluginConfiguration(input.channelPath),
    messages: {
      // Mid-turn traffic steers the active turn so social input is observed
      // without accumulating an independent simulator-owned mailbox.
      queue: { mode: "steer", debounceMs: 0, cap: 100, drop: "new" },
    },
    discovery: { mdns: { mode: "off" } },
    channels: {
      [OPENCLAW_CHANNEL_ID]: {
        accounts: [
          {
            id: SIMULATOR_PROFILE_NAME,
            agentName: input.agentName,
          },
        ],
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
  };
}

function mcpConfigSection(
  mcpServers?: readonly McpServer[],
): Pick<OpenClawConfig, "mcp"> {
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

function pluginConfiguration(
  channelPath?: string,
): Pick<OpenClawConfig, "plugins"> {
  return channelPath === undefined
    ? {}
    : {
        plugins: {
          entries: {
            [OPENCLAW_EXTENSION_NAME]: { enabled: true },
          },
          load: { paths: [channelPath] },
        },
      };
}
