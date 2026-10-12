/** @file Runtime credentials cannot expose collective protocol history or owner tools. */

import { scopedLive as it } from "@effect/vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { AgentCard } from "@moltzap/identity";
import { Effect, Redacted, Schema } from "effect";
import { describe, expect } from "vitest";
import type { EventStore } from "../../delivery/operations.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { makeFixture } from "../../__tests__/router-worker-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import {
  enqueue,
  input,
  scriptedWebhook,
} from "../../__tests__/webhook-fixtures.js";
import { openEndpointStore } from "../../store/index.js";
import { decodePollResult } from "../event-contract/index.js";
import { HARNESS_SEND_META_KEY } from "./names.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "./tools.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- HTTP and JSON-RPC codes are external conformance expectations. */

const credentials = {
  runtime: Redacted.make("runtime-secret-for-local-test-0001"),
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
  acknowledgeDelivery: () => Effect.void,
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
  handler: Pick<Handler, "fetch">,
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
  {
    bearer: "a retired owner",
    credential: "owner-secret-for-local-test-00001",
  },
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
 * it authenticates one runtime bearer and serves webhook events; management
 * dispatch belongs to the private socket. Without credentials every request
 * on the loopback handler is local.
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
) => given.pipe(Effect.flatMap(when), Effect.map(then));

const callTool = (
  handler: Handler,
  params: RequestParams,
  credential: Redacted.Redacted,
  management = false,
) =>
  request(
    management ? handler.management : handler,
    "tools/call",
    params,
    credential,
  ).pipe(Effect.flatMap(decodeJson));

