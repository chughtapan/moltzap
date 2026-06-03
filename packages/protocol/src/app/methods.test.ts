/**
 * Schema conformance for the server-initiated task-callback verbs.
 *
 * Strict Effect-Schema decode checks against the descriptor's `paramsSchema`
 * / `resultSchema` (post-#723: the former `ajv.compile` validators are now
 * the descriptors' `validateParams` guard + a `Schema.decodeUnknownEither`
 * for results). The verdict-shape coverage on `DispatchAdmissionDecision`
 * itself lives in `DispatchRequest`'s schema; the cases here are smoke
 * checks that the `dispatch/authorize` manifest references the same
 * shared decision schema. `messages/authorize` coverage pins the
 * send-side fan-out gate restored by #560.
 */
import { describe, it, expect } from "vitest";
import type { Schema } from "effect";
import { DispatchAuthorize, MessagesAuthorize, TaskCreate } from "./methods.js";
import { appCallbackMethods } from "../rpc-registry.js";
import { decodesStrictly } from "../schema-primitives.js";

// Strict, excess-rejecting decode check — the parity oracle for the former
// `ajv.compile(resultSchema)` strict validators.
const decodes = <A, I>(schema: Schema.Schema<A, I>, value: unknown): boolean =>
  decodesStrictly(schema, value);

const TASK_ID = "550e8400-e29b-41d4-a716-446655440000";
const APP_ID = "werewolf";
const CONVERSATION_ID = "550e8400-e29b-41d4-a716-446655440001";
const AGENT_ID = "550e8400-e29b-41d4-a716-446655440002";
const MESSAGE_ID = "550e8400-e29b-41d4-a716-446655440003";
const RECIPIENT_ID = "550e8400-e29b-41d4-a716-446655440004";

const HOOK_AGENT = { agentId: AGENT_ID, ownerId: "owner-1" };

const validateDispatchAuthorizeParams = DispatchAuthorize.validateParams;
const validateDispatchAuthorizeResult = (value: unknown): boolean =>
  decodes(DispatchAuthorize.resultSchema, value);
const DISPATCH_AUTHORIZE_PARAMS = {
  taskId: TASK_ID,
  appId: APP_ID,
  conversationId: CONVERSATION_ID,
  recipient: HOOK_AGENT,
  message: {
    id: MESSAGE_ID,
    senderAgentId: AGENT_ID,
    parts: [{ type: "text", text: "hi" }],
  },
  attempt: 0,
};

const validateMessagesAuthorizeParams = MessagesAuthorize.validateParams;
const validateMessagesAuthorizeResult = (value: unknown): boolean =>
  decodes(MessagesAuthorize.resultSchema, value);
const MESSAGES_AUTHORIZE_PARAMS = {
  taskId: TASK_ID,
  appId: APP_ID,
  conversationId: CONVERSATION_ID,
  message: {
    id: MESSAGE_ID,
    senderAgentId: AGENT_ID,
    parts: [{ type: "text", text: "hi" }],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry membership — direction-namespaced.
// ─────────────────────────────────────────────────────────────────────────────

describe("admission RPC registration", () => {
  it("registers every app-callback descriptor", () => {
    const appCallbackNames = appCallbackMethods.map((m) => m.name);
    expect(appCallbackNames).toEqual([
      DispatchAuthorize.name,
      MessagesAuthorize.name,
      TaskCreate.name,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatch/authorize — params surface; verdict union covered separately
// ─────────────────────────────────────────────────────────────────────────────

describe("DispatchAuthorize params acceptance", () => {
  it("accepts a minimal valid context", () => {
    expect(validateDispatchAuthorizeParams(DISPATCH_AUTHORIZE_PARAMS)).toBe(
      true,
    );
  });

  it("accepts the optional pending+receivedAt envelope", () => {
    expect(
      validateDispatchAuthorizeParams({
        ...DISPATCH_AUTHORIZE_PARAMS,
        receivedAt: "2026-04-29T22:00:00.000Z",
        pending: [
          {
            messageId: MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            senderAgentId: AGENT_ID,
            createdAt: "2026-04-29T22:00:00.000Z",
            receivedAt: "2026-04-29T22:00:00.000Z",
            parts: [{ type: "text", text: "older" }],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("DispatchAuthorize params rejection", () => {
  it("rejects missing required fields", () => {
    const withoutTask = Object.fromEntries(
      Object.entries(DISPATCH_AUTHORIZE_PARAMS).filter(
        ([key]) => key !== "taskId",
      ),
    );
    expect(validateDispatchAuthorizeParams(withoutTask)).toBe(false);
    expect(validateDispatchAuthorizeParams({})).toBe(false);
  });

  it("rejects negative attempt", () => {
    expect(
      validateDispatchAuthorizeParams({
        ...DISPATCH_AUTHORIZE_PARAMS,
        attempt: -1,
      }),
    ).toBe(false);
  });
});

describe("DispatchAuthorize result", () => {
  it("references the DispatchAdmissionDecision union", () => {
    expect(
      validateDispatchAuthorizeResult({
        admission: {
          decision: "grant",
          leaseId: "550e8400-e29b-41d4-a716-446655440099",
        },
      }),
    ).toBe(true);
    expect(
      validateDispatchAuthorizeResult({ admission: { decision: "allow" } }),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// messages/authorize — send-side fan-out gate
// ─────────────────────────────────────────────────────────────────────────────

describe("MessagesAuthorize params acceptance", () => {
  it("accepts a minimal valid context", () => {
    expect(validateMessagesAuthorizeParams(MESSAGES_AUTHORIZE_PARAMS)).toBe(
      true,
    );
  });

  it("accepts optional receivedAt", () => {
    expect(
      validateMessagesAuthorizeParams({
        ...MESSAGES_AUTHORIZE_PARAMS,
        receivedAt: "2026-05-12T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("MessagesAuthorize params rejection", () => {
  it("does not accept in-process-only signal over the wire", () => {
    expect(
      validateMessagesAuthorizeParams({
        ...MESSAGES_AUTHORIZE_PARAMS,
        signal: {},
      }),
    ).toBe(false);
  });
});

describe("MessagesAuthorize result", () => {
  it("accepts Forward and Block verdict envelopes", () => {
    expect(
      validateMessagesAuthorizeResult({
        verdict: { decision: "Forward", recipients: [RECIPIENT_ID] },
      }),
    ).toBe(true);
    expect(
      validateMessagesAuthorizeResult({
        verdict: { decision: "Block", reason: "policy/no-send" },
      }),
    ).toBe(true);
  });

  it("rejects malformed verdict envelopes", () => {
    expect(
      validateMessagesAuthorizeResult({ verdict: { decision: "Modify" } }),
    ).toBe(false);
    expect(
      validateMessagesAuthorizeResult({
        verdict: { decision: "Forward", recipients: ["not-a-uuid"] },
      }),
    ).toBe(false);
  });
});
