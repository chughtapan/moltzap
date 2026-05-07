/**
 * Schema conformance for the surviving server-initiated admission verb.
 *
 * AJV checks against each manifest's compiled `paramsSchema` /
 * `resultSchema`. The verdict-shape coverage on `DispatchAdmissionDecision`
 * itself lives in the existing `AppsAuthorizeDispatch` block in
 * `schema/apps.test.ts`; the cases here are smoke checks that the
 * renamed `task/authorizeDispatch` manifest references the same shared
 * schema.
 *
 * Phase 9b consumer-migration (sub-issue #460): the legacy `apps/onBeforeDispatch`,
 * `apps/onBeforeMessageDelivery`, `apps/onSessionActive`, `apps/onClose`
 * verbs retired (3 deletions + 1 rename). Only `task/authorizeDispatch`
 * remains in the server→client awaitable surface; this file reflects that
 * collapse.
 */
import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { TaskAuthorizeDispatch } from "./methods.js";
import { taskCallbackMethods } from "../rpc-registry.js";

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
  it("registers the surviving admission verb under taskCallback", () => {
    const taskCallbackNames = taskCallbackMethods.map((m) => m.name);
    expect(taskCallbackNames).toEqual([TaskAuthorizeDispatch.name]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// task/authorizeDispatch — params surface; verdict union covered separately
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskAuthorizeDispatch", () => {
  const validateParams = TaskAuthorizeDispatch.validateParams;
  const validateResult = ajv.compile(TaskAuthorizeDispatch.resultSchema);

  const baseParams = {
    taskId: SESSION_ID,
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
    const { taskId: _omit, ...withoutTask } = baseParams;
    expect(validateParams(withoutTask)).toBe(false);
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
