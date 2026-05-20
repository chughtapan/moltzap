import type { RpcMethodRegistry } from "../../transport/context.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import {
  MessagesSend,
  MessagesList,
  NotFoundError,
  ForbiddenError,
  type ConversationId,
  type LeaseId,
  type ParamsOf,
} from "@moltzap/protocol";
import { Effect, Exit, Option } from "effect";
import { InvalidParamsError } from "../../runtime/index.js";
import type { AuthenticatedContext } from "../../transport/context.js";
import type { Db } from "../../db/client.js";
import {
  ConnIdTag,
  ConversationServiceTag,
  DbTag,
  LeaseRegistryTag,
  MessageServiceTag,
  TaskServiceTag,
} from "../../app/layers.js";
import { LeaseInvalidError } from "../../app/lease-registry.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";
import type { LeaseRegistry } from "../../app/lease-registry.js";
import type { ConversationService } from "../services/conversation.service.js";
import type { MessageService } from "../services/message.service.js";
import type { TaskService } from "../services/task.service.js";
import {
  MessageSendPermission,
  obtainMessageSendPermission,
} from "../../app/capabilities/index.js";

type MessagesSendParams = ParamsOf<typeof MessagesSend>;

interface SendServices {
  readonly conversationService: ConversationService;
  readonly db: Db;
  readonly leaseRegistry: LeaseRegistry;
  readonly messageService: MessageService;
  readonly taskService: TaskService;
}

/** Parse "agent:&lt;name>" target format, returning the agent name. */
function parseTo(to: string): Effect.Effect<string, InvalidParamsError> {
  const match = to.match(/^agent:(.+)$/);
  if (!match) {
    return Effect.fail(
      new InvalidParamsError({
        message: "Invalid 'to' format — use agent:<name>",
      }),
    );
  }
  return Effect.succeed(match[1]!);
}

function resolveConversationId(
  params: MessagesSendParams,
  ctx: AuthenticatedContext,
  services: SendServices,
) {
  return Effect.gen(function* () {
    if (params.conversationId !== undefined) {
      return params.conversationId;
    }
    if (params.to !== undefined) {
      const agentName = yield* parseTo(params.to);
      const conversation =
        yield* services.conversationService.createDmByAgentName(
          agentName,
          ctx.agentId,
          services.taskService.createDefaultTaskForType("dm", ctx.agentId),
        );
      return conversation.id;
    }
    if (params.replyToId !== undefined) {
      return yield* conversationIdFromReply(params.replyToId, services.db);
    }
    return yield* Effect.fail(
      new InvalidParamsError({
        message: "Either conversationId, to, or replyToId is required",
      }),
    );
  }).pipe(Effect.withSpan("messages.resolveConversationId"));
}

function conversationIdFromReply(
  replyToId: NonNullable<MessagesSendParams["replyToId"]>,
  db: Db,
) {
  return Effect.gen(function* () {
    const parentOpt = yield* takeFirstOption(
      db
        .selectFrom("messages")
        .select(["conversation_id"])
        .where("id", "=", replyToId),
    );
    if (Option.isNone(parentOpt)) {
      return yield* Effect.fail(
        new NotFoundError({
          message: `Cannot resolve replyToId ${replyToId}: message not found`,
        }),
      );
    }
    return parentOpt.value.conversation_id;
  }).pipe(Effect.withSpan("messages.conversationIdFromReply"));
}

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
  readonly connId: string;
  readonly conversationId: ConversationId;
  readonly ctx: AuthenticatedContext;
  readonly params: MessagesSendParams;
  readonly services: SendServices;
}

function sendWithDispatchLease(input: LeaseSendInput) {
  return Effect.gen(function* () {
    const leaseId = input.params.dispatchLeaseId as LeaseId;
    let finalized = false;
    const message = yield* Effect.scoped(
      Effect.acquireUseRelease(
        claimDispatchLease(input.services.leaseRegistry, leaseId),
        (claim) =>
          Effect.gen(function* () {
            // Hand-piped MessageSendPermission — see `messages.ts → MessagesSend`
            // for the descriptor-level note explaining why this slot
            // doesn't auto-provision (the obtain helper needs the
            // resolved conversationId, post-resolution).
            const carrier = yield* input.services.messageService
              .sendInsert({
                conversationId: input.conversationId,
                parts: input.params.parts,
                senderAgentId: input.ctx.agentId,
                replyToId: input.params.replyToId,
                excludeConnectionId: input.connId,
                bypassTmRouting: false,
              })
              .pipe(
                Effect.provideServiceEffect(
                  MessageSendPermission,
                  obtainMessageSendPermission({
                    conversationId: input.conversationId,
                    senderAgentId: input.ctx.agentId,
                    replyToId: input.params.replyToId,
                  }),
                ),
              );
            yield* claim.finalize(carrier.message.id).pipe(Effect.ignore);
            finalized = true;
            return yield* input.services.messageService.sendCommit(
              carrier,
              input.conversationId,
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
      const services: SendServices = {
        conversationService: yield* ConversationServiceTag,
        db: yield* DbTag,
        leaseRegistry: yield* LeaseRegistryTag,
        messageService: yield* MessageServiceTag,
        taskService: yield* TaskServiceTag,
      };
      const connId = yield* ConnIdTag;
      const conversationId = yield* resolveConversationId(
        params,
        ctx,
        services,
      );
      if (params.dispatchLeaseId !== undefined) {
        return yield* sendWithDispatchLease({
          connId,
          conversationId,
          ctx,
          params,
          services,
        });
      }
      // `MessagesSend` is the lone descriptor whose `MessageSendPermission`
      // is hand-piped (not auto-provisioned by the dispatcher): the obtain
      // helper needs the RESOLVED `conversationId` (from to: / replyToId:
      // lookup above), which the dispatcher's argsOf can't see — only the
      // raw wire params. See packages/protocol/src/task/messages.ts →
      // MessagesSend for the design rationale.
      const message = yield* services.messageService
        .send({
          conversationId,
          parts: params.parts,
          senderAgentId: ctx.agentId,
          replyToId: params.replyToId,
          excludeConnectionId: connId,
        })
        .pipe(
          Effect.provideServiceEffect(
            MessageSendPermission,
            obtainMessageSendPermission({
              conversationId,
              senderAgentId: ctx.agentId,
              replyToId: params.replyToId,
            }),
          ),
        );
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
        return yield* messageService.list(params.conversationId, ctx.agentId, {
          limit: params.limit,
        });
      }).pipe(Effect.withSpan("messages.list")),
  }),
];
