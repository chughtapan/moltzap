import { Data, Effect, Option } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import type { DispatchId, LeaseId } from "@moltzap/protocol/message/dispatch";
import type { MessageParts } from "@moltzap/protocol/message";
import type { AgentId, AppId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { AppEndpointRegistry } from "#identity/apps";
import { type Db, catchSqlErrorAsDefect, takeFirstOption } from "#db";
import type {
  LeaseRegistry,
  ModeratorBoundLeaseBinding,
} from "./lease-registry.js";

interface AppBoundConversationLookup {
  readonly _tag: "AppBound";
  readonly appId: AppId;
}

/**
 * Dispatch admission is only defined for app-bound conversations. The
 * success type has no non-app-bound arm, so downstream lease minting
 * cannot accidentally handle one as a lease binding.
 * @param db Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @returns The lookup app bound for conversation result.
 */
function lookupAppBoundForConversation(
  db: Db,
  conversationId: ConversationId,
): Effect.Effect<AppBoundConversationLookup> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const rowOpt = yield* takeFirstOption(
        db
          .selectFrom("conversations")
          .select(["conversations.app_id"])
          .where("conversations.id", "=", conversationId)
          .where("conversations.app_id", "is not", null)
          .limit(1),
      );
      if (Option.isNone(rowOpt) || rowOpt.value.app_id === null) {
        return yield* Effect.dieMessage(
          `agent/dispatch/request requires an app-bound conversation: ${conversationId}`,
        );
      }
      const lookup: AppBoundConversationLookup = {
        _tag: "AppBound",
        appId: rowOpt.value.app_id,
      };
      return lookup;
    }).pipe(Effect.withSpan("lookupAppBoundForConversation")),
  );
}

type PendingDispatchMessage = Readonly<{
  messageId: MessageId;
  conversationId: ConversationId;
  senderAgentId: AgentId;
  createdAt: string;
  receivedAt: string;
  parts?: MessageParts;
}>;

/** Describes enqueue dispatch request args. */
export interface EnqueueDispatchRequestArgs {
  readonly conversationId: ConversationId;
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: ConnectionId;
  readonly messageId: MessageId;
  readonly senderAgentId: AgentId;
  readonly parts?: MessageParts;
  readonly attempt?: number;
  readonly receivedAt?: string;
  readonly pending?: readonly PendingDispatchMessage[];
}

class DispatchAppUnavailableError extends Data.TaggedError(
  "DispatchAppUnavailableError",
)<{
  readonly appId: AppId;
  readonly conversationId: ConversationId;
}> {
  override get message(): string {
    return `agent/dispatch/request cannot mint a moderator-bound lease because app ${this.appId} is unavailable for conversation ${this.conversationId}`;
  }
}

/**
 * Dispatch admission is a static grant: every `agent/dispatch/request`
 * mints a lease and resolves it granted before the ack returns. The
 * server applies no admission policy — pacing decisions are the
 * receiving endpoint's.
 */
export class DispatchAdmissionService {
  private readonly db: Db;
  private readonly apps: AppEndpointRegistry;
  private readonly registry: LeaseRegistry;

  constructor(db: Db, apps: AppEndpointRegistry, registry: LeaseRegistry) {
    this.db = db;
    this.apps = apps;
    this.registry = registry;
  }

  enqueue(args: EnqueueDispatchRequestArgs): Effect.Effect<{
    readonly leaseId: LeaseId;
    readonly dispatchId: DispatchId;
  }> {
    return catchSqlErrorAsDefect(this.enqueueEffect(args));
  }

  private enqueueEffect(
    args: EnqueueDispatchRequestArgs,
  ): Effect.Effect<
    { readonly leaseId: LeaseId; readonly dispatchId: DispatchId },
    SqlError
  > {
    return Effect.gen(
      function* (this: DispatchAdmissionService) {
        const lookup = yield* lookupAppBoundForConversation(
          this.db,
          args.conversationId,
        );
        const binding = yield* this.dispatchLeaseBindingForLookup(args, lookup);
        const minted = yield* this.registry.mint(binding);
        yield* this.registry
          .resolve(minted.leaseId, { _tag: "grant" })
          .pipe(Effect.ignore);
        return minted;
      }.bind(this),
    );
  }

  private dispatchLeaseBindingForLookup(
    args: EnqueueDispatchRequestArgs,
    lookup: AppBoundConversationLookup,
  ): Effect.Effect<ModeratorBoundLeaseBinding> {
    const entry = this.apps.lookupApp(lookup.appId);
    if (entry === undefined) {
      return Effect.die(
        new DispatchAppUnavailableError({
          appId: lookup.appId,
          conversationId: args.conversationId,
        }),
      );
    }

    return Effect.succeed({
      _tag: "ModeratorBound",
      recipientAgentId: args.recipientAgentId,
      recipientConnectionId: args.recipientConnectionId,
      conversationId: args.conversationId,
      appId: lookup.appId,
      moderatorConnectionId: entry.endpoint.connId,
    });
  }
}
