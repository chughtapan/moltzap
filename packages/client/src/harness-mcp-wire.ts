/** @file Private daemon MCP projection of semantic START, reply, and turns. */

import type { Ed25519PublicKey } from "@moltzap/identity";
import {
  createMcpHandler,
  fromJsonSchema,
  type Implementation,
  type JsonSchemaType,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { Effect } from "effect";
import type { Content } from "./contract.js";
import {
  type HarnessMcpSubscriptionHandler,
  makeHarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";
import {
  decodeHarnessReplyRoute,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_REPLY_TOOL,
  HARNESS_START_TOOL,
  type HarnessEmptyResult,
  harnessEmptyResultJsonSchema,
  type HarnessReplyInput,
  harnessReplyInputJsonSchema,
  type HarnessStartInput,
  harnessStartInputJsonSchema,
  type HarnessTurnEvent,
} from "./harness-runtime.js";

/* eslint-disable agent-code-guard/async-keyword -- Official MCP tool callbacks are Promise-native. */

type StartHandler = (input: HarnessStartInput) => Effect.Effect<void, unknown>;
type ReplyHandler = (
  replyGrant: string,
  content: Content,
) => Effect.Effect<void, unknown>;

/** Daemon capabilities projected onto its loopback MCP server. */
interface HarnessMcpHandlerOptions {
  readonly implementation: Implementation;
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly reply: ReplyHandler;
  readonly start: StartHandler;
}
const startInput = fromJsonSchema<HarnessStartInput>(
  // Safe because the Effect schema generator and MCP SDK describe the same immutable JSON input.
  harnessStartInputJsonSchema as JsonSchemaType,
);
const replyInput = fromJsonSchema<HarnessReplyInput>(
  // Safe because the Effect schema generator and MCP SDK describe the same immutable JSON input.
  harnessReplyInputJsonSchema as JsonSchemaType,
);
const emptyOutput = fromJsonSchema<HarnessEmptyResult>(
  // Safe because the Effect schema generator and MCP SDK describe the same empty JSON result.
  harnessEmptyResultJsonSchema as JsonSchemaType,
);

const emptyToolResult = () => {
  const structuredContent: HarnessEmptyResult = {};
  return {
    content: [{ type: "text" as const, text: "{}" }],
    structuredContent,
  };
};

const readReason = (
  cause: unknown,
  allowed: ReadonlySet<string>,
  fallback: string,
): string => {
  if (typeof cause !== "object" || cause === null || !("reason" in cause)) {
    return fallback;
  }
  const reason: unknown = cause.reason;
  return typeof reason === "string" && allowed.has(reason) ? reason : fallback;
};

interface OperationOptions {
  readonly operation: Effect.Effect<void, unknown>;
  readonly label: string;
  readonly allowed: ReadonlySet<string>;
  readonly fallback: string;
  readonly signal: AbortSignal;
}

// #ignore-sloppy-code-next-line[async-keyword]: Official MCP callbacks are Promise-native.
const runOperation = async (options: OperationOptions) => {
  const { operation, label, allowed, fallback, signal } = options;
  try {
    await Effect.runPromise(operation, { signal });
    return emptyToolResult();
  } catch (cause) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `${label} failed`,
      { reason: readReason(cause, allowed, fallback) },
    );
  }
};

const START_REASONS = new Set([
  "intent-conflict",
  "not-registered",
  "membership",
  "persistence",
  "durability",
  "reanchor",
  "representation",
]);
const REPLY_REASONS = new Set([
  "authority-unavailable",
  "persistence",
  "durability",
  "reanchor",
  "representation",
]);

const registerStartTool = (server: McpServer, start: StartHandler): void => {
  server.registerTool(
    HARNESS_START_TOOL,
    { inputSchema: startInput, outputSchema: emptyOutput },
    (input, context) =>
      runOperation({
        operation: start(input),
        label: "Conversation start",
        allowed: START_REASONS,
        fallback: "representation",
        signal: context.mcpReq.signal,
      }),
  );
};

const registerReplyTool = (server: McpServer, reply: ReplyHandler): void => {
  server.registerTool(
    HARNESS_REPLY_TOOL,
    { inputSchema: replyInput, outputSchema: emptyOutput },
    // #ignore-sloppy-code-next-line[async-keyword]: Official MCP callbacks are Promise-native.
    async (input, context) => {
      const route = await Effect.runPromise(
        decodeHarnessReplyRoute(context.mcpReq._meta),
        { signal: context.mcpReq.signal },
      );
      return await runOperation({
        operation: reply(route.replyGrant, input.content),
        label: "Reply",
        allowed: REPLY_REASONS,
        fallback: "authority-unavailable",
        signal: context.mcpReq.signal,
      });
    },
  );
};

const makeActiveServer = (options: HarnessMcpHandlerOptions): McpServer => {
  const server = new McpServer(options.implementation, {
    capabilities: {
      extensions: {
        [HARNESS_EVENTS_EXTENSION]: {
          registrySignerPublicKey: {
            crv: options.registrySignerPublicKey.crv,
            kty: options.registrySignerPublicKey.kty,
            x: options.registrySignerPublicKey.x,
          },
        },
      },
    },
  });
  registerStartTool(server, options.start);
  registerReplyTool(server, options.reply);
  return server;
};

/**
 * Create the daemon's active loopback MCP handler.
 * @param options Capabilities exposed by the configured local daemon.
 * @returns The active-agent subscription handler mounted at `/mcp`.
 */
export const makeHarnessMcpHttpHandler = (
  options: HarnessMcpHandlerOptions,
): HarnessMcpSubscriptionHandler<HarnessTurnEvent> => {
  const activeDelegate = createMcpHandler(() => makeActiveServer(options), {
    legacy: "reject",
  });
  return makeHarnessMcpSubscriptionHandler({
    delegate: activeDelegate,
    implementation: options.implementation,
  });
};

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults. */
