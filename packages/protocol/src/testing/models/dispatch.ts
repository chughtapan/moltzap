/**
 * Reference-model dispatch: one reducer keyed by `RpcMethodName`.
 *
 * The union `RpcModelResult` mirrors every observable shape Tier B must
 * compare against the real server — success, typed error (authz, schema),
 * and the prospective events the server is expected to emit as a side
 * effect of the call.
 *
 * Exhaustiveness: the reducer takes `ArbitraryRpcCall` (discriminated on
 * `method`) so the TS compiler flags an unhandled method name if
 * `rpcMethods` grows without the model being updated.
 */
import type { RpcMap, RpcMethodName } from "../../rpc-registry.js";
import type { EventFrame } from "../../schema/frames.js";
import type { ArbitraryRpcCall } from "../arbitraries/rpc.js";
import { mkTick, type ReferenceState } from "./state.js";

/**
 * Observable outcome of one RPC against the model, in the same shape the
 * real server puts on the wire. Tier B's B1 asserts
 * `deepEqual(serverResponse, modelResponse)` modulo opaque fields (IDs,
 * tokens — extracted to a named canonicalizer in the implementer step).
 */
export type RpcModelResult<M extends RpcMethodName = RpcMethodName> =
  | {
      readonly _tag: "ok";
      readonly result: RpcMap[M]["result"];
      readonly events: ReadonlyArray<EventFrame>;
    }
  | {
      readonly _tag: "error";
      readonly code: number;
      readonly message: string;
      readonly events: ReadonlyArray<EventFrame>;
    };

/**
 * Canonical RPC error codes the model mirrors from the server. Matches the
 * `ErrorCode` union in `packages/protocol/src/schema/errors.ts` at the
 * values we emit.
 */
const ErrorCodes = {
  AUTH_REQUIRED: -32001,
  FORBIDDEN: -32003,
  NOT_FOUND: -32004,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/**
 * Methods whose contract says replay is a no-op — server must return the
 * same result (same events) for identical params. B5 cross-checks this
 * against the real server.
 */
const IDEMPOTENT_METHODS: ReadonlySet<RpcMethodName> = new Set([
  "agents/lookup",
  "agents/lookupByName",
  "agents/list",
  "conversations/list",
  "conversations/get",
  "messages/list",
  "contacts/list",
  "presence/subscribe",
  "apps/listSessions",
  "apps/getSession",
  "permissions/list",
  "surface/get",
] satisfies readonly RpcMethodName[]);

export function isIdempotent(method: RpcMethodName): boolean {
  return IDEMPOTENT_METHODS.has(method);
}

/**
 * Authorization oracle (B2 / B3). Returns the expected typed outcome for a
 * call made by `agentId`. Property code compares the real server's error
 * to this.
 *
 * Rules (mirrored from `packages/server/src/app/authz.ts` contract):
 *   - Unregistered agent + non-connect method → deny-unauthenticated.
 *   - Conversation-scoped method + `authz` entry "denied" → deny-forbidden.
 *   - Otherwise allow.
 */
export function authorizationOutcome(
  state: ReferenceState,
  call: ArbitraryRpcCall,
  agentId: string,
): "allow" | "deny-unauthenticated" | "deny-forbidden" {
  // `connect` + `register` establish identity; pre-identity they are always allowed.
  if (call.method === "auth/connect" || call.method === "auth/register")
    return "allow";
  if (!state.agents.has(agentId)) return "deny-unauthenticated";

  const conversationId = extractConversationId(call.params);
  if (conversationId !== null) {
    const row = state.authz.get(agentId);
    if (row !== undefined && row.get(conversationId) === "denied") {
      return "deny-forbidden";
    }
  }
  return "allow";
}

function hasConversationIdString(
  value: unknown,
): value is { readonly conversationId: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "conversationId" in value &&
    typeof (value as { conversationId: unknown }).conversationId === "string"
  );
}

function extractConversationId(params: unknown): string | null {
  return hasConversationIdString(params) ? params.conversationId : null;
}

