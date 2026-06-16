# server-core/message

_`packages/server/src/message`_

## Purpose

Message-domain service barrel.

## Public surface

### [`MessageAuthorizationConversations`](./authorization.ts#L22)

_Interface_

```ts
export interface MessageAuthorizationConversations {
  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]>;
}
```

### [`MessageAuthorizationService`](./authorization.ts#L28)

_Class_

```ts
export class MessageAuthorizationService {
  constructor(
    private readonly apps: AppEndpointRegistry,
    private readonly conversations: MessageAuthorizationConversations,
  ) {}

  authorize(
    appId: AppId,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const entry = this.apps.lookupApp(appId);
    if (entry === undefined) {
      return Effect.succeed({
        decision: "Block",
        reason: "app_unreachable",
      });
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
    }
  }

  private forwardAllExceptSender(
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
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
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const taskId = ctx.taskId;
    return wrapHookEffectWithEnvelope({
      raw: callAppRpc(entry, {
        definition: MessagesAuthorize,
        params: this.messageAuthorizeParamsForWire(ctx),
      }).pipe(Effect.map((envelope) => envelope.verdict)),
      timeoutMs,
      timeoutLogMessage: "app/message/authorize timed out",
      timeoutLogContext: { taskId, appId, timeoutMs },
      errorLogMessage: "app/message/authorize error",
      errorLogContext: { taskId, appId },
      onTimeout: () => ({
        decision: "Block",
        reason: "app_unreachable",
      }),
      onError: () => ({
        decision: "Block",
        reason: "app_unreachable",
      }),
    });
  }

  private messageAuthorizeParamsForWire(
    ctx: MessageAuthorizeContext,
  ): ParamsOf<typeof MessagesAuthorize> {
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

### [`MessageAuthorizeContext`](./authorization.ts#L13)

_TypeAlias_

```ts
export type MessageAuthorizeContext = ParamsOf<typeof MessagesAuthorize>;
```

### [`MessageAuthorizeResult`](./authorization.ts#L15)

_TypeAlias_

```ts
export type MessageAuthorizeResult =
  | {
      readonly decision: "Forward";
      readonly recipients: ReadonlyArray<AgentId>;
    }
```

### [`MessageService`](./message.service.ts#L170)

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

  close(): Effect.Effect<void, never> {
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
   */
  recordDispatchDecision(
    messageId: MessageId,
    verdict: DispatchDecision,
  ): Effect.Effect<{ committed: boolean }, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
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

  sendInsert(input: SendInsertInput): Effect.Effect<SendInsertResult, never> {
    return catchSqlErrorAsDefect(this.sendInsertEffect(input));
  }

  private sendInsertEffect(
    input: SendInsertInput,
  ): Effect.Effect<SendInsertResult, SqlError | Cause.NoSuchElementException> {
    return Effect.gen(this, function* () {
      // `ConversationSendAccess` gates this method in the engine middleware
      // stack before the handler runs, so `send` requires no permission token in
      // its Env and trusts `input` (the handler's already-gated params).
      const conv = yield* this.readSendConversation(input.conversationId);
      const parts = [...input.parts];
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
   * `(archived_at, task_id, app_id, task_status)`.
   *
   * `app_id` is read by the verdict-routing consumer to identify the
   * authorizing app for the task.
   * @internal
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
        .select([
          "c.archived_at",
          "c.task_id",
          "t.app_id as app_id",
          "t.status as task_status",
        ])
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

### [`messagesList`](./handlers.ts#L163)

_Variable_

```ts
export const messagesList: ServerHandler<typeof MessagesList> = (params)
```

### [`messagesSend`](./handlers.ts#L154)

_Variable_

```ts
export const messagesSend: ServerHandler<typeof MessagesSend> = (params)
```

## Files

- `authorization.ts`
- `handlers.ts`
- `message.service.ts`
