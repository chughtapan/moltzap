import type { ServerRpcSlots } from "../../transport/context.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import {
  provideConversationInTask,
  provideMessageSendPermission,
  provideTaskReadAccess,
} from "../../app/capability-providers.js";
import {
  MessagesSend,
  MessagesList,
  NotFoundError,
  ForbiddenError,
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

export const messageHandlers: ServerRpcSlots = [
  // `MessagesSend` declares `[ConversationInTask, MessageSendPermission]`
  // — the providers tuple is positional, aligned to that order.
  defineTaskMethod(
    MessagesSend,
    {
      callablePrincipal: "agent",
      requiresActive: true,
      handler: handleMessageSend,
    },
    [provideConversationInTask, provideMessageSendPermission],
  ),
  // `MessagesList` declares `[TaskReadAccess, ConversationInTask]`.
  defineTaskMethod(
    MessagesList,
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
    },
    [provideTaskReadAccess, provideConversationInTask],
  ),
];
