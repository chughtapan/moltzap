import { type AgentContext, ConnectionTag } from "#socket";
import type {
  dispatchRequest as dispatchRequestDefinition,
  dispatchLeaseGet as dispatchLeaseGetDefinition,
} from "@moltzap/protocol/message/dispatch";
import { ForbiddenError, type ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import { Effect } from "effect";
import { DispatchAdmissionServiceTag, LeaseRegistryTag } from "./layer.js";
import { leaseRecordToWire } from "./lease-registry.js";
import { agentArm } from "#moltzap/runtime";

// `agent/dispatch/request` — returns ack immediately, forks the moderator round-trip,
// recipient observes the verdict via `agent/dispatch/released` notification.
// Agent-called: its `requires` head is `AgentPrincipal`, so the body receives a
// narrowed `AgentContext` and reads `ctx.agentId` as `recipientAgentId`. The
// `ActiveAgent` is load-bearing: suspended agents cannot dispatch.
const dispatchRequestBody = Effect.fn("dispatch.request")(function* (
  params: ParamsOf<typeof dispatchRequestDefinition>,
  ctx: AgentContext,
) {
  const admission = yield* DispatchAdmissionServiceTag;
  const connection = yield* ConnectionTag;
  const minted = yield* admission.enqueue({
    conversationId: params.conversationId,
    recipientAgentId: ctx.agentId,
    recipientConnectionId: connection.connId,
    messageId: params.messageId,
    senderAgentId: params.senderAgentId,
    parts: params.parts,
    attempt: params.attempt,
    receivedAt: params.receivedAt,
    pending: params.pending,
  });
  return minted;
});

// `app/dispatch/lease/get` — moderator-only read. Scope-enforced: the lease must be
// moderator-bound and the calling connection MUST match that binding. Otherwise
// typed `ForbiddenError`.
const dispatchLeaseGetBody = Effect.fn("dispatch.lease.get")(function* (
  params: ParamsOf<typeof dispatchLeaseGetDefinition>,
) {
  const notAuthorized = new ForbiddenError({
    message: "app/dispatch/lease/get not authorized for this lease",
  });
  const connection = yield* ConnectionTag;
  const registry = yield* LeaseRegistryTag;
  const record = yield* registry
    .read({ _tag: "dispatchId", value: params.dispatchId })
    .pipe(
      Effect.catchTag("LeaseNotFoundError", () => Effect.fail(notAuthorized)),
    );
  if (record.binding.moderatorConnectionId !== connection.connId) {
    return yield* notAuthorized;
  }
  return { lease: leaseRecordToWire(record) };
});

// ── @effect/rpc handler bodies ───────────────────────────────────────

/**
 * Provides the dispatch request runtime value.
 * @param params Request payload to process.
 * @returns The dispatch request result.
 */
export const dispatchRequest: ServerHandler<typeof dispatchRequestDefinition> =
  Effect.fn("dispatchRequest")(function* (params) {
    return yield* dispatchRequestBody(params, yield* agentArm);
  });

/**
 * Provides the dispatch lease get runtime value.
 * @param params Request payload to process.
 * @returns The dispatch lease get result.
 */
export const dispatchLeaseGet: ServerHandler<
  typeof dispatchLeaseGetDefinition
> = (params) =>
  dispatchLeaseGetBody(params).pipe(Effect.withSpan("dispatchLeaseGet"));
