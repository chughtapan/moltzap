# server-core/message

_`packages/server/src/message`_

## Purpose

Message-domain service barrel.

## Public surface

### [`MessageAuthorizationConversations`](./authorization.ts#L25)

_Interface_

```ts
export interface MessageAuthorizationConversations {
  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]>;
}
```

Describes message authorization conversations.

### [`MessageAuthorizationService`](./authorization.ts#L38)

_Class_

```ts
export class MessageAuthorizationService {
  private readonly apps: AppEndpointRegistry;
  private readonly conversations: MessageAuthorizationConversations;

  constructor(
    apps: AppEndpointRegistry,
    conversations: MessageAuthorizationConversations,
  ) {
    this.apps = apps;
    this.conversations = conversations;
  }

  authorize(
    appId: AppId,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult> {
    const entry = this.apps.lookupApp(appId);
    if (entry === undefined) {
      return Effect.succeed(APP_UNREACHABLE_BLOCK);
    }

    const policy = entry.manifest.hooks.message_authorize;
    switch (policy.kind) {
      case "forwardAllExceptSender":
        return this.forwardAllExceptSender(ctx);
      case "deny":
        return Effect.succeed({
          decision: "Block",
          reason: policy.reason,
        });
      case "hook":
        return this.messageAuthorizeHook(entry, appId, ctx, policy.timeoutMs);
      default: {
        const exhaustive: never = policy;
        return exhaustive;
      }
    }
  }

  private forwardAllExceptSender(
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult> {
    return this.conversations.getParticipantAgentIds(ctx.conversationId).pipe(
      Effect.map(
        (participants): MessageAuthorizeResult => ({
          decision: "Forward",
          recipients: participants.filter(
            (id) => id !== ctx.message.senderAgentId,
          ),
        }),
      ),
      Effect.withSpan("message.authorization.forwardAllExceptSender"),
    );
  }

  private messageAuthorizeHook(
    entry: AppRegistration,
    appId: AppId,
    ctx: MessageAuthorizeContext,
    timeoutMs: number,
  ): Effect.Effect<MessageAuthorizeResult> {
    const taskId = ctx.taskId;
    return wrapHookEffectWithEnvelope({
      raw: callAppRpc(entry, {
        definition: messagesAuthorize,
        params: this.messageAuthorizeParamsForWire(ctx),
      }).pipe(Effect.map((envelope) => envelope.verdict)),
      timeoutMs,
      timeoutLogMessage: "app/message/authorize timed out",
      timeoutLogContext: { taskId, appId, timeoutMs },
      errorLogMessage: "app/message/authorize error",
      errorLogContext: { taskId, appId },
      onTimeout: () => APP_UNREACHABLE_BLOCK,
      onError: () => APP_UNREACHABLE_BLOCK,
    });
  }

  private messageAuthorizeParamsForWire(
    ctx: MessageAuthorizeContext,
  ): ParamsOf<typeof messagesAuthorize> {
    return {
      taskId: ctx.taskId,
      appId: ctx.appId,
      conversationId: ctx.conversationId,
      message: {
        id: ctx.message.id,
        senderAgentId: ctx.message.senderAgentId,
        ...(ctx.message.parts !== undefined
          ? { parts: ctx.message.parts }
          : {}),
      },
      ...(ctx.receivedAt !== undefined ? { receivedAt: ctx.receivedAt } : {}),
    };
  }
}
```

Implements message authorization service.

### [`messageAuthorizationServiceLive`](./layer.ts#L26)

_Variable_

```ts
export const messageAuthorizationServiceLive = Layer.effect(
  MessageAuthorizationServiceTag,
  Effect.gen(function* () {
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    const conversations = yield* ConversationServiceTag;
    return new MessageAuthorizationService(appEndpointRegistry, conversations);
  }).pipe(Effect.withSpan("MessageAuthorizationServiceLive")),
)
```

Provides the message authorization service live runtime value.

### [`MessageAuthorizationServiceTag`](./layer.ts#L15)

_Class_

```ts
export class MessageAuthorizationServiceTag extends Context.Tag(
  "moltzap/MessageAuthorizationService",
)<MessageAuthorizationServiceTag, MessageAuthorizationService>() {}
```

Implements message authorization service tag.

### [`MessageAuthorizeContext`](./authorization.ts#L14)

_TypeAlias_

```ts
export type MessageAuthorizeContext = ParamsOf<typeof messagesAuthorize>;
```

Represents message authorize context values.

### [`MessageAuthorizeResult`](./authorization.ts#L17)

_TypeAlias_

```ts
export type MessageAuthorizeResult =
  | {
      readonly decision: "Forward";
      readonly recipients: readonly AgentId[];
    }
```

Represents the result of message authorize.

### [`MessageService`](./message.service.ts#L178)

_Class_

