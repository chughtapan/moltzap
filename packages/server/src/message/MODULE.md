# server-core/message

_`packages/server/src/message`_

## Purpose

Message-domain service barrel.

## Public surface

### [`MessageService`](./message.service.ts#L91)

_Class_

```ts
export class MessageService {
  private readonly db: Db;
  private readonly conversations: ConversationService;
  private readonly networkSendService: NetworkSendService;

  constructor(deps: MessageServiceDeps) {
    this.db = deps.db;
    this.conversations = deps.conversations;
    this.networkSendService = deps.networkSend;
  }

  close(): Effect.Effect<void> {
    return Effect.void;
  }

  sendInsert(input: SendInsertInput): Effect.Effect<SendInsertResult> {
    return catchSqlErrorAsDefect(this.sendInsertEffect(input));
  }

  private sendInsertEffect(
    input: SendInsertInput,
  ): Effect.Effect<SendInsertResult, SqlError | Cause.NoSuchElementException> {
    return Effect.gen(
      function* (this: MessageService) {
        // `ConversationSendAccess` gates this method in the engine middleware
        // stack before the handler runs, so `send` requires no permission token in
        // its Env and trusts `input` (the handler's already-gated params).
        yield* this.readSendConversation(input.conversationId);
        const parts = input.parts;
        const row = yield* this.insertMessageRow(input);
        return {
          message: this.mapMessage(row, parts),
          parts,
          excludeConnectionId: input.excludeConnectionId,
        };
      }.bind(this),
    );
  }

  /**
   * Send-conversation projection consumed by the `ConversationSendAccess`
   * `obtain` to prove the conversation row exists before the send handler
   * runs.
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The send-conversation row.
   */
  readSendConversation(
    conversationId: ConversationId,
  ): Effect.Effect<
    SendConversationRow,
    SqlError | Cause.NoSuchElementException
  > {
    return takeFirstOrFail(
      this.db
        .selectFrom("conversations")
        .select(["id"])
        .where("id", "=", conversationId),
    );
  }

  private insertMessageRow(
    input: SendInsertInput,
  ): Effect.Effect<MessageRow, SqlError> {
    const messageIdValue = decodeMessageId(crypto.randomUUID());
    const createdAtIso = new Date().toISOString();
    return Effect.tryPromise({
      try: () =>
        this.db
          .insertInto("messages")
          .values({
            id: messageIdValue,
            conversation_id: input.conversationId,
            sender_id: input.senderAgentId,
            seq: nextSnowflakeId().toString(),
            parts: JSON.stringify(input.parts),
            created_at: new Date(createdAtIso),
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      catch: (cause) =>
        new SqlError({ cause, message: "insert messages failed" }),
    });
  }

  /**
   * Broadcast and trace tail: participants-minus-sender fan-out.
   *
   * Participant fan-out is best-effort after the durable insert. Offline
   * participants are not a send failure: `broadcast` reports which agent IDs
   * were reached, `recordTrace` observes the misses, and reconnecting clients
   * recover recent durable history within the requested `messages/list` limit.
   * @param carrier Value supplied to the operation.
   * @param conversationId Value supplied to the operation.
   * @param senderAgentId Value supplied to the operation.
   * @returns The committed message.
   */
  sendCommit(
    carrier: SendInsertResult,
    conversationId: ConversationId,
    senderAgentId: AgentId,
  ): Effect.Effect<Message> {
    return catchSqlErrorAsDefect(
      this.sendCommitEffect({ carrier, conversationId, senderAgentId }),
    );
  }

  private sendCommitEffect(
    input: SendCommitInput,
  ): Effect.Effect<Message, SqlError> {
    return Effect.gen(
      function* (this: MessageService) {
        const participants = yield* this.conversations.getParticipantAgentIds(
          input.conversationId,
        );
        const recipientList = participants.filter(
          (id) => id !== input.senderAgentId,
        );
        const delivered = yield* this.broadcastCommittedMessage(
          input,
```

`agent/message/send` server entry point. The `send` method persists the
message durably, then broadcasts it to every conversation participant
except the sender. The router is content-blind: it applies no
interpretation or policy to the message body.

### [`messageServiceLive`](./layer.ts#L18)

_Variable_

```ts
export const messageServiceLive = Layer.effect(
  MessageServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const networkSend = yield* NetworkSendServiceTag;
    return new MessageService({
      db,
      conversations,
      networkSend,
    });
  }).pipe(Effect.withSpan("MessageServiceLive")),
)
```

Provides the message service live runtime value.

### [`MessageServiceTag`](./layer.ts#L12)

_Class_

```ts
export class MessageServiceTag extends Context.Tag("moltzap/MessageService")<
  MessageServiceTag,
  MessageService
>() {}
```

Implements message service tag.

### [`messagesList`](./handlers.ts#L64)

_Variable_

```ts
export const messagesList: ServerHandler<typeof messagesListDefinition> =
  Effect.fn("messagesList")(function* (params) {
    // Conversation participation is the whole read gate, asserted by
    // `MessageService.list` before any row is projected.
    const ctx = yield* agentArm;
    return yield* handleMessageList(params, ctx);
  })
```

Provides the messages list runtime value.

**Returns:** The messages list result.

### [`messagesSend`](./handlers.ts#L50)

_Variable_

```ts
export const messagesSend: ServerHandler<typeof messagesSendDefinition> =
  Effect.fn("messagesSend")(function* (params) {
    // The send-permission requirements gated this frame in the engine stack
    // before this handler runs. `agentArm` reads the narrowed principal off
    // `ConnectionTag`.
    const ctx = yield* agentArm;
    return yield* handleMessageSend(params, ctx);
  })
```

Provides the messages send runtime value.

**Returns:** The messages send result.

## Files

- `handlers.ts`
- `layer.ts`
- `message.service.ts`
