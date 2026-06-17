import type { AgentContext } from "#socket";
import {
  DispatchRequest,
  DispatchLeaseGet,
} from "@moltzap/protocol/message/dispatch";
import { ForbiddenError } from "@moltzap/protocol/rpc";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import { Effect } from "effect";
import { ConnectionTag } from "#socket";
import {
  DispatchAdmissionServiceTag,
  LeaseRegistryTag,
  leaseRecordToWire,
} from "#dispatch";
import { agentArm } from "#moltzap/runtime";

// `agent/dispatch/request` — returns ack immediately, forks the moderator round-trip,
// recipient observes the verdict via `agent/dispatch/released` notification.
// Agent-called: its `requires` head is `AgentPrincipal`, so the body receives a
// narrowed `AgentContext` and reads `ctx.agentId` as `recipientAgentId`. The
// `ActiveAgent` is load-bearing: suspended agents cannot dispatch.
function dispatchRequestBody(
  params: ParamsOf<typeof DispatchRequest>,
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
function dispatchLeaseGetBody(params: ParamsOf<typeof DispatchLeaseGet>) {
  return Effect.gen(function* () {
    const connection = yield* ConnectionTag;
    const registry = yield* LeaseRegistryTag;
    const record = yield* registry
      .read({ _tag: "dispatchId", value: params.dispatchId })
      .pipe(
        Effect.catchTag("LeaseNotFoundError", () =>
          Effect.fail(
            new ForbiddenError({
              message: "app/dispatch/lease/get not authorized for this lease",
            }),
          ),
        ),
      );
    if (record.binding.moderatorConnectionId !== connection.connId) {
      return yield* Effect.fail(
        new ForbiddenError({
          message: "app/dispatch/lease/get not authorized for this lease",
        }),
      );
    }
    return { lease: leaseRecordToWire(record) };
  }).pipe(Effect.withSpan("dispatch.lease.get"));
}

// ── @effect/rpc handler bodies ───────────────────────────────────────

export const dispatchRequest: ServerHandler<typeof DispatchRequest> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* dispatchRequestBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("dispatchRequest"));

export const dispatchLeaseGet: ServerHandler<typeof DispatchLeaseGet> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* dispatchLeaseGetBody(params);
  }).pipe(Effect.withSpan("dispatchLeaseGet"));
