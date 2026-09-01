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
import { isHttpMcpServer, type McpServer } from "../workspace.js";

const DEFAULT_OPENCLAW_MODEL_ID = "openai/gpt-5.5";
const OPENCLAW_CHANNEL_ID = "moltzap";
const OPENCLAW_ACCOUNT_ID = "simulator-agent";
const OPENCLAW_EXTENSION_NAME = "openclaw-channel";
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
  readonly messagingMode: "shared" | "private";
  readonly modelId?: string;
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
    ...(input.messagingMode === "private"
      ? { session: { dmScope: "per-account-channel-peer" as const } }
      : {}),
    commands: { native: "auto", nativeSkills: "auto", restart: true },
    ...pluginConfiguration(),
    messages: {
      // Mid-turn traffic steers the active turn so social input is observed
      // without accumulating an independent simulator-owned mailbox.
      queue: { mode: "steer", cap: 100, drop: "new" },
      inbound: { debounceMs: 0 },
    },
    discovery: { mdns: { mode: "off" } },
    channels: {
      [OPENCLAW_CHANNEL_ID]: {
        accounts: [{ id: OPENCLAW_ACCOUNT_ID }],
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

function pluginConfiguration() {
  return {
    plugins: {
      load: { paths: [OPENCLAW_EXTENSION_PATH] },
      entries: {
        [OPENCLAW_EXTENSION_NAME]: { enabled: true },
      },
    },
  };
}
