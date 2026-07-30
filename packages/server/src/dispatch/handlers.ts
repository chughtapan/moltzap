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
function dispatchRequestBody(
  params: ParamsOf<typeof dispatchRequestDefinition>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
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
  }).pipe(Effect.withSpan("dispatch.request"));
}

// `app/dispatch/lease/get` — moderator-only read. Scope-enforced: the lease must be
// moderator-bound and the calling connection MUST match that binding. Otherwise
// typed `ForbiddenError`.
function dispatchLeaseGetBody(
  params: ParamsOf<typeof dispatchLeaseGetDefinition>,
) {
  const notAuthorized = new ForbiddenError({
    message: "app/dispatch/lease/get not authorized for this lease",
  });
  return Effect.gen(function* () {
    const connection = yield* ConnectionTag;
    const registry = yield* LeaseRegistryTag;
    const record = yield* registry
      .read({ _tag: "dispatchId", value: params.dispatchId })
      .pipe(
        Effect.catchTag("LeaseNotFoundError", () => Effect.fail(notAuthorized)),
      );
    if (record.binding.moderatorConnectionId !== connection.connId) {
      return yield* Effect.fail(notAuthorized);
    }
    return { lease: leaseRecordToWire(record) };
  }).pipe(Effect.withSpan("dispatch.lease.get"));
}

// ── @effect/rpc handler bodies ───────────────────────────────────────

/**
 * Provides the dispatch request runtime value.
 * @param params Request payload to process.
 * @returns The dispatch request result.
 */
export const dispatchRequest: ServerHandler<
  typeof dispatchRequestDefinition
> = (params) =>
  Effect.gen(function* () {
    return yield* dispatchRequestBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("dispatchRequest"));

/**
 * Provides the dispatch lease get runtime value.
 * @param params Request payload to process.
 * @returns The dispatch lease get result.
 */
export const dispatchLeaseGet: ServerHandler<
  typeof dispatchLeaseGetDefinition
> = (params) =>
  Effect.gen(function* () {
    return yield* dispatchLeaseGetBody(params);
  }).pipe(Effect.withSpan("dispatchLeaseGet"));
