import { DispatchNotFoundError } from "@moltzap/protocol/message/dispatch";
import { MessagesList, MessagesSend } from "@moltzap/protocol/message";
import { ForbiddenError } from "@moltzap/protocol/transport";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import type { ParamsOf } from "@moltzap/protocol/transport";
import type { ConnectionId, ServerHandler } from "@moltzap/protocol/socket";
import { agentArm } from "#core";
import { Effect, Exit } from "effect";
import type { AgentContext } from "#socket";
import { ConnectionTag, LeaseRegistryTag, MessageServiceTag } from "#core";
import {
  guardTaskActive,
  guardConversationNotArchived,
  guardReplyTarget,
  obtainConversationSendAccess,
} from "../services/send-permissions.js";
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
          new DispatchNotFoundError({ message: `lease ${leaseId} not found` }),
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
    const leaseId = input.params.dispatchLeaseId;
    if (leaseId === undefined) {
      return yield* Effect.dieMessage(
        "messages/send dispatch lease path called without dispatchLeaseId",
      );
    }
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
      // The `ConversationSendAccess` requirement already gates the frame. The
      // body still needs the joined send row for task/conversation guards, so it
      // reads that row directly here.
      const sendRow = yield* obtainConversationSendAccess({
        conversationId: params.conversationId,
        senderAgentId: ctx.agentId,
        taskId: params.taskId,
      });
      yield* guardTaskActive(sendRow);
      yield* guardConversationNotArchived(sendRow);
      yield* guardReplyTarget({
        conversationId: params.conversationId,
        replyToId: params.replyToId,
      });
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

// ── @effect/rpc handler bodies ───────────────────────────────────────
//
// Requirement middleware gates each frame before these bodies run. The bodies
// narrow the arm via `agentArm`, run the same domain work as the live slot path,
// and leave `ConnectionTag` + domain services to the request runtime.

export const messagesSend: ServerHandler<typeof MessagesSend> = (params) =>
  Effect.gen(function* () {
    // The send-permission requirements gated this frame in the engine stack
    // before this handler runs. `agentArm` reads the narrowed principal off
    // `ConnectionTag`.
    const ctx = yield* agentArm;
    return yield* handleMessageSend(params, ctx);
  }).pipe(Effect.withSpan("messagesSend"));

export const messagesList: ServerHandler<typeof MessagesList> = (params) =>
  Effect.gen(function* () {
    // Gated by the `TaskReadAccess` + `ConversationInTask` requirements in the
    // engine stack; the body trusts the gated `params`.
    const ctx = yield* agentArm;
    return yield* handleMessageList(params, ctx);
  }).pipe(Effect.withSpan("messagesList"));
