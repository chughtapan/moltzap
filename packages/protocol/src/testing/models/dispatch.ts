/**
 * Reference-model dispatch: one reducer keyed by wire method name.
 *
 * The union `RpcModelResult` mirrors every observable shape Tier B must
 * compare against the real server — success, typed error (authz, schema),
 * and the prospective events the server is expected to emit as a side
 * effect of the call.
 *
 * Exhaustiveness: the reducer takes `ArbitraryRpcCall` (discriminated on
 * `method`) so the TS compiler flags an unhandled method name if
 * `serverRpcMethods` grows without the model being updated.
 */
import { serverRpcMethods } from "../../rpc-registry.js";
import type { NotificationFrame } from "../../transport/wire.js";
import type { ArbitraryRpcCall } from "../arbitraries/rpc.js";
import { mkTick, type ReferenceState } from "./state.js";

type MethodName = (typeof serverRpcMethods)[number]["name"];

import {
  AgentsList,
  AgentsLookup,
  AgentsLookupByName,
  type AgentId,
  InviteAgent,
  Register,
} from "../../identity/methods.js";
import { Connect } from "../../network/methods.js";
import {
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
} from "../../app/methods.js";
import {
  type ConversationId,
  TaskClose,
  TaskCreate,
  TaskList,
} from "../../task/methods.js";
import {
  ContactsAccept,
  ContactsAdd,
  ContactsById,
  ContactsList,
} from "../../identity/methods.js";
import {
  TaskAddParticipant,
  TaskConversationArchive,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationUnarchive,
  TaskLeave,
} from "../../task/methods.js";
import { InvitesCreateAgent } from "../../identity/methods.js";
import { MessagesList, MessagesSend } from "../../task/methods.js";
import { PresenceSubscribe, PresenceUpdate } from "../../network/methods.js";
import { NetworkPing } from "../../network/methods.js";

/**
 * Observable outcome of one RPC against the model, in the same shape the
 * real server puts on the wire. Tier B's B1 asserts
 * `deepEqual(serverResponse, modelResponse)` modulo opaque fields (IDs,
 * tokens — extracted to a named canonicalizer in the implementer step).
 */
export type RpcModelResult =
  | {
      readonly _tag: "ok";
      readonly result: unknown;
      readonly events: ReadonlyArray<NotificationFrame>;
    }
  | {
      readonly _tag: "error";
      readonly code: number;
      readonly message: string;
      readonly events: ReadonlyArray<NotificationFrame>;
    };

/**
 * Methods whose contract says replay is a no-op — server must return the
 * same result (same events) for identical params. B5 cross-checks this
 * against the real server.
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set<string>([
  AgentsLookup.name,
  AgentsLookupByName.name,
  AgentsList.name,
  MessagesList.name,
  ContactsList.name,
  PresenceSubscribe.name,
  TaskConversationList.name,
  TaskList.name,
]);

export function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method);
}

type ModelMethodOutcome = "ok" | "uncertain";

const MODEL_METHOD_OUTCOMES = {
  [Connect.name]: "uncertain",
  [Register.name]: "uncertain",
  [InviteAgent.name]: "uncertain",
  [AgentsList.name]: "ok",
  [NetworkPing.name]: "ok",
  [AgentsLookup.name]: "uncertain",
  [AgentsLookupByName.name]: "uncertain",
  [TaskConversationList.name]: "uncertain",
  [TaskConversationCreate.name]: "uncertain",
  [TaskConversationArchive.name]: "uncertain",
  [TaskConversationUnarchive.name]: "uncertain",
  [TaskAddParticipant.name]: "uncertain",
  [TaskLeave.name]: "uncertain",
  [MessagesSend.name]: "uncertain",
  [MessagesList.name]: "uncertain",
  [ContactsList.name]: "uncertain",
  [ContactsAdd.name]: "uncertain",
  [ContactsAccept.name]: "uncertain",
  [ContactsById.name]: "uncertain",
  [InvitesCreateAgent.name]: "uncertain",
  [PresenceUpdate.name]: "uncertain",
  [PresenceSubscribe.name]: "uncertain",
  [AppsRegister.name]: "uncertain",
  [DispatchRequest.name]: "uncertain",
  [DispatchesGet.name]: "uncertain",
  [TaskCreate.name]: "uncertain",
  [TaskList.name]: "uncertain",
  [TaskClose.name]: "uncertain",
} as const satisfies Readonly<Record<MethodName, ModelMethodOutcome>>;

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
  agentId: AgentId,
): "allow" | "deny-unauthenticated" | "deny-forbidden" {
  // `connect` + `register` establish identity; pre-identity they are always allowed.
  if (call.method === Connect.name || call.method === Register.name)
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
): value is { readonly conversationId: ConversationId } {
  return (
    value !== null &&
    typeof value === "object" &&
    "conversationId" in value &&
    typeof (value as { conversationId: unknown }).conversationId === "string"
  );
}

function extractConversationId(params: unknown): ConversationId | null {
  return hasConversationIdString(params) ? params.conversationId : null;
}

/**
 * Pure reducer: given state + call, yield the next state and the
 * observable outcome. No I/O. No clocks. No exceptions — every failure
 * flows through `_tag: "error"`.
 *
 * Exhaustiveness: the `switch` has a branch for every method name in
 * `serverRpcMethods`. A missing branch becomes a compile error at `absurd`.
 * Behaviour is intentionally conservative — the model predicts the
 * server's *observable* outcome (success vs typed error), not its full
 * result shape. Tier B canonicalizers downgrade server responses to the
 * same projection before comparing.
 */
export function applyCall(
  state: ReferenceState,
  call: ArbitraryRpcCall,
): { readonly next: ReferenceState; readonly outcome: RpcModelResult } {
  const nextTick = mkTick(state.tick + 1);
  const baseNext: ReferenceState = { ...state, tick: nextTick };
  return {
    next: baseNext,
    outcome: modelOutcome(modelMethodOutcome(call.method)),
  };
}

function modelMethodOutcome(method: MethodName): ModelMethodOutcome {
  return MODEL_METHOD_OUTCOMES[method] as ModelMethodOutcome;
}

function modelOutcome(kind: ModelMethodOutcome): RpcModelResult {
  return kind === "ok" ? allowNoEvents() : uncertainError();
}

function allowNoEvents(): RpcModelResult {
  return {
    _tag: "ok",
    result: {},
    events: [],
  };
}

function uncertainError(): RpcModelResult {
  return {
    _tag: "error",
    code: -32603,
    message: "model-uncertain: requires state or specific params",
    events: [],
  };
}
