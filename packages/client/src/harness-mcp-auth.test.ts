/** @file Runtime credentials cannot expose collective protocol history or owner tools. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { AgentCard } from "@moltzap/identity";
import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeFixture } from "./__tests__/router-worker-fixtures.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./harness-mcp-wire.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- HTTP and JSON-RPC codes are external conformance expectations. */

const credentials = {
  runtime: Redacted.make("runtime-secret-for-local-test-0001"),
  owner: Redacted.make("owner-secret-for-local-test-00001"),
};
const info = { name: "local-dot-qualification", version: "1" };
const unreachable = () =>
  Effect.dieMessage("unauthorized tool reached its operation");
const operations: HarnessMcpOperations = {
  readStatus: () => Effect.succeed({ kind: "unregistered" }),
  register: unreachable,
  searchAgents: () => Effect.succeed({ kind: "not_found" }),
  searchConversations: unreachable,
  readConversation: unreachable,
  send: unreachable,
  readInbox: () => Effect.succeed({ items: [] }),
  readInboxSummary: () =>
    Effect.succeed({ pendingCount: 0, newestSequence: 0 }),
  readSend: () => Effect.succeed({ state: "absent" }),
  acknowledgeDelivery: unreachable,
};
const makeRequest = (
  method: string,
  params: Readonly<Record<string, unknown>>,
  credential: string,
) =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      ...(credential === "" ? {} : { authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          [CLIENT_INFO_META_KEY]: info,
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        },
      },
    }),
  });
const toolNames = Schema.parseJson(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  }),
);
const responseBody = (response: Response) =>
  Effect.tryPromise(() => response.text());

type Handler = Effect.Effect.Success<
  ReturnType<typeof makeHarnessMcpHttpHandler>
>;
const request = (
  handler: Handler,
  method: string,
  params: Readonly<Record<string, unknown>>,
  credential: Redacted.Redacted,
) =>
  Effect.tryPromise(() =>
    handler.fetch(makeRequest(method, params, Redacted.value(credential))),
  ).pipe(Effect.flatMap(responseBody));
const deniedTools = [
  "read_conversation",
  "search_conversations",
  "status",
  "register",
  "event_subscription_status",
  "revoke_event_subscription",
  "resume_event_subscription",
];

const checksRestrictedTools = (handler: Handler) =>
  Effect.gen(function* () {
    for (const name of deniedTools) {
      const body = yield* request(
        handler,
        "tools/call",
        { name, arguments: {} },
        credentials.runtime,
      ).pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))),
      );
      expect(body, name).toMatchObject({ error: { code: -32602 } });
    }
    const owner = yield* request(
      handler,
      "tools/call",
      { name: "event_subscription_status", arguments: {} },
      credentials.owner,
    ).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))),
    );
    expect(owner).toMatchObject({
      result: { structuredContent: { mode: "none" } },
    });
  });

const checksInvocationValidation = (handler: Handler) =>
  Effect.gen(function* () {
    for (const idempotencyKey of ["", "x\u0000y", "é".repeat(65)]) {
      for (const name of ["send_message", "read_send"]) {
        const args =
          name === "read_send"
            ? { idempotencyKey }
            : { idempotencyKey, input: { to: "agent:bob", text: "probe" } };
        const body = yield* request(
          handler,
          "tools/call",
          { name, arguments: args },
          credentials.runtime,
        ).pipe(
          Effect.flatMap(
            Schema.decodeUnknown(Schema.parseJson(Schema.Unknown)),
          ),
        );
        expect(body).toMatchObject({ error: { code: -32602 } });
      }
    }
  });

const checksCatalog = (handler: Handler, registered: boolean) =>
  Effect.gen(function* () {
    for (const credential of ["", "wrong"]) {
      const response = yield* Effect.tryPromise(() =>
        handler.fetch(makeRequest("server/discover", {}, credential)),
      );
      expect(response.status).toBe(401);
    }
    const catalog = yield* request(
      handler,
      "tools/list",
      {},
      credentials.runtime,
    ).pipe(Effect.flatMap(Schema.decodeUnknown(toolNames)));
    const names = catalog.result.tools.map((tool) => tool.name);
    for (const denied of deniedTools) {
      expect(names).not.toContain(denied);
    }
    yield* checksRestrictedTools(handler);
    if (registered) {
      expect(names).toEqual(
        expect.arrayContaining([
          "acknowledge_delivery",
          "read_inbox",
          "read_send",
          "search_agents",
          "send_message",
        ]),
      );
      yield* checksInvocationValidation(handler);
    } else {
      expect(names).toHaveLength(0);
    }
  });
const restrictsEveryDispatch = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
        for (const registered of [false, true]) {
          const handler = yield* makeHarnessMcpHttpHandler({
            implementation: info,
            credentials,
            operations: {
              ...operations,
              readStatus: () =>
                Effect.succeed(
                  registered
                    ? { kind: "active", agentCard }
                    : { kind: "unregistered" },
                ),
            },
          });
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise(() => handler.close()).pipe(Effect.ignore),
          );
          yield* checksCatalog(handler, registered);
        }
      }),
    ),
  );

// @agent-code-guard/regression-only: direct calls and discovery must enforce the same authority before and after registration.
describe("tunneled MCP authority", () => {
  it(
    "authenticates every request and keeps raw history and administration owner-only",
    restrictsEveryDispatch,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
