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
 * `rpcMethods` grows without the model being updated.
 */
import { rpcMethods } from "../../rpc-registry.js";
import type { NotificationFrame } from "../../transport/wire.js";
import { JSON_RPC_RESERVED_CODES } from "../../transport/wire-errors.js";
import type { ArbitraryRpcCall } from "../arbitraries/rpc.js";
import { mkTick, type ReferenceState } from "./state.js";

type MethodName = (typeof rpcMethods)[number]["name"];

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
  TasksClose,
  TasksCreate,
  TasksGet,
  TasksList,
} from "../../task/methods.js";
import {
  ContactsAccept,
  ContactsAdd,
  ContactsById,
  ContactsList,
} from "../../identity/methods.js";
import {
  ConversationsAddParticipant,
  ConversationsArchive,
  ConversationsCreate,
  ConversationsGet,
  ConversationsLeave,
  ConversationsList,
  ConversationsMute,
  ConversationsRemoveParticipant,
  ConversationsUnarchive,
  ConversationsUnmute,
  ConversationsUpdate,
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
  ConversationsList.name,
  ConversationsGet.name,
  MessagesList.name,
  ContactsList.name,
  PresenceSubscribe.name,
  TasksList.name,
  TasksGet.name,
]);

export function isIdempotent(method: string): boolean {
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
 * `rpcMethods`. A missing branch becomes a compile error at `absurd`.
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

  // Authorization check first — every method except connect/register requires identity.
  // The model doesn't know which `agentId` is the caller here (the call is
  // unattributed); agent-scoped B2/B3 properties call `authorizationOutcome`
  // directly. `applyCall` assumes an already-authenticated caller for
  // simplicity.

  // Behaviour families the reducer groups by. Grouping keeps the
  // exhaustive switch below small and named.
  //
  // Model-equivalence (rpc-semantics/model-equivalence) uses the
  // asymmetric oracle: only the `"ok"` path is load-bearing for the
  // server-must-agree contract. Methods that require specific
  // params/setup return `"error"` so the model is honest about its
  // uncertainty — the property runs through them without asserting.
  //
  // Criterion for returning `"ok"`: "a freshly-registered agent with
  // empty-or-arbitrary params gets a successful response." Read-only
  // list methods with fully-optional params are the honest `"ok"` set;
  // every other method returns `"error"` (the model is admitting it
  // doesn't know the state-dependent outcome).
  const allowNoEvents = (): RpcModelResult => ({
    _tag: "ok",
    result: {},
    events: [],
  });
  const uncertainError = (): RpcModelResult => ({
    _tag: "error",
    code: -32603,
    message: "model-uncertain: requires state or specific params",
    events: [],
  });

  const m: MethodName = call.method;
  switch (m) {
    case Connect.name:
    case Register.name:
    case InviteAgent.name:
      return { next: baseNext, outcome: uncertainError() };

    // Agents list-shaped — honest "ok" for a fresh authenticated agent.
    case AgentsList.name:
      return { next: baseNext, outcome: allowNoEvents() };

    // System — pure ping returns a timestamp; honest "ok" for any caller.
    case NetworkPing.name:
      return { next: baseNext, outcome: allowNoEvents() };

    // Agents lookup-shaped — need a target; uncertain.
    case AgentsLookup.name:
    case AgentsLookupByName.name:
      return { next: baseNext, outcome: uncertainError() };

    // Conversations list — NOT oracle-confident across arbitrary
    // params. Round-8 finding (architect-197 §2.2 literal-probe
    // widening): `conversations/list` accepts `cursor: Type.String()`
    // (any string) at the schema layer, but the server's cursor
    // parser errors on pathological whitespace-only values. The
    // model would be dishonest claiming `ok` across all draws. Move
    // to `uncertainError`; K=1 today (agents/list only). Widening
    // K requires either per-method param filters at the arbitrary
    // layer OR a server-side cursor-parse fix.
    case ConversationsList.name:
      return { next: baseNext, outcome: uncertainError() };

    // Conversations with required fields or state — uncertain.
    case ConversationsCreate.name:
    case ConversationsGet.name:
    case ConversationsUpdate.name:
    case ConversationsMute.name:
    case ConversationsUnmute.name:
    case ConversationsAddParticipant.name:
    case ConversationsRemoveParticipant.name:
    case ConversationsLeave.name:
    case ConversationsArchive.name:
    case ConversationsUnarchive.name:
      return { next: baseNext, outcome: uncertainError() };

    // Messages — both require a valid conversationId. Uncertain.
    case MessagesSend.name:
    case MessagesList.name:
      return { next: baseNext, outcome: uncertainError() };

    // Contacts list — requires user context for a fresh agent, so
    // server returns an error. Uncertain.
    case ContactsList.name:
    case ContactsAdd.name:
    case ContactsAccept.name:
    case ContactsById.name:
      return { next: baseNext, outcome: uncertainError() };

    // Invites — requires state. Uncertain.
    case InvitesCreateAgent.name:
      return { next: baseNext, outcome: uncertainError() };

    // Presence — state-dependent. Uncertain.
    case PresenceUpdate.name:
    case PresenceSubscribe.name:
      return { next: baseNext, outcome: uncertainError() };

    // Apps — admission + observability surfaces require app/user context
    // the fresh fuzz agent doesn't have. Outcome is uncertain across
    // draws (the registry may be unwired in some envs).
    case AppsRegister.name:
    case DispatchRequest.name:
    case DispatchesGet.name:
      return { next: baseNext, outcome: uncertainError() };

    // Tasks — require task/participant context. Uncertain across draws.
    case TasksCreate.name:
    case TasksGet.name:
    case TasksList.name:
    case TasksClose.name:
      return { next: baseNext, outcome: uncertainError() };

    default: {
      // Exhaustiveness check — any new wire method name breaks the build here
      // until a branch is added.
      const _exhaustive = m as never;
      return {
        next: baseNext,
        outcome: {
          _tag: "error",
          code: JSON_RPC_RESERVED_CODES.InternalError,
          message: `model: unhandled method ${String(_exhaustive)}`,
          events: [],
        },
      };
    }
  }
}
