import type { RpcMethodRegistry } from "../../transport/context.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
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
import type { AuthenticatedContext } from "../../transport/context.js";
import {
  ConnIdTag,
  LeaseRegistryTag,
  MessageServiceTag,
} from "../../app/layers.js";
import { LeaseInvalidError } from "../../app/lease-registry.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import type { LeaseRegistry } from "../../app/lease-registry.js";
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
  readonly ctx: AuthenticatedContext;
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

function handleMessageSend(
  params: MessagesSendParams,
  ctx: AuthenticatedContext,
) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const messageService = yield* MessageServiceTag;
      const leaseRegistry = yield* LeaseRegistryTag;
      const connId = yield* ConnIdTag;
      if (params.dispatchLeaseId !== undefined) {
        return yield* sendWithDispatchLease({
          connId,
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
        excludeConnectionId: connId,
      });
      return { message };
    }).pipe(Effect.withSpan("messages.send")),
  );
}

export const messageHandlers: RpcMethodRegistry = [
  defineTaskMethod(MessagesSend, {
    requiresActive: true,
    handler: handleMessageSend,
  }),
  defineTaskMethod(MessagesList, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const messageService = yield* MessageServiceTag;
        const connId = yield* ConnIdTag;
        return yield* messageService.list(
          params.conversationId,
          ctx.agentId,
          connId,
          {
            limit: params.limit,
            sinceSeq: params.sinceSeq,
          },
        );
      }).pipe(Effect.withSpan("messages.list")),
  }),
];
