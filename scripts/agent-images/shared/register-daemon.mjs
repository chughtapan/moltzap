#!/usr/bin/env node
/** Register the image-local daemon before starting the agent host. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_TIMEOUT_MILLIS = 30_000;
const CONNECT_RETRY_MILLIS = 100;

function required(environment, name) {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error("missing " + name);
  }
  return value;
}

function structured(result, operation) {
  if (
    result.isError === true ||
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  ) {
    throw new Error(operation + " failed");
  }
  return result.structuredContent;
}

function delay(millis) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, millis));
}

async function defaultDependencies() {
  const { Client, StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/client"
  );
  return {
    clientFactory: () =>
      new Client(
        { name: "moltzap-agent-image-registrar", version: "1" },
        { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
      ),
    transportFactory: (endpoint) => new StreamableHTTPClientTransport(endpoint),
  };
}

async function connect(clientFactory, transportFactory, endpoint, deadline) {
  let lastFailure;
  while (Date.now() < deadline) {
    const client = clientFactory();
    const remaining = Math.max(1, deadline - Date.now());
    try {
      await client.connect(transportFactory(endpoint), {
        signal: AbortSignal.timeout(remaining),
      });
      return client;
    } catch (cause) {
      lastFailure = cause;
      await client.close().catch(() => undefined);
      await delay(Math.min(CONNECT_RETRY_MILLIS, remaining));
    }
  }
  throw new Error("daemon MCP listener did not become ready", {
    cause: lastFailure,
  });
}

/**
 * Register a daemon by using its existing management tools.
 *
 * An active daemon is already bootstrapped. An unregistered daemon receives
 * exactly one registration request; every other response is a startup error.
 *
 * @param options Environment and optional test seams.
 */
export async function registerDaemon({
  environment = process.env,
  clientFactory,
  transportFactory,
  timeoutMillis = DEFAULT_TIMEOUT_MILLIS,
} = {}) {
  const endpoint = new URL(required(environment, "MOLTZAP_MCP_URL"));
  const operationId = required(
    environment,
    "MOLTZAP_REGISTRATION_OPERATION_ID",
  );
  const principalId = required(
    environment,
    "MOLTZAP_REGISTRATION_PRINCIPAL_ID",
  );
  const agentName = required(environment, "MOLTZAP_REGISTRATION_AGENT_NAME");
  const deadline = Date.now() + timeoutMillis;
  const defaults =
    clientFactory === undefined || transportFactory === undefined
      ? await defaultDependencies()
      : undefined;
  const client = await connect(
    clientFactory ?? defaults.clientFactory,
    transportFactory ?? defaults.transportFactory,
    endpoint,
    deadline,
  );
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  try {
    const status = structured(
      await client.callTool({ name: "status", arguments: {} }, { signal }),
      "daemon status",
    );
    if (status.kind === "active") return;
    if (status.kind !== "unregistered") {
      throw new Error("daemon returned an invalid status");
    }
    const registration = structured(
      await client.callTool(
        {
          name: "register",
          arguments: { operationId, principalId, agentName },
        },
        { signal },
      ),
      "daemon registration",
    );
    if (registration.kind !== "registered") {
      throw new Error(
        "daemon registration was refused: " + String(registration.kind),
      );
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  await registerDaemon();
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((cause) => {
    const message = cause instanceof Error ? cause.message : "unknown failure";
    process.stderr.write("moltzapd registration failed: " + message + "\n");
    process.exitCode = 1;
  });
}
