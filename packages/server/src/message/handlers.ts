import {
  DispatchNotFoundError,
  type LeaseId,
} from "@moltzap/protocol/message/dispatch";
import type {
  messagesList as messagesListDefinition,
  messagesSend as messagesSendDefinition,
} from "@moltzap/protocol/message";
import { ForbiddenError, type ParamsOf } from "@moltzap/protocol/rpc";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import { agentArm } from "#moltzap/runtime";
import { Effect, Exit } from "effect";
import { ConnectionTag, type AgentContext } from "#socket";
import {
  LeaseRegistryTag,
  type LeaseInvalidError,
  type LeaseRegistry,
} from "#dispatch";
import { MessageServiceTag } from "./layer.js";
import type { MessageService } from "./message.service.js";

type MessagesSendParams = ParamsOf<typeof messagesSendDefinition>;

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
              expected:
                /* Safe because the surrounding invariant establishes this asserted shape. */ err.expected as readonly string[],
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

const sendWithDispatchLease = Effect.fn("messages.sendWithDispatchLease")(
  function* (input: LeaseSendInput) {
    const leaseId = input.params.dispatchLeaseId;
    if (leaseId === undefined) {
      return yield* Effect.dieMessage(
        "agent/message/send dispatch lease path called without dispatchLeaseId",
      );
    }
    let finalized = false;
    const message = yield* Effect.scoped(
      Effect.acquireUseRelease(
        claimDispatchLease(input.leaseRegistry, leaseId),
        Effect.fn("messages.sendWithLease")(function* (claim) {
          const carrier = yield* input.messageService.sendInsert({
            conversationId: input.params.conversationId,
            parts: input.params.parts,
            senderAgentId: input.ctx.agentId,
            taskId: input.params.taskId,
            excludeConnectionId: input.connId,
          });
          yield* claim.finalize(carrier.message.id).pipe(Effect.ignore);
          finalized = true;
          return yield* input.messageService.sendCommit(
            carrier,
            input.params.conversationId,
            input.ctx.agentId,
          );
        }),
        (claim, exit) => {
          if (Exit.isSuccess(exit) || finalized) {
            return Effect.void;
          }
          return claim.rollback.pipe(Effect.ignore);
        },
      ),
    );
    return { message };
  },
);

const handleMessageSend = Effect.fn("messages.send")(function* (
  params: MessagesSendParams,
  ctx: AgentContext,
) {
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
    taskId: params.taskId,
    excludeConnectionId: connection.connId,
  });
  return { message };
});

const handleMessageList = Effect.fn("messages.list")(function* (
  params: ParamsOf<typeof messagesListDefinition>,
  ctx: AgentContext,
) {
  const messageService = yield* MessageServiceTag;
  return yield* messageService.list(params.conversationId, ctx.agentId, {
    limit: params.limit,
  });
});

// ── @effect/rpc handler bodies ───────────────────────────────────────
//
// Requirement middleware gates each frame before these bodies run. The bodies
// narrow the arm via `agentArm`, run the same domain work as the live slot path,
// and leave `ConnectionTag` + domain services to the request runtime.

/**
 * Provides the messages send runtime value.
 * @param params Request payload to process.
 * @returns The messages send result.
 */
export const messagesSend: ServerHandler<typeof messagesSendDefinition> =
  Effect.fn("messagesSend")(function* (params) {
    // The send-permission requirements gated this frame in the engine stack
    // before this handler runs. `agentArm` reads the narrowed principal off
    // `ConnectionTag`.
    const ctx = yield* agentArm;
    return yield* handleMessageSend(params, ctx);
  });

/**
 * Provides the messages list runtime value.
 * @param params Request payload to process.
 * @returns The messages list result.
 */
export const messagesList: ServerHandler<typeof messagesListDefinition> =
  Effect.fn("messagesList")(function* (params) {
    // Conversation participation is the whole read gate, asserted by
    // `MessageService.list` before any row is projected.
    const ctx = yield* agentArm;
    return yield* handleMessageList(params, ctx);
  });
