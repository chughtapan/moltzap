/**
 * Schema conformance for the admission RPC verbs.
 *
 * AJV checks against each manifest's compiled `paramsSchema` /
 * `resultSchema`. The verdict-shape coverage on `DispatchAdmissionDecision`
 * itself lives in the existing `AppsAuthorizeDispatch` block in
 * `schema/apps.test.ts`; the cases here are smoke checks that the new
 * `AppsOnBeforeDispatch` manifest references the same shared schema.
 */
import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnSessionActive,
  AppsOnClose,
} from "./apps.js";
import {
  appCallbackRpcMethods,
  type AppCallbackRpcMethodName,
} from "../../rpc-registry.js";

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const APP_ID = "werewolf";
const CONVERSATION_ID = "550e8400-e29b-41d4-a716-446655440001";
const AGENT_ID = "550e8400-e29b-41d4-a716-446655440002";
const MESSAGE_ID = "550e8400-e29b-41d4-a716-446655440003";

const HOOK_AGENT = { agentId: AGENT_ID, ownerId: "owner-1" };

// ─────────────────────────────────────────────────────────────────────────────
// Registry membership — direction-namespaced. Wire-name renames fail at
// compile time; tuple membership is asserted here against `manifest.name`
// so a manifest dropped from the wrong tuple still fails the test.
// ─────────────────────────────────────────────────────────────────────────────

describe("admission RPC registration", () => {
  it("registers the four admission/lifecycle verbs as appCallback", () => {
    const appCallbackNames = appCallbackRpcMethods.map((m) => m.name);
    expect(appCallbackNames).toEqual([
      AppsOnBeforeDispatch.name,
      AppsOnBeforeMessageDelivery.name,
      AppsOnSessionActive.name,
      AppsOnClose.name,
    ] satisfies AppCallbackRpcMethodName[]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// apps/onBeforeDispatch — params surface; verdict union covered separately
// ─────────────────────────────────────────────────────────────────────────────

describe("AppsOnBeforeDispatch", () => {
  const validateParams = AppsOnBeforeDispatch.validateParams;
  const validateResult = ajv.compile(AppsOnBeforeDispatch.resultSchema);

  const baseParams = {
    sessionId: SESSION_ID,
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

  it("accepts a minimal valid context", () => {
    expect(validateParams(baseParams)).toBe(true);
  });

  it("accepts the optional pending+clock+receivedAt envelope", () => {
    expect(
      validateParams({
        ...baseParams,
        receivedAt: "2026-04-29T22:00:00.000Z",
        clock: {
          domainId: CONVERSATION_ID,
          epoch: 1,
          vector: { [AGENT_ID]: 1 },
        },
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

  it("rejects missing required fields", () => {
    const { sessionId: _omit, ...withoutSession } = baseParams;
    expect(validateParams(withoutSession)).toBe(false);
    expect(validateParams({})).toBe(false);
  });

  it("rejects negative attempt", () => {
    expect(validateParams({ ...baseParams, attempt: -1 })).toBe(false);
  });

  // Smoke check that the result schema points at the shared
  // `DispatchAdmissionDecision` union — full grant/deny/hold round-trip
  // coverage lives in `schema/apps.test.ts > AppsAuthorizeDispatch`.
  it("references the DispatchAdmissionDecision union", () => {
    expect(
      validateResult({ admission: { decision: "grant", leaseId: "l1" } }),
    ).toBe(true);
    expect(validateResult({ admission: { decision: "allow" } })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// apps/onBeforeMessageDelivery — HookResult round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("AppsOnBeforeMessageDelivery", () => {
  const validateParams = AppsOnBeforeMessageDelivery.validateParams;
  const validateResult = ajv.compile(AppsOnBeforeMessageDelivery.resultSchema);

  const baseParams = {
    sessionId: SESSION_ID,
    appId: APP_ID,
    conversationId: CONVERSATION_ID,
    sender: HOOK_AGENT,
    message: { parts: [{ type: "text", text: "hi" }] },
  };

  it("accepts a minimal valid context", () => {
    expect(validateParams(baseParams)).toBe(true);
  });

  it("accepts replyToId + dispatchLeaseId on the message", () => {
    expect(
      validateParams({
        ...baseParams,
        message: {
          parts: [{ type: "text", text: "reply" }],
          replyToId: MESSAGE_ID,
          dispatchLeaseId: "lease-7",
        },
      }),
    ).toBe(true);
  });

  it("rejects empty parts (minItems: 1)", () => {
    expect(validateParams({ ...baseParams, message: { parts: [] } })).toBe(
      false,
    );
  });

  it("accepts {block: false} (passthrough verdict)", () => {
    expect(validateResult({ block: false })).toBe(true);
  });

  it("accepts {block: true, reason} (fail-closed verdict)", () => {
    expect(validateResult({ block: true, reason: "rate-limit" })).toBe(true);
  });

  it("accepts patch + feedback verdicts", () => {
    expect(
      validateResult({
        block: false,
        patch: { parts: [{ type: "text", text: "redacted" }] },
        feedback: {
          type: "warning",
          content: { hint: "be nicer" },
          retry: false,
        },
      }),
    ).toBe(true);
  });

  it("rejects an invalid feedback type", () => {
    expect(
      validateResult({
        block: false,
        feedback: { type: "fatal", content: {} },
      }),
    ).toBe(false);
  });

  it("rejects additional properties (no field invention)", () => {
    expect(validateResult({ block: false, deflect: true })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Awaitable-void lifecycle hooks — onSessionActive / onClose share
// the `{}` result envelope; their context shapes diverge only in field set.
// ─────────────────────────────────────────────────────────────────────────────

const onSessionActiveParams = {
  sessionId: SESSION_ID,
  appId: APP_ID,
  conversations: { town_square: CONVERSATION_ID },
  admittedAgentIds: [AGENT_ID],
};

const onCloseParams = {
  sessionId: SESSION_ID,
  appId: APP_ID,
  conversations: { town_square: CONVERSATION_ID },
  closedBy: HOOK_AGENT,
};

describe.each([
  {
    label: "AppsOnSessionActive",
    manifest: AppsOnSessionActive,
    valid: onSessionActiveParams,
  },
  { label: "AppsOnClose", manifest: AppsOnClose, valid: onCloseParams },
])("$label", ({ manifest, valid }) => {
  const validateResult = ajv.compile(manifest.resultSchema);

  it("accepts a minimal valid context", () => {
    expect(manifest.validateParams(valid)).toBe(true);
  });

  it("accepts an empty result envelope (awaitable void)", () => {
    expect(validateResult({})).toBe(true);
  });

  it("rejects extra result fields (void hook payloads are ignored, not extended)", () => {
    expect(validateResult({ ack: true })).toBe(false);
  });
});