const listTools = (
  handler: Handler,
  credential: Redacted.Redacted,
  management = false,
) =>
  request(
    management ? handler.management : handler,
    "tools/list",
    {},
    credential,
  ).pipe(
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
    it("lists the shared poll and webhook item event to the runtime credential", () =>
      verify(
        credentialedHandler(registered),
        (handler) =>
          request(handler, "events/list", {}, credentials.runtime).pipe(
            Effect.flatMap(decodeJson),
          ),
        (catalog) => {
          expect(catalog).toMatchObject({
            result: {
              events: [
                { name: "moltzap.inbox.item", delivery: ["poll", "webhook"] },
              ],
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
    it("lets private management read the event subscription status without a bearer", () =>
      verify(
        credentialedHandler(registered),
        (handler) =>
          callTool(
            handler,
            { name: "event_subscription_status", arguments: {} },
            noCredential,
            true,
          ),
        (body) => {
          expect(body).toMatchObject({
            result: { structuredContent: { mode: "none" } },
          });
        },
      ));

    it("lists exactly the owner tools through private management", () =>
      verify(
        credentialedHandler(registered),
        (handler) => listTools(handler, noCredential, true),
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
    caller: "private management",
    state: "unregistered",
    name: "search_agents",
    given: () => credentialedHandler(false),
    credential: noCredential,
    management: true,
  },
  {
    caller: "private management",
    state: "unregistered",
    name: "read_send",
    given: () => credentialedHandler(false),
    credential: noCredential,
    management: true,
  },
  {
    caller: "private management",
    state: "registered",
    name: "register",
    given: () => credentialedHandler(true),
    credential: noCredential,
    management: true,
  },
];

// @agent-code-guard/regression-only: admission must refuse exactly what the caller's catalog does not list.
describe("calls a caller's catalog does not list", () => {
  it.each(unlistedCalls)(
    "refuses $caller a call to $name while $state",
    ({ name, given, credential, management }) =>
      verify(
        given(),
        (handler) =>
          callTool(handler, { name, arguments: {} }, credential, management),
        (body) => {
          expect(body).toMatchObject({
            error: { code: -32602, message: `Tool ${name} not found` },
          });
        },
      ),
  );
});

/**
 * Calls a registered daemon's catalog lists, each with arguments only its own
 * tool accepts and the answer only its own operation gives.
 */
const admittedCalls = [
  {
    caller: "the runtime credential",
    name: "search_agents",
    toolArguments: { agentName: "bob" },
    credential: credentials.runtime,
    management: false,
    answer: { kind: "not_found" },
  },
  {
    caller: "private management",
    name: "read_send",
    toolArguments: { idempotencyKey: "retried-send" },
    credential: noCredential,
    management: true,
    answer: { state: "absent" },
  },
];

/**
 * A store holding a runtime webhook subscription whose callback rejected an
 * inbox item terminally with 410 Gone, which only an owner revoke clears.
 */
const terminallyStalledWebhookStore = Effect.gen(function* () {
  const store = yield* openEndpointStore(stateDirectory());
  const callback = scriptedWebhook(store);
  const webhook = yield* callback.acquire;
  yield* webhook.subscribe(input, "runtime");
  yield* enqueue(store, 1, "rejected by the callback");
  callback.status(410);
  yield* webhook.observe();
  return store;
});

/**
 * Through its tools, private management is refused a resume of a terminally
 * stalled webhook subscription and then revokes the subscription, reading it
 * before and after.
 */
const managementResumeIsRefusedThenRevokeRetiresAStalledWebhook = () =>
  Effect.gen(function* () {
    const store = yield* terminallyStalledWebhookStore;
    const handler = yield* acquireHandler(true, {
      credentials,
      eventStore: store,
    });
    const managementCall = (name: string) =>
      callTool(handler, { name, arguments: {} }, noCredential, true);

    const stalled = yield* managementCall("event_subscription_status");
    const resumed = yield* managementCall("resume_event_subscription");
    const revoked = yield* managementCall("revoke_event_subscription");
    const retired = yield* managementCall("event_subscription_status");

    expect(stalled).toMatchObject({
      result: {
        structuredContent: { mode: "webhook", stalled: "terminal" },
      },
    });
    expect(resumed).toMatchObject({ error: { code: -32014 } });
    expect(revoked).toHaveProperty("result.structuredContent", {});
    expect(retired).toHaveProperty("result.structuredContent", {
      mode: "none",
    });
  });

// @agent-code-guard/regression-only: each admitted tool must reach the operation its name documents.
describe("calls a caller's catalog lists", () => {
  // Value: protects=runtime search_agents and owner read_send answer from their own operations; fails_when=the tool dispatch keys either name to another handler or operation; why_new=the other read_send and search_agents tests stop at input decoding or call the operations object directly; seam=none
  it.each(admittedCalls)(
    "answers $name for $caller from its operation",
    ({ name, toolArguments, credential, management, answer }) =>
      verify(
        credentialedHandler(true),
        (handler) =>
          callTool(
            handler,
            { name, arguments: toolArguments },
            credential,
            management,
          ),
        (body) => {
          expect(body).toHaveProperty("result.structuredContent", answer);
        },
      ),
  );

  // Value: protects=owner resume refuses a terminal stall and owner revoke retires the webhook subscription; fails_when=revoke_event_subscription or resume_event_subscription runs another event operation or none; why_new=webhook.test drives revoke and resume on the webhook object, not through the MCP tool dispatch; seam=none
  it(
    "refuses private management a resume of a terminally stalled webhook subscription and lets it revoke the subscription",
    managementResumeIsRefusedThenRevokeRetiresAStalledWebhook,
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

    it("refuses private management's malformed read_send", () =>
      verify(
        credentialedHandler(true),
        (handler) =>
          callTool(
            handler,
            { name: "read_send", arguments: { idempotencyKey } },
            noCredential,
            true,
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

const nativeCalls = [
  { name: "read_inbox", arguments: {}, result: { items: [] } },
  {
    name: "read_send",
    arguments: { idempotencyKey: "native-operation" },
    result: { state: "absent" },
  },
  {
    name: "acknowledge_delivery",
    arguments: { deliveryToken: digest("dlv_", 1) },
    result: {},
  },
];

const consumerBoundCalls = nativeCalls.filter(
  ({ name }) => name !== "read_send",
);

describe.each(consumerBoundCalls)("unbound native $name", (call) => {
  it("refuses the runtime credential without a current consumer lease", () =>
    verify(
      credentialedHandler(true),
      (handler) => callTool(handler, call, credentials.runtime),
      (body) => {
        expect(body).toMatchObject({
          error: { code: -32012, data: { reason: "consumer-revoked" } },
        });
      },
    ));
});

it("allows runtime send recovery without acquiring an inbox consumer", () =>
  verify(
    credentialedHandler(true),
    (handler) =>
      callTool(
        handler,
        {
          name: "read_send",
          arguments: { idempotencyKey: "native-operation" },
        },
        credentials.runtime,
      ),
    (body) => {
      expect(body).toMatchObject({
        result: { structuredContent: { state: "absent" } },
      });
    },
  ));

const callNativeTool = (handler: Handler, call: RequestParams) =>
  request(
    handler,
    "events/poll",
    { name: "moltzap.inbox.item", arguments: {}, cursor: null },
    credentials.runtime,
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(
        Schema.parseJson(Schema.Struct({ result: Schema.Unknown })),
      ),
    ),
    Effect.flatMap(({ result }) => decodePollResult(result)),
    Effect.flatMap((started) =>
      callTool(handler, { ...call, _meta: started._meta }, credentials.runtime),
    ),
  );

describe.each(nativeCalls)("off-catalog native $name", (call) => {
  it("authorizes native code with the model's runtime credential", () =>
    verify(
      credentialedHandler(true),
      (handler) => callNativeTool(handler, call),
      (body) => {
        expect(body).toMatchObject({
          result: { structuredContent: call.result },
        });
      },
    ));

  it("does not run before registration", () =>
    verify(
      credentialedHandler(false),
      (handler) => callTool(handler, call, credentials.runtime),
      (body) => {
        expect(body).toMatchObject({ error: { code: -32602 } });
      },
    ));
});

const spoofManagement = (handler: Handler) =>
  Effect.tryPromise(() => {
    const incoming = makeRequest(
      "tools/call",
      { name: "status", arguments: {}, _meta: { role: "owner" } },
      Redacted.value(credentials.runtime),
    );
    incoming.headers.set("x-moltzap-role", "owner");
    incoming.headers.set("x-forwarded-for", "127.0.0.1");
    return handler.fetch(incoming);
  }).pipe(Effect.flatMap(responseBody), Effect.flatMap(decodeJson));

describe("management authority cannot arrive over HTTP", () => {
  it("ignores role headers and forwarded addresses on a valid runtime request", () =>
    verify(credentialedHandler(true), spoofManagement, (body) => {
      expect(body).toMatchObject({
        error: { code: -32602, message: "Tool status not found" },
      });
    }));
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