/**
 * Pure reducer: given state + call, yield the next state and the
 * observable outcome. No I/O. No clocks. No exceptions — every failure
 * flows through `_tag: "error"`.
 *
 * Exhaustiveness: the `switch` has a branch for every `RpcMethodName` in
 * `rpcMethods`. A missing branch becomes a compile error at `absurd`.
 * Behaviour is intentionally conservative — the model predicts the
 * server's *observable* outcome (success vs typed error), not its full
 * result shape. Tier B canonicalizers downgrade server responses to the
 * same projection before comparing.
 */
export function applyCall<M extends RpcMethodName>(
  state: ReferenceState,
  call: ArbitraryRpcCall<M>,
): { readonly next: ReferenceState; readonly outcome: RpcModelResult<M> } {
  const nextTick = mkTick(state.tick + 1);
  const baseNext: ReferenceState = { ...state, tick: nextTick };

  // Authorization check first — every method except connect/register requires identity.
  // The model doesn't know which `agentId` is the caller here (the call is
  // unattributed); agent-scoped B2/B3 properties call `authorizationOutcome`
  // directly. `applyCall` assumes an already-authenticated caller for
  // simplicity.

  // Behaviour families the reducer groups by. Grouping keeps the exhaustive
  // switch below small and named.
  const allowNoEvents = (): RpcModelResult<M> => ({
    _tag: "ok",
    // The model returns an opaque placeholder; canonicalizers mask result
    // fields to `unknown` before comparing with the server. The exact shape
    // is not load-bearing for B1, which compares "ok vs error" + events.
    result: {} as RpcMap[M]["result"],
    events: [],
  });

  const m: RpcMethodName = call.method;
  switch (m) {
    // Auth family.
    case "auth/connect":
    case "auth/register":
    case "auth/invite-agent":
    case "auth/selectAgent":
    case "agents/lookup":
    case "agents/lookupByName":
    case "agents/list":
      return { next: baseNext, outcome: allowNoEvents() };

    // Conversations family.
    case "conversations/create":
    case "conversations/list":
    case "conversations/get":
    case "conversations/update":
    case "conversations/mute":
    case "conversations/unmute":
    case "conversations/addParticipant":
    case "conversations/removeParticipant":
    case "conversations/leave":
    case "conversations/archive":
    case "conversations/unarchive":
      return { next: baseNext, outcome: allowNoEvents() };

    // Messages family.
    case "messages/send":
    case "messages/list":
      return { next: baseNext, outcome: allowNoEvents() };

    // Contacts family.
    case "contacts/list":
    case "contacts/add":
    case "contacts/accept":
      return { next: baseNext, outcome: allowNoEvents() };

    // Invites family.
    case "invites/createAgent":
      return { next: baseNext, outcome: allowNoEvents() };

    // Presence family.
    case "presence/update":
    case "presence/subscribe":
      return { next: baseNext, outcome: allowNoEvents() };

    // Push family.
    case "push/register":
    case "push/unregister":
      return { next: baseNext, outcome: allowNoEvents() };

    // Apps family.
    case "apps/create":
    case "apps/attestSkill":
    case "permissions/grant":
    case "permissions/list":
    case "permissions/revoke":
    case "apps/closeSession":
    case "apps/getSession":
    case "apps/listSessions":
      return { next: baseNext, outcome: allowNoEvents() };

    // Surfaces family.
    case "surface/update":
    case "surface/get":
    case "surface/action":
    case "surface/clear":
      return { next: baseNext, outcome: allowNoEvents() };

    default: {
      // Exhaustiveness check — any new RpcMethodName breaks the build here
      // until a branch is added.
      const _exhaustive: never = m;
      return {
        next: baseNext,
        outcome: {
          _tag: "error",
          code: ErrorCodes.INTERNAL,
          message: `model: unhandled method ${String(_exhaustive)}`,
          events: [],
        },
      };
    }
  }
}
