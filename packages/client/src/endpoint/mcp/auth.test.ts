/** @file Runtime credentials cannot expose collective protocol history or owner tools. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { AgentCard } from "@moltzap/identity";
import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../../delivery/operations.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { makeFixture } from "../../__tests__/router-worker-fixtures.js";
import { HARNESS_SEND_META_KEY } from "./names.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- HTTP and JSON-RPC codes are external conformance expectations. */

const credentials = {
  runtime: Redacted.make("runtime-secret-for-local-test-0001"),
  owner: Redacted.make("owner-secret-for-local-test-00001"),
};
const info = { name: "local-dot-qualification", version: "1" };
const unreachable = () =>
  Effect.dieMessage("unauthorized tool reached its operation");
const operations: HarnessMcpOperations = {
  readEvent: () => Effect.fail({ reason: "unknown-event" }),
  protocolActive: () => false,
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
const eventStore: EventStore = {
  readEventState: () => Effect.succeed(undefined),
  writeEventState: () => Effect.void,
  readInbox: unreachable,
  readInboxItem: () => Effect.succeed(undefined),
  readInboxSummary: () =>
    Effect.succeed({ pendingCount: 0, newestSequence: 0 }),
  completeWebhookDelivery: () => Effect.void,
};
type RequestParams = Readonly<Record<string, unknown>> &
  Partial<Record<"_meta", Readonly<Record<string, unknown>>>>;
const makeRequest = (
  method: string,
  params: RequestParams,
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
          ...params._meta,
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
  params: RequestParams,
  credential: Redacted.Redacted,
) =>
  Effect.tryPromise(() =>
    handler.fetch(makeRequest(method, params, Redacted.value(credential))),
  ).pipe(Effect.flatMap(responseBody));
const decodeJson = Schema.decodeUnknown(Schema.parseJson(Schema.Unknown));
const noCredential = Redacted.make("");
const deniedTools = [
  "read_inbox",
  "read_send",
  "acknowledge_delivery",
  "read_conversation",
  "search_conversations",
  "status",
  "register",
  "event_subscription_status",
  "revoke_event_subscription",
  "resume_event_subscription",
];
const rejectedBearers = [
  { bearer: "no", credential: "" },
  { bearer: "a wrong", credential: "wrong" },
];
const invalidIdempotencyKeys = [
  { key: "an empty", idempotencyKey: "" },
  { key: "a control-character", idempotencyKey: "x\u0000y" },
  { key: "an oversized", idempotencyKey: "é".repeat(65) },
];
const unknownEvent = {
  name: "read_event",
  arguments: { eventId: digest("evt_", 1) },
};

/** The tools each credential role sees, sorted, before and after registration. */
const registrationStates = [
  {
    state: "unregistered",
    registered: false,
    runtimeTools: [],
    ownerTools: [
      "event_subscription_status",
      "register",
      "resume_event_subscription",
      "revoke_event_subscription",
      "status",
    ],
    localTools: ["register", "status"],
  },
  {
    state: "registered",
    registered: true,
    runtimeTools: ["read_event", "search_agents", "send_message"],
    ownerTools: [
      "acknowledge_delivery",
      "event_subscription_status",
      "read_conversation",
      "read_event",
      "read_inbox",
      "read_send",
      "resume_event_subscription",
      "revoke_event_subscription",
      "search_agents",
      "search_conversations",
      "send_message",
      "status",
    ],
    localTools: [
      "acknowledge_delivery",
      "read_conversation",
      "read_event",
      "read_inbox",
      "read_send",
      "search_agents",
      "search_conversations",
      "send_message",
      "status",
    ],
  },
];

/**
 * A handler for a daemon in the given registration state. With `credentials`
 * it authenticates runtime and owner bearers and serves webhook events;
 * without them every request is local.
 */
const acquireHandler = (
  registered: boolean,
  access: Pick<
    Parameters<typeof makeHarnessMcpHttpHandler>[0],
    "credentials" | "eventStore"
  >,
) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const agentCard = yield* Schema.encode(AgentCard)(fixture.localCard);
    const handler = yield* makeHarnessMcpHttpHandler({
      implementation: info,
      ...access,
      operations: {
        ...operations,
        protocolActive: () => registered,
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
    return handler;
  });

const credentialedHandler = (registered: boolean) =>
  acquireHandler(registered, { credentials, eventStore });

/**
 * Given a handler from `given`, run `when` against it and check its result
 * with `then`.
 */
const verify = <A, E>(
  given: ReturnType<typeof credentialedHandler>,
  when: (handler: Handler) => Effect.Effect<A, E>,
  then: (result: A) => void,
) =>
  Effect.runPromise(
    Effect.scoped(given.pipe(Effect.flatMap(when), Effect.map(then))),
  );

const callTool = (
  handler: Handler,
  params: RequestParams,
  credential: Redacted.Redacted,
) =>
  request(handler, "tools/call", params, credential).pipe(
    Effect.flatMap(decodeJson),
  );

const listTools = (handler: Handler, credential: Redacted.Redacted) =>
  request(handler, "tools/list", {}, credential).pipe(
    Effect.flatMap(Schema.decodeUnknown(toolNames)),
    Effect.map((catalog) =>
      catalog.result.tools
        .map((tool) => tool.name)
        .sort((left, right) => left.localeCompare(right)),
    ),
  );

const responseStatus = (
  handler: Handler,
  method: string,
  params: RequestParams,
  credential: string,
) =>
  Effect.tryPromise(() =>
    handler.fetch(makeRequest(method, params, credential)),
  ).pipe(Effect.map((response) => response.status));

// @agent-code-guard/regression-only: direct calls and discovery must enforce the same authority before and after registration.
describe.each(registrationStates)(
  "runtime tool authority for a daemon that is $state",
  ({ registered, runtimeTools }) => {
    it.each(rejectedBearers)(
      "refuses discovery with $bearer bearer",
      ({ credential }) =>
        verify(
          credentialedHandler(registered),
          (handler) =>
            responseStatus(handler, "server/discover", {}, credential),
          (status) => {
            expect(status).toBe(401);
          },
        ),
    );

    it("lists exactly the runtime tools to the runtime credential", () =>
      verify(
        credentialedHandler(registered),
        (handler) => listTools(handler, credentials.runtime),
        (names) => {
          expect(names).toEqual(runtimeTools);
        },
      ));

    it.each(deniedTools)(
      "refuses the runtime credential a call to %s",
      (name) =>
        verify(
          credentialedHandler(registered),
          (handler) =>
            callTool(handler, { name, arguments: {} }, credentials.runtime),
          (body) => {
            expect(body).toMatchObject({
              error: { code: -32602, message: `Tool ${name} not found` },
            });
          },
        ),
    );
  },
);

describe.each(registrationStates)(
  "runtime event authority for a daemon that is $state",
  ({ registered }) => {
    it("lists only the webhook item event to the runtime credential", () =>
      verify(
        credentialedHandler(registered),
        (handler) =>
          request(handler, "events/list", {}, credentials.runtime).pipe(
            Effect.flatMap(decodeJson),
          ),
        (catalog) => {
          expect(catalog).toMatchObject({
            result: {
              events: [{ name: "moltzap.inbox.item", delivery: ["webhook"] }],
            },
          });
        },
      ));

    it("refuses the runtime credential a native inbox stream", () =>
      verify(
        credentialedHandler(registered),
        (handler) =>
          request(
            handler,
            "events/stream",
            { name: "moltzap.inbox.pending", arguments: {} },
            credentials.runtime,
          ).pipe(Effect.flatMap(decodeJson)),
        (refused) => {
          expect(refused).toMatchObject({
            error: { code: -32014, data: { feature: "stream" } },
          });
        },
      ));
  },
);

describe.each(registrationStates)(
  "owner and local authority for a daemon that is $state",
  ({ registered, ownerTools, localTools }) => {
    it("lets the owner credential read the event subscription status", () =>
      verify(
        credentialedHandler(registered),
        (handler) =>
          callTool(
            handler,
            { name: "event_subscription_status", arguments: {} },
            credentials.owner,
          ),
        (body) => {
          expect(body).toMatchObject({
            result: { structuredContent: { mode: "none" } },
          });
        },
      ));

    it("lists exactly the owner tools to the owner credential", () =>
      verify(
        credentialedHandler(registered),
        (handler) => listTools(handler, credentials.owner),
        (names) => {
          expect(names).toEqual(ownerTools);
        },
      ));

    it("lists exactly the local tools to an unauthenticated local handler", () =>
      verify(
        acquireHandler(registered, {}),
        (handler) => listTools(handler, noCredential),
        (names) => {
          expect(names).toEqual(localTools);
        },
      ));
  },
);

/**
 * Calls a non-runtime catalog does not list, by caller and registration
 * state. Each named tool reaches an operation or event that would answer if
 * it were admitted, so only admission yields "not found".
 */
const unlistedCalls = [
  {
    caller: "the local handler",
    state: "unregistered",
    name: "read_inbox",
    given: () => acquireHandler(false, {}),
    credential: noCredential,
  },
  {
    caller: "the local handler",
    state: "unregistered",
    name: "event_subscription_status",
    given: () => acquireHandler(false, {}),
    credential: noCredential,
  },
  {
    caller: "the local handler",
    state: "registered",
    name: "register",
    given: () => acquireHandler(true, {}),
    credential: noCredential,
  },
  {
    caller: "the local handler",
    state: "registered",
    name: "resume_event_subscription",
    given: () => acquireHandler(true, {}),
    credential: noCredential,
  },
  {
    caller: "the owner credential",
    state: "unregistered",
    name: "search_agents",
    given: () => credentialedHandler(false),
    credential: credentials.owner,
  },
  {
    caller: "the owner credential",
    state: "unregistered",
    name: "read_send",
    given: () => credentialedHandler(false),
    credential: credentials.owner,
  },
  {
    caller: "the owner credential",
    state: "registered",
    name: "register",
    given: () => credentialedHandler(true),
    credential: credentials.owner,
  },
];

// @agent-code-guard/regression-only: admission must refuse exactly what the caller's catalog does not list.
describe("calls a caller's catalog does not list", () => {
  it.each(unlistedCalls)(
    "refuses $caller a call to $name while $state",
    ({ name, given, credential }) =>
      verify(
        given(),
        (handler) => callTool(handler, { name, arguments: {} }, credential),
        (body) => {
          expect(body).toMatchObject({
            error: { code: -32602, message: `Tool ${name} not found` },
          });
        },
      ),
  );
});

describe.each(invalidIdempotencyKeys)(
  "tunneled MCP invocation identity with $key key",
  ({ idempotencyKey }) => {
    it("refuses the runtime credential's send_message", () =>
      verify(
        credentialedHandler(true),
        (handler) =>
          callTool(
            handler,
            {
              name: "send_message",
              arguments: { input: { to: "agent:bob", text: "probe" } },
              _meta: { [HARNESS_SEND_META_KEY]: { idempotencyKey } },
            },
            credentials.runtime,
          ),
        (body) => {
          expect(body).toMatchObject({ error: { code: -32602 } });
        },
      ));

    it("refuses the owner credential's read_send", () =>
      verify(
        credentialedHandler(true),
        (handler) =>
          callTool(
            handler,
            { name: "read_send", arguments: { idempotencyKey } },
            credentials.owner,
          ),
        (body) => {
          expect(body).toMatchObject({ error: { code: -32602 } });
        },
      ));
  },
);

describe("tunneled MCP event reads for a registered daemon", () => {
  it.each(rejectedBearers)(
    "refuses read_event with $bearer bearer",
    ({ credential }) =>
      verify(
        credentialedHandler(true),
        (handler) =>
          responseStatus(handler, "tools/call", unknownEvent, credential),
        (status) => {
          expect(status).toBe(401);
        },
      ),
  );

  it("reports an unknown event to the runtime credential", () =>
    verify(
      credentialedHandler(true),
      (handler) => callTool(handler, unknownEvent, credentials.runtime),
      (body) => {
        expect(body).toMatchObject({
          error: { data: { reason: "unknown-event" } },
        });
      },
    ));
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