```ts
export class MessageService {
  private readonly db: Db;
  private readonly conversations: ConversationService;
  private readonly networkSendService: NetworkSendService;
  private readonly encryption: EnvelopeEncryption | null;
  private readonly messageAuthorization: MessageAuthorizationService;

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
    this.networkSendService = deps.networkSend;
    this.encryption = deps.encryption;
    this.messageAuthorization = deps.messageAuthorization;
  }

  close(): Effect.Effect<void> {
    return Effect.void;
  }

  /**
   * CAS-guarded UPDATE of `messages.dispatch_decision` after the
   * `app/message/authorize` gate resolves.
   *
   * Each row inserts with `{tag: "pending"}` in {@link sendInsert};
   * this method transitions to `{tag: "forward", recipients}` or
   * `{tag: "block", reason}` exactly once.
   *
   * The CAS guard restricts the UPDATE to rows currently in the
   * `pending` tag. Two concurrent transitions (real verdict racing a
   * timeout-synthesized fallback) cannot both succeed: whichever
   * commits first wins, the loser sees `committed: false` and
   * skips the dependent broadcast.
   * @param messageId Value supplied to the operation.
   * @param verdict Value supplied to the operation.
   * @returns The result result.
   */
  recordDispatchDecision(
    messageId: MessageId,
    verdict: DispatchDecision,
  ): Effect.Effect<{ committed: boolean }> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: MessageService) {
        // CAS predicate via JSONB containment (`@>`), which Postgres
        // binds as a query parameter. The UPDATE returns one row iff the
        // row was still `pending` at UPDATE time; concurrent transitions
        // see committed=false and skip the dependent broadcast.
        const result = yield* Effect.tryPromise({
          try: () =>
            this.db
              .updateTable("messages")
              .set({ dispatch_decision: verdict })
              .where("id", "=", messageId)
              .where(
                "dispatch_decision",
                "@>",
                JSON.stringify({ tag: "pending" }),
              )
              .returning("id")
              .execute(),
          catch: (cause) =>
            new SqlError({
              cause,
              message: "recordDispatchDecision UPDATE failed",
            }),
        });
        return { committed: result.length === 1 };
      }),
    );
  }

  sendInsert(input: SendInsertInput): Effect.Effect<SendInsertResult> {
    return catchSqlErrorAsDefect(this.sendInsertEffect(input));
  }

  private sendInsertEffect(
    input: SendInsertInput,
  ): Effect.Effect<SendInsertResult, SqlError | Cause.NoSuchElementException> {
    return Effect.gen(this, function* (this: MessageService) {
      // `ConversationSendAccess` gates this method in the engine middleware
      // stack before the handler runs, so `send` requires no permission token in
      // its Env and trusts `input` (the handler's already-gated params).
      const conv = yield* this.readSendConversation(input.conversationId);
      const parts = input.parts;
      const encrypted = yield* this.encryptParts(input.conversationId, parts);
      const row = yield* this.insertMessageRow(input, conv, encrypted);
      return {
        message: this.mapMessage(row, parts),
        parts,
        conv,
        excludeConnectionId: input.excludeConnectionId,
      };
    });
  }

  /**
   * Send-conversation projection consumed by the `ConversationSendAccess`
   * `obtain` AND
   * `MessageService.sendCommit`'s `app/message/authorize` verdict route.
   * Joins `conversations` ⋈ `tasks` and returns
   * `(task_id, app_id, task_status)`.
   *
   * `app_id` is read by the verdict-routing consumer to identify the
   * authorizing app for the task.
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The joined send-conversation row.
   */
  readSendConversation(
    conversationId: ConversationId,
  ): Effect.Effect<
    SendConversationRow,
    SqlError | Cause.NoSuchElementException
  > {
    return takeFirstOrFail(
      this.db
        .selectFrom("conversations as c")
        .innerJoin("tasks as t", "t.id", "c.task_id")
        .select(["c.task_id", "c.app_id as app_id", "t.status as task_status"])
        .where("c.id", "=", conversationId),
    );
```

`agent/message/send` server entry point. The `send` method runs the
structural checks against `(conversations ⋈ tasks)`, persists the
message, then resolves the dispatch-authorization verdict via the
`app/message/authorize` round-trip and broadcasts per verdict.

Branch over `task.status`:
- `{closed, failed}` → fail closed with `TaskClosed`; no insert.
- `{waiting, active}` → insert + `app/message/authorize` verdict +
  verdict-scoped broadcast.

The `app/message/authorize` round-trip is the authorization gate:
`MessageAuthorizationService` fails closed (`Block { reason:
"app_unreachable" }`) on timeout, handler error, or RPC failure. On
Forward, `network.send` broadcasts to `verdict.recipients`; on Block, the
call fails with `HookBlocked`.

### [`messageServiceLive`](./layer.ts#L36)

_Variable_

```ts
export const messageServiceLive = Layer.effect(
  MessageServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const networkSend = yield* NetworkSendServiceTag;
    const encryption = yield* EncryptionTag;
    const messageAuthorization = yield* MessageAuthorizationServiceTag;
    return new MessageService({
      db,
      conversations,
      networkSend,
      encryption,
      messageAuthorization,
    });
  }).pipe(Effect.withSpan("MessageServiceLive")),
)
```

Provides the message service live runtime value.

### [`MessageServiceTag`](./layer.ts#L20)

_Class_

```ts
export class MessageServiceTag extends Context.Tag("moltzap/MessageService")<
  MessageServiceTag,
  MessageService
>() {}
```

Implements message service tag.

### [`messagesList`](./handlers.ts#L175)

_Variable_

```ts
export const messagesList: ServerHandler<typeof messagesListDefinition> = (
  params,
)
```

Provides the messages list runtime value.

**Returns:** The messages list result.

### [`messagesSend`](./handlers.ts#L159)

_Variable_

```ts
export const messagesSend: ServerHandler<typeof messagesSendDefinition> = (
  params,
)
```

Provides the messages send runtime value.

**Returns:** The messages send result.

## Files

- `authorization.ts`
- `handlers.ts`
- `layer.ts`
- `message.service.ts`
