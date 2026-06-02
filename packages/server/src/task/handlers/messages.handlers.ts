import {
  MessagesSend,
  MessagesList,
  MessagesSendAuth,
  MessagesListAuth,
  NotFoundError,
  ForbiddenError,
  ConversationInTask,
  MessageSendPermission,
  TaskReadAccess,
  type LeaseId,
  type ParamsOf,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { agentArm, toWireError } from "../../app/native-handlers-runtime.js";
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

function handleMessageList(
  params: ParamsOf<typeof MessagesList>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const messageService = yield* MessageServiceTag;
    return yield* messageService.list(params.conversationId, ctx.agentId, {
      limit: params.limit,
      sinceSeq: params.sinceSeq,
    });
  }).pipe(Effect.withSpan("messages.list"));
}

// ── Native @effect/rpc handler bodies ───────────────────────────────────────
//
// Each reads its method's `*Auth` proof for the cap proofs (the per-method
// `*AuthMw` ran them and keyed each by its cap tag's `key`), provides them as
// services, narrows the arm via `agentArm`, and runs the SAME body the live slot
// path runs. The domain error channel maps to the wire envelope each member
// carries; `ConnectionTag` + the service tags ride out, provided by the request
// runtime; the native engine excludes the proof tag.

export const nativeMessagesSend = (params: MessagesSendParams) =>
  Effect.gen(function* () {
    const auth = yield* MessagesSendAuth;
    const ctx = yield* agentArm;
    return yield* handleMessageSend(params, ctx).pipe(
      Effect.provideService(
        MessageSendPermission,
        auth[MessageSendPermission.key],
      ),
      Effect.provideService(ConversationInTask, auth[ConversationInTask.key]),
    );
  }).pipe(Effect.withSpan("nativeMessagesSend"), Effect.mapError(toWireError));

export const nativeMessagesList = (params: ParamsOf<typeof MessagesList>) =>
  Effect.gen(function* () {
    const auth = yield* MessagesListAuth;
    const ctx = yield* agentArm;
    return yield* handleMessageList(params, ctx).pipe(
      Effect.provideService(ConversationInTask, auth[ConversationInTask.key]),
      Effect.provideService(TaskReadAccess, auth[TaskReadAccess.key]),
    );
  }).pipe(Effect.withSpan("nativeMessagesList"), Effect.mapError(toWireError));
