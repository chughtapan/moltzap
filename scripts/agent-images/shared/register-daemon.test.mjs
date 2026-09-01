import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDaemon } from "./register-daemon.mjs";

const environment = Object.freeze({
  MOLTZAP_MCP_URL: "http://127.0.0.1:43117/mcp",
  MOLTZAP_REGISTRATION_AGENT_NAME: "alice",
  MOLTZAP_REGISTRATION_OPERATION_ID: "operation",
  MOLTZAP_REGISTRATION_PRINCIPAL_ID: "principal",
});
const transportFactory = (endpoint) => endpoint;

function result(structuredContent) {
  return { structuredContent };
}

test("an active daemon needs no registration request", async () => {
  const calls = [];
  const client = {
    async connect() {},
    async callTool(input) {
      calls.push(input);
      return result({ kind: "active" });
    },
    async close() {},
  };

  await registerDaemon({
    environment,
    clientFactory: () => client,
    transportFactory,
  });

  assert.deepEqual(calls, [{ name: "status", arguments: {} }]);
});

test("an unregistered daemon receives the existing registration request", async () => {
  const calls = [];
  const client = {
    async connect() {},
    async callTool(input) {
      calls.push(input);
      return calls.length === 1
        ? result({ kind: "unregistered" })
        : result({ kind: "registered" });
    },
    async close() {},
  };

  await registerDaemon({
    environment,
    clientFactory: () => client,
    transportFactory,
  });

  assert.deepEqual(calls, [
    { name: "status", arguments: {} },
    {
      name: "register",
      arguments: {
        agentName: "alice",
        operationId: "operation",
        principalId: "principal",
      },
    },
  ]);
});

test("registration refusal fails bootstrap", async () => {
  let call = 0;
  const client = {
    async connect() {},
    async callTool() {
      call += 1;
      return result({
        kind: call === 1 ? "unregistered" : "operation_rejected",
      });
    },
    async close() {},
  };

  await assert.rejects(
    registerDaemon({
      environment,
      clientFactory: () => client,
      transportFactory,
    }),
    /registration was refused: operation_rejected/u,
  );
});

test("listener startup is retried only within the bootstrap deadline", async () => {
  let attempts = 0;
  const clientFactory = () => ({
    async connect() {
      attempts += 1;
      throw new Error("not listening");
    },
    async close() {},
  });

  await assert.rejects(
    registerDaemon({
      environment,
      clientFactory,
      transportFactory,
      timeoutMillis: 20,
    }),
    /listener did not become ready/u,
  );
  assert.ok(attempts >= 1);
});
