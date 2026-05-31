import type { ServerRpcSlots } from "../../transport/context.js";
import { defineTaskMiddlewareMethod } from "../../transport/define-layered-method.js";
import {
  conversationInTaskForList,
  conversationInTaskForSend,
  messageSendPermissionMiddleware,
  taskReadAccessMiddleware,
} from "../../app/capability-middlewares.js";
import {
  MessagesSend,
  MessagesList,
  NotFoundError,
  ForbiddenError,
  provideMiddleware,
  type LeaseId,
  type ParamsOf,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { Effect, Exit } from "effect";
import type { AgentContext } from "../../transport/context.js";
import {
  ConnectionTag,
  LeaseRegistryTag,
  MessageServiceTag,
} from "../../app/layers.js";
import { LeaseInvalidError } from "../leases/lease-registry.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import type { LeaseRegistry } from "../leases/lease-registry.js";
import type { MessageService } from "../services/message.service.js";

type MessagesSendParams = ParamsOf<typeof MessagesSend>;

function claimDispatchLease(leaseRegistry: LeaseRegistry, leaseId: LeaseId) {
  return leaseRegistry.claim(leaseId).pipe(
    Effect.catchTags({
      LeaseInvalidError: (err: LeaseInvalidError) =>
        Effect.fail(
          new ForbiddenError({
            message: `lease ${leaseId} not claimable: state=${err.state}`,
            data: {
              reason: "LeaseInvalid",
              state: err.state,
              expected: err.expected as readonly string[],
            },
          }),
        ),
      LeaseNotFoundError: () =>
        Effect.fail(
          new NotFoundError({ message: `lease ${leaseId} not found` }),
        ),
    }),
  );
}

interface LeaseSendInput {
  readonly connId: ConnectionId;
  readonly ctx: AgentContext;
  readonly params: MessagesSendParams;
  readonly messageService: MessageService;
  readonly leaseRegistry: LeaseRegistry;
}

function sendWithDispatchLease(input: LeaseSendInput) {
  return Effect.gen(function* () {
    const leaseId = input.params.dispatchLeaseId as LeaseId;
    let finalized = false;
    const message = yield* Effect.scoped(
      Effect.acquireUseRelease(
        claimDispatchLease(input.leaseRegistry, leaseId),
        (claim) =>
          Effect.gen(function* () {
            const carrier = yield* input.messageService.sendInsert({
              conversationId: input.params.conversationId,
              parts: input.params.parts,
              senderAgentId: input.ctx.agentId,
              replyToId: input.params.replyToId,
              excludeConnectionId: input.connId,
              bypassTmRouting: false,
            });
            yield* claim.finalize(carrier.message.id).pipe(Effect.ignore);
            finalized = true;
            return yield* input.messageService.sendCommit(
              carrier,
              input.params.conversationId,
              input.ctx.agentId,
            );
          }).pipe(Effect.withSpan("messages.sendWithLease")),
        (claim, exit) => {
          if (Exit.isSuccess(exit) || finalized) return Effect.void;
          return claim.rollback.pipe(Effect.ignore);
        },
      ),
    );
    return { message };
  }).pipe(Effect.withSpan("messages.sendWithDispatchLease"));
}

function handleMessageSend(params: MessagesSendParams, ctx: AgentContext) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const messageService = yield* MessageServiceTag;
      const leaseRegistry = yield* LeaseRegistryTag;
      const connection = yield* ConnectionTag;
      if (params.dispatchLeaseId !== undefined) {
        return yield* sendWithDispatchLease({
          connId: connection.connId,
          ctx,
          params,
          messageService,
          leaseRegistry,
        });
      }
      const message = yield* messageService.send({
        conversationId: params.conversationId,
        parts: params.parts,
        senderAgentId: ctx.agentId,
        replyToId: params.replyToId,
        excludeConnectionId: connection.connId,
      });
      return { message };
    }).pipe(Effect.withSpan("messages.send")),
  );
}

// The capability middlewares are woven as a HAND-EXPANDED static chain per
// arm via `provideMiddleware` (one CONCRETE-tag `provideServiceEffect` step
// per declared cap — the cast-free form, NOT a runtime tuple-fold).
// Declaration order is preserved by listing the FIRST-declared cap as the
// OUTERMOST `.pipe` step (LAST in source) for Forbidden-before-state-probe.
// The declared `middlewares` tuple (2nd arg) pins the totality lockstep so
// dropping a step fails the compile.
export const messageHandlers: ServerRpcSlots = [
  // `MessagesSend` declares `[ConversationInTask, MessageSendPermission]`
  // — the static chain weaves them in REVERSE declaration order so the
  // FIRST-declared (`ConversationInTask`) is the OUTERMOST provide
  // (Forbidden-before-state-probe); `conversationId` is DB-resolved by
  // `ConversationInTask` before `MessageSendPermission` obtains against it.
  defineTaskMiddlewareMethod(
    MessagesSend,
    // declared middleware tuple — pins the totality lockstep (`weaveCaps`
    // MUST discharge exactly `[ConversationInTask, MessageSendPermission]`).
    [conversationInTaskForSend, messageSendPermissionMiddleware] as const,
    {
      callablePrincipal: "agent",
      requiresActive: true,
      handler: handleMessageSend,
      // REVERSE declaration order: FIRST-declared (ConversationInTask) is the
      // OUTERMOST step (LAST in source) so it runs first — resolves
      // `conversationId` membership before MessageSendPermission obtains.
      weaveCaps: (handlerEffect, params) =>
        handlerEffect.pipe(
          provideMiddleware(messageSendPermissionMiddleware, params),
          provideMiddleware(conversationInTaskForSend, params),
        ),
    },
  ),
  // `MessagesList` declares `[TaskReadAccess, ConversationInTask]`.
  defineTaskMiddlewareMethod(
    MessagesList,
    [taskReadAccessMiddleware, conversationInTaskForList] as const,
    {
      callablePrincipal: "agent",
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const messageService = yield* MessageServiceTag;
          return yield* messageService.list(
            params.conversationId,
            ctx.agentId,
            {
              limit: params.limit,
              sinceSeq: params.sinceSeq,
            },
          );
        }).pipe(Effect.withSpan("messages.list")),
      // REVERSE declaration order: FIRST-declared (TaskReadAccess) outermost.
      weaveCaps: (handlerEffect, params) =>
        handlerEffect.pipe(
          provideMiddleware(conversationInTaskForList, params),
          provideMiddleware(taskReadAccessMiddleware, params),
        ),
    },
  ),
];
