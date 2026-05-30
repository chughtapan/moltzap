/**
 * @file Representative real RPC frames + the two decode compositions the
 * benchmark times. Bench-only fixtures — not on any barrel.
 *
 * The frames carry REAL params matching the production schemas:
 *   - `agents/list`              — `AgentsList.paramsSchema` (limit + cursor)
 *   - `messages/send`            — `MessagesSend.paramsSchema` (4 branded
 *                                  UUIDs + a text-part array)
 *   - `task/conversation/create` — `TaskConversationCreate.paramsSchema`
 *                                  (branded UUID + participants[] of UUIDs)
 *
 * AJV path (`decodeAjvFull`): the EXACT shipping composition —
 * `decodeFrame` (3-arm envelope) → `decodeRpcRequest(serverRpcMethods, …)`
 * (linear `.find()` + the matched method's compiled `validateParams`).
 *
 * The Effect-Schema side of the A/B (the single-pass union decode the #723
 * migration would ship) lives in `./effect-schema-prototype.ts`.
 */
import { Effect } from "effect";
import { decodeFrame, type RequestFrame, type DecodedFrame } from "../wire.js";
import { decodeRpcRequest } from "../rpc-groups.js";
import { serverRpcMethods } from "../../rpc-registry.js";

// ── Valid fixtures (canonical UUIDs so the format check passes) ──────
const TASK_ID = "11111111-1111-1111-1111-111111111111";
const CONV_ID = "22222222-2222-2222-2222-222222222222";
const AGENT_A = "33333333-3333-3333-3333-333333333333";
const AGENT_B = "44444444-4444-4444-4444-444444444444";

export const smallFrame = {
  jsonrpc: "2.0" as const,
  id: "req-1",
  method: "agents/list",
  params: { limit: 25 },
};

export const typicalFrame = {
  jsonrpc: "2.0" as const,
  id: "req-2",
  method: "messages/send",
  params: {
    taskId: TASK_ID,
    conversationId: CONV_ID,
    parts: [{ type: "text", text: "hello from the benchmark harness" }],
  },
};

export const nestedFrame = {
  jsonrpc: "2.0" as const,
  id: "req-3",
  method: "task/conversation/create",
  params: {
    taskId: TASK_ID,
    name: "bench conversation",
    participants: [AGENT_A, AGENT_B],
  },
};

// ── AJV: the full shipping inbound-decode composition ────────────────
// `decodeFrame` classifies the envelope (Request arm), then
// `decodeRpcRequest` selects the method out of the real catalog and runs
// its compiled params validator. This is precisely what the dispatcher
// pays per inbound request, isolated from socket read + JSON.parse.
export function decodeAjvFull(
  frame: RequestFrame,
): Effect.Effect<unknown, unknown> {
  return decodeFrame(frame).pipe(
    Effect.flatMap((decoded: DecodedFrame) =>
      decoded._tag === "Request"
        ? decodeRpcRequest(serverRpcMethods, decoded.frame)
        : // Bench frames are always Request; a non-Request classification
          // means the fixture is wrong, so fail loudly rather than time a
          // mis-shaped path.
          Effect.die(new Error(`bench frame classified as ${decoded._tag}`)),
    ),
  );
}

// AJV method-selection only: skip the envelope classifier, time the linear
// `.find()` scan over `serverRpcMethods` + the matched `validateParams`.
export function selectAjvMethod(frame: RequestFrame): void {
  Effect.runSyncExit(decodeRpcRequest(serverRpcMethods, frame));
}

// The Effect-Schema side of the A/B lives in `./effect-schema-prototype.ts`
// (`decodeWireRequest` / `selectMethodArm`); the bench imports it directly.
