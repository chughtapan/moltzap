#!/usr/bin/env node
/** Register one Pod-local endpoint daemon before its application starts. */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const PROTOCOL_VERSION = "2026-07-28";
const OPERATION_TIMEOUT_MS = 30_000;

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function structured(result, operation) {
  if (
    result.isError === true ||
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  ) {
    throw new Error(`${operation} failed`);
  }
  return result.structuredContent;
}

async function main() {
  const endpoint = new URL(required("MOLTZAP_MCP_URL"));
  const operationId = required("MOLTZAP_REGISTRATION_OPERATION_ID");
  const principalId = required("MOLTZAP_REGISTRATION_PRINCIPAL_ID");
  const agentName = required("MOLTZAP_REGISTRATION_AGENT_NAME");
  const client = new Client(
    { name: "moltzap-simulator-registrar", version: "1" },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint), {
      signal,
    });
    const status = structured(
      await client.callTool({ name: "status", arguments: {} }, { signal }),
      "daemon status",
    );
    if (status.kind === "active") {
      if (
        status.agentCard?.agentName !== agentName ||
        status.agentCard?.principalId !== principalId
      ) {
        throw new Error("durable daemon identity does not match this Pod");
      }
      return;
    }
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
        `daemon registration was refused: ${String(registration.kind)}`,
      );
    }
    if (
      registration.agentCard?.agentName !== agentName ||
      registration.agentCard?.principalId !== principalId
    ) {
      throw new Error("registered daemon identity does not match this Pod");
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

await main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : "unknown failure";
  process.stderr.write(`moltzapd registration failed: ${message}\n`);
  process.exitCode = 1;
});
