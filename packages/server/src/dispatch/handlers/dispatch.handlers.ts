import type { AgentContext } from "#socket";
import {
  DispatchRequest,
  DispatchesGet,
} from "@moltzap/protocol/message/dispatch";
import { ForbiddenError } from "@moltzap/protocol/transport";
import type { ParamsOf } from "@moltzap/protocol/transport";
import type { ServerHandler } from "@moltzap/protocol/socket";
import { Effect } from "effect";
import { AppHostTag, ConnectionTag } from "#core";
import { leaseRecordToWire } from "#dispatch";
import { agentArm } from "#core";

// `dispatch/request` — returns ack immediately, forks the moderator round-trip,
// recipient observes the verdict via `dispatch/release` notification.
// Agent-called: its `requires` head is `AgentPrincipal`, so the body receives a
// narrowed `AgentContext` and reads `ctx.agentId` as `recipientAgentId`. The
// `AgentClaimed` requirement is load-bearing — only a claimed agent may dispatch.
function dispatchRequestBody(
  params: ParamsOf<typeof DispatchRequest>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const appHost = yield* AppHostTag;
    const connection = yield* ConnectionTag;
    const minted = yield* appHost.enqueueDispatchRequest({
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

// `dispatches/get` — moderator-only read. Scope-enforced: the lease must be
// moderator-bound and the calling connection MUST match that binding. Otherwise
// typed `ForbiddenError`.
function dispatchesGetBody(params: ParamsOf<typeof DispatchesGet>) {
  return Effect.gen(function* () {
    const appHost = yield* AppHostTag;
    const connection = yield* ConnectionTag;
    const registry = appHost.getLeaseRegistry();
    if (!registry) {
      return yield* Effect.die(
        "AppHost.getLeaseRegistry returned null — registry not wired",
      );
    }
    const record = yield* registry
      .read({ _tag: "dispatchId", value: params.dispatchId })
      .pipe(
        Effect.catchTag("LeaseNotFoundError", () =>
          Effect.fail(
            new ForbiddenError({
              message: "dispatches/get not authorized for this lease",
            }),
          ),
        ),
      );
    if (record.binding.moderatorConnectionId !== connection.connId) {
      return yield* Effect.fail(
        new ForbiddenError({
          message: "dispatches/get not authorized for this lease",
        }),
      );
    }
    return { lease: leaseRecordToWire(record) };
  }).pipe(Effect.withSpan("dispatches.get"));
}

// ── @effect/rpc handler bodies ───────────────────────────────────────

export const dispatchRequest: ServerHandler<typeof DispatchRequest> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* dispatchRequestBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("dispatchRequest"));

export const dispatchesGet: ServerHandler<typeof DispatchesGet> = (params) =>
  Effect.gen(function* () {
    return yield* dispatchesGetBody(params);
  }).pipe(Effect.withSpan("dispatchesGet"));
