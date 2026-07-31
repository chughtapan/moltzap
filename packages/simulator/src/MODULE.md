# simulator/src

_`packages/simulator/src`_

## Purpose

Code-first simulator API.

## Public surface

### [`AgentConnection`](./network/router.ts#L125)

_Interface_

```ts
export interface AgentConnection<Name extends string = string> {
  readonly agent: AgentHandle<Name>;
  readonly key: AgentKey;
  readonly routerUrl: ServerBaseUrl;
  awaitReady(within: Duration.Duration): Effect.Effect<void, NetworkFailure>;
}
```

Runtime connection issued by every router implementation. A
runtime chooses its own startup deadline and awaits router-visible readiness
before completing acquisition.

### [`AgentHandle`](./network/participant.ts#L58)

_Class_

```ts
export class AgentHandle<
  Name extends string = string,
> extends ParticipantHandle<Name> {
  readonly [agentHandleTypeId] = agentHandleTypeId;

  private constructor(name: Name, id: AgentId) {
    super(name, id);
  }

  static [agentHandleConstruction]<const Name extends string>(
    name: Name,
    id: AgentId,
  ): AgentHandle<Name> {
    return new AgentHandle(name, id);
  }
}
```

A participant whose autonomous runtime is owned by the run scope.

### [`AgentProcessExited`](./events/core.ts#L86)

_Class_

```ts
export class AgentProcessExited extends Schema.TaggedClass<AgentProcessExited>()(
  "moltzap.agent-process-exited/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
    code: Schema.NonNegativeInt,
  },
) {}
```

A roster runtime process terminated with an operating-system exit code.

### [`AgentProcessSignaled`](./events/core.ts#L97)

_Class_

```ts
export class AgentProcessSignaled extends Schema.TaggedClass<AgentProcessSignaled>()(
  "moltzap.agent-process-signaled/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
    signal: Schema.NonEmptyString,
  },
) {}
```

A roster runtime process terminated because it received a signal.

### [`AgentRoster`](./runtime/roster.ts#L62)

_Interface_

```ts
export class AgentRoster<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly [agentRosterTypeId] = agentRosterTypeId;

  readonly definitionId: Id;
  readonly definitions: Definitions;
  readonly validatedDefinitions: readonly ValidatedAgentDefinition[];
  readonly startedAgents: Context.Tag<
    AgentsService<Id, Definitions>,
    StartedAgentHandles<Definitions>
  >;

  private constructor(
    definitionId: Id,
    definitions: Definitions,
    validatedDefinitions: readonly ValidatedAgentDefinition[],
    startedAgents: Context.Tag<
      AgentsService<Id, Definitions>,
      StartedAgentHandles<Definitions>
    >,
  ) {
    this.definitionId = definitionId;
    this.definitions = definitions;
    this.validatedDefinitions = validatedDefinitions;
    this.startedAgents = startedAgents;
  }

  static make<
    const Id extends string,
    const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  >(
    definitionId: Id,
    runtimes: Definitions,
  ): AgentRoster<Id, Definitions> {
    const entries = Object.entries(runtimes);
    const validatedDefinitions = Object.freeze(
      entries.map(([name, runtime]) =>
        Object.freeze({
          name,
          agentName: Schema.decodeUnknownSync(agentName)(name),
          runtime,
        }),
      ),
    );
    nextRosterServiceId += 1;
    const definitions =
      /* Safe because the surrounding invariant establishes this asserted shape. */ Object.freeze(
        Object.fromEntries(entries),
      ) as Definitions;
    const agentsValue = Context.GenericTag<
      AgentsService<Id, Definitions>,
      StartedAgentHandles<Definitions>
    >(`@moltzap/simulator/Agents/${definitionId}/${nextRosterServiceId}`);
    return Object.freeze(
      new AgentRoster(
        definitionId,
        definitions,
        validatedDefinitions,
        agentsValue,
      ),
    );
  }
}
```

A roster is both the keyed runtime definition and the owner of the exact
handles service used by the experiment Effect.

### [`AgentRosterAcquisitionError`](./runtime/roster.ts#L33)

_TypeAlias_

```ts
export type AgentRosterAcquisitionError<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = RuntimeAcquisitionErrorOf<Definitions[keyof Definitions]>;
```

Represents agent roster acquisition error conditions.

### [`AgentRosterRequirements`](./runtime/roster.ts#L38)

_TypeAlias_

```ts
export type AgentRosterRequirements<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = RuntimeRequirementsOf<Definitions[keyof Definitions]>;
```

The union of every heterogeneous runtime's Effect requirements.

### [`AgentRuntime`](./runtime/runtime.ts#L84)

_Interface_

```ts
export interface AgentRuntime<AcquisitionError = never, Requirements = never>
```

A runtime definition accepted by keyed society rosters.

### [`AgentRuntimeCompleted`](./events/core.ts#L65)

_Class_

```ts
export class AgentRuntimeCompleted extends Schema.TaggedClass<AgentRuntimeCompleted>()(
  "moltzap.agent-runtime-completed/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
  },
) {}
```

An autonomous runtime completed normally.

### [`AgentRuntimeDefinition`](./runtime/runtime.ts#L73)

_Interface_

```ts
export interface AgentRuntimeDefinition<
  AcquisitionError = never,
  Requirements = never,
> {
  readonly name: string;
  acquire<Name extends string>(
    input: AgentRuntimeInput<Name>,
  ): Effect.Effect<RunningAgent, AcquisitionError, Scope.Scope | Requirements>;
}
```

Scoped acquisition returns only after the runtime is ready. Implementations
own runtime-specific configuration and startup deadlines in their
constructors and register teardown in the acquisition Scope.

### [`AgentRuntimeDefinitionError`](./runtime/runtime.ts#L11)

_Class_

```ts
export class AgentRuntimeDefinitionError extends Schema.TaggedError<AgentRuntimeDefinitionError>()(
  "AgentRuntimeDefinitionError",
  {
    detail: Schema.NonEmptyString,
  },
) {}
```

Invalid runtime metadata rejected before a run acquires resources.

### [`AgentRuntimeFailed`](./events/core.ts#L75)

_Class_

```ts
export class AgentRuntimeFailed extends Schema.TaggedClass<AgentRuntimeFailed>()(
  "moltzap.agent-runtime-failed/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
    cause: Schema.NonEmptyString,
  },
) {}
```

An autonomous runtime completed with a recorded failure.

### [`AgentRuntimeInput`](./runtime/runtime.ts#L64)

_Interface_

```ts
export interface AgentRuntimeInput<Name extends string> {
  readonly connection: AgentConnection<Name>;
}
```

Router attachment issued to every autonomous runtime implementation.

### [`AgentRuntimeReady`](./events/core.ts#L45)

_Class_

```ts
export class AgentRuntimeReady extends Schema.TaggedClass<AgentRuntimeReady>()(
  "moltzap.agent-runtime-ready/v1",
  {
    agentName: agentName,
    agentId: agentId,
    runtime: Schema.NonEmptyString,
  },
) {}
```

A roster runtime has acquired its identity and completed readiness.

### [`AgentRuntimeStartFailed`](./events/core.ts#L55)

_Class_

```ts
export class AgentRuntimeStartFailed extends Schema.TaggedClass<AgentRuntimeStartFailed>()(
  "moltzap.agent-runtime-start-failed/v1",
  {
    agentName: agentName,
    runtime: Schema.NonEmptyString,
    cause: Schema.NonEmptyString,
  },
) {}
```

A roster runtime failed before it established readiness.

### [`AgentsService`](./runtime/roster.ts#L50)

_Interface_

```ts
export interface AgentsService<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly definitionId: Id;
  readonly definitions: Definitions;
}
```

Describes agents service.

### [`ConversationAddress`](./network/conversation.ts#L39)

_Class_

```ts
export class ConversationAddress {
  readonly [conversationAddressTypeId] = conversationAddressTypeId;

  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly participants: ConversationParticipants;

  private constructor(
    taskId: TaskId,
    conversationId: ConversationId,
    participants: ConversationParticipants,
  ) {
    this.taskId = taskId;
    this.conversationId = conversationId;
    this.participants = participants;
  }

  static [conversationAddressConstruction](
    taskId: TaskId,
    conversationId: ConversationId,
    participants: ConversationParticipants,
  ): ConversationAddress {
    return new ConversationAddress(taskId, conversationId, participants);
  }
}
```

A participant-independent network address. Binding an endpoint produces a
conversation socket; the address itself never implies a sender.

### [`ConversationOpened`](./events/core.ts#L108)

_Class_

```ts
export class ConversationOpened extends Schema.TaggedClass<ConversationOpened>()(
  "moltzap.conversation-opened/v1",
  {
    openedBy: agentId,
    taskId: taskId,
    conversationId: conversationId,
    participants: Schema.NonEmptyArray(agentId),
  },
) {}
```

A participant allocated a conversation address for a nonempty group.

### [`ConversationParticipants`](./network/conversation.ts#L30)

_TypeAlias_

```ts
export type ConversationParticipants = readonly [
  ParticipantHandle,
  ...(readonly ParticipantHandle[]),
];
```

Every conversation has at least one participant of any network role.

### [`ConversationSocket`](./network/conversation.ts#L107)

_Class_

```ts
export class ConversationSocket {
  readonly [conversationSocketTypeId] = conversationSocketTypeId;

  /**
   * The ordered receive cursor for this endpoint and conversation. Repeated
   * consumption advances the cursor instead of replaying old delivery.
   */
  readonly messages: Stream.Stream<ReceivedMessage, NetworkFailure>;

  readonly endpoint: ParticipantHandle;
  readonly address: ConversationAddress;
  private readonly sendMessage: (
    content: MessageParts,
  ) => Effect.Effect<Message, NetworkFailure>;

  private constructor(
    endpoint: ParticipantHandle,
    address: ConversationAddress,
    messages: Stream.Stream<ReceivedMessage, NetworkFailure>,
    sendMessage: (
      content: MessageParts,
    ) => Effect.Effect<Message, NetworkFailure>,
  ) {
    this.endpoint = endpoint;
    this.address = address;
    this.sendMessage = sendMessage;
    this.messages = messages;
  }

  static [conversationSocketConstruction](
    endpoint: ParticipantHandle,
    address: ConversationAddress,
    messages: Stream.Stream<ReceivedMessage, NetworkFailure>,
    sendMessage: (
      content: MessageParts,
    ) => Effect.Effect<Message, NetworkFailure>,
  ): ConversationSocket {
    return new ConversationSocket(endpoint, address, messages, sendMessage);
  }

  /**
   * Commit one message through the bound endpoint.
   * @param content Value supplied to the operation.
   * @returns The created conversation socket.
   */
  send(content: string | MessageParts): Effect.Effect<Message, NetworkFailure> {
    return validateParts(parts(content)).pipe(Effect.flatMap(this.sendMessage));
  }

  /**
   * Receive the next ordered delivery. Selection policy belongs in the
   * consuming Effect, so the socket never skips an earlier message.
   * @returns The created conversation socket.
   */
  receive(): Effect.Effect<ReceivedMessage, NetworkFailure> {
    return this.messages.pipe(
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              networkFailure(
                "receive",
                `conversation ${this.address.conversationId} ended before another message arrived`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  }
}
```

A conversation address bound to exactly one controlled endpoint.

### [`coreEvents`](./events/core.ts#L228)

_Variable_

```ts
export const coreEvents = EventCatalog.merge(
  runEvents,
  routerEvents,
  runtimeEvents,
  endpointEvents,
  linkEvents,
)
```

The exact event classes readable from every simulator run ledger.

### [`CustomerEvents`](./kernel/event-services.ts#L38)

_Interface_

```ts
export interface CustomerEvents<Catalog extends AnyEventCatalog> {
  readonly emit: (
    event: EventOf<Catalog>,
    metadata?: EventMetadata,
  ) => Effect.Effect<LedgerRecord<Catalog>, LedgerFailure>;
}
```

Definition-bound emission of customer-owned event classes only.

### [`defineRuntime`](./runtime/runtime.ts#L103)

_Function_

```ts
export function defineRuntime<AcquisitionError, Requirements>(
  runtime: AgentRuntimeDefinition<AcquisitionError, Requirements>,
): AgentRuntime<AcquisitionError, Requirements>
```

Preserve inferred attachment, error, and requirement types.

**Returns:** The define runtime result.

### [`EffectMessageContext`](./runtime/effect.ts#L49)

_Interface_

```ts
export interface EffectMessageContext {
  readonly agent: AgentHandle;
  readonly taskId: TaskId;
  readonly message: Message;
}
```

Message delivery context passed to ordinary Effect agent code.

### [`EffectMessageReply`](./runtime/effect.ts#L56)

_TypeAlias_

```ts
export type EffectMessageReply = string | MessageParts;
```

A message handler reply containing text or structured parts.

### [`effectRuntime`](./runtime/effect.ts#L249)

_Function_

```ts
export function effectRuntime<E = never, R = never>(
  options: EffectRuntimeOptions<E, R> = {},
): AgentRuntime<EffectRuntimeStartFailed, R>
```

Create a scoped in-process agent that communicates exclusively through the
production MoltZap protocol.

**Returns:** Autonomous runtime backed by in-process Effect behavior.

### [`EffectRuntimeOptions`](./runtime/effect.ts#L59)

_Interface_

```ts
export interface EffectRuntimeOptions<E = never, R = never> {
  readonly startupTimeout?: Duration.Duration;
  readonly onMessage?: (
    context: EffectMessageContext,
  ) => Effect.Effect<EffectMessageReply | undefined, E, R>;
}
```

Construction options owned by one in-process runtime implementation.

### [`EffectRuntimeStartFailed`](./runtime/effect.ts#L36)

_Class_

```ts
export class EffectRuntimeStartFailed extends Schema.TaggedError<EffectRuntimeStartFailed>()(
  "EffectRuntimeStartFailed",
  {
    agent: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Effect runtime for "${this.agent}" failed to start: ${this.detail}`;
  }
}
```

Acquisition failed before an in-process agent became router-visible.

### [`EncodedEventOf`](./events/catalog.ts#L43)

_TypeAlias_

```ts
export type EncodedEventOf<Catalog> = Schema.Schema.Encoded<
  CatalogSchemaOf<Catalog>
>;
```

The closed encoded union persisted for a catalog.

### [`Endpoint`](./network/endpoint.ts#L56)

_Class_

```ts
export class Endpoint<Name extends string = string> {
  readonly [endpointTypeId] = endpointTypeId;

  readonly participant: ParticipantHandle<Name>;
  private readonly transport: EndpointTransport;
  private readonly inbox: EndpointInbox;

  private constructor(
    participant: ParticipantHandle<Name>,
    transport: EndpointTransport,
    inbox: EndpointInbox,
  ) {
    this.participant = participant;
    this.transport = transport;
    this.inbox = inbox;
  }

  static [endpointConstruction]<const Name extends string>(
    attachment: AttachedEndpoint<Name>,
    inbox: EndpointInbox,
  ): Endpoint<Name> {
    return new Endpoint(attachment.participant, attachment.transport, inbox);
  }

  /**
   * Observe messages delivered after this stream is subscribed. Conversation
   * sockets retain their own ordered delivery queues independently.
   * @returns Live endpoint delivery stream.
   */
  messages(): Stream.Stream<ReceivedMessage, NetworkFailure> {
    return this.inbox.messages;
  }

  /**
   * Open a conversation through this endpoint's ordinary protocol attachment.
   * The opener is included in the resulting address automatically.
   * @param participants Nonempty addressed participant set.
   * @returns A conversation socket bound to this endpoint.
   */
  open(
    ...participants: ConversationParticipants
  ): Effect.Effect<ConversationSocket, NetworkFailure> {
    const [first, ...rest] = participants;
    const ids: ParticipantIds = [
      first.id,
      ...rest.map((participant) => participant.id),
    ];
    const addressed = addressedParticipants(this.participant, participants);
    return this.transport.openConversation(ids).pipe(
      Effect.flatMap((opened) =>
        this.inbox.conversation(opened.taskId, opened.conversationId).pipe(
          Effect.map((messages) => ({
            messages,
            opened,
          })),
        ),
      ),
      Effect.map(({ messages, opened }) => {
        const address = makeConversationAddress(
          opened.taskId,
          opened.conversationId,
          addressed,
        );
        return makeConversationSocket(
          this.participant,
          address,
          messages,
          (content) =>
            this.transport.send(
              address.taskId,
              address.conversationId,
              content,
            ),
        );
      }),
    );
  }

  /**
   * Bind this endpoint as the sender for an existing address.
   * @param address Participant-independent conversation address.
   * @returns Endpoint-bound socket when this endpoint is addressed.
   */
  socket(
    address: ConversationAddress,
  ): Effect.Effect<ConversationSocket, NetworkFailure> {
    const isParticipant = address.participants.some(
      (participant) => participant.id === this.participant.id,
    );
    return isParticipant
      ? this.inbox
          .conversation(address.taskId, address.conversationId)
          .pipe(
            Effect.map((messages) =>
              makeConversationSocket(
                this.participant,
                address,
                messages,
                (content) =>
                  this.transport.send(
                    address.taskId,
                    address.conversationId,
                    content,
                  ),
              ),
            ),
          )
      : Effect.fail(
          networkFailure(
            "socket",
            `participant ${this.participant.name} is not addressed by the conversation`,
          ),
        );
  }
}
```

A run-scoped participant controlled directly by the experiment program.

### [`EndpointMessageReceived`](./events/core.ts#L131)

_Class_

```ts
export class EndpointMessageReceived extends Schema.TaggedClass<EndpointMessageReceived>()(
  "moltzap.endpoint-message-received/v1",
  {
    endpointId: agentId,
    taskId: taskId,
    conversationId: conversationId,
    messageId: messageId,
    senderId: agentId,
    parts: messageParts,
  },
) {}
```

A controlled endpoint received a message through the data plane.

### [`EndpointMessageSent`](./events/core.ts#L119)

_Class_

```ts
export class EndpointMessageSent extends Schema.TaggedClass<EndpointMessageSent>()(
  "moltzap.endpoint-message-sent/v1",
  {
    endpointId: agentId,
    taskId: taskId,
    conversationId: conversationId,
    messageId: messageId,
    parts: messageParts,
  },
) {}
```

A controlled endpoint committed a message through the data plane.

### [`EventCatalog`](./events/catalog.ts#L152)

_Class_

```ts
export class EventCatalog<
  SchemaType extends CatalogSchema,
  Classes extends EventClass = EventClass,
> {
  readonly schema: Schema.Schema<
    Schema.Schema.Type<SchemaType>,
    Schema.Schema.Encoded<SchemaType>
  >;
  readonly eventClasses: readonly EventClass[];
  readonly tags: readonly VersionedEventTag[];
  private readonly [eventCatalogTypeId] = eventCatalogTypeId;

  private constructor(schema: SchemaType, eventClasses: readonly EventClass[]) {
    this.schema = Schema.make<
      Schema.Schema.Type<SchemaType>,
      Schema.Schema.Encoded<SchemaType>
    >(schema.ast);
    this.eventClasses = Object.freeze([...eventClasses]);
    this.tags = Object.freeze(
      this.eventClasses.map((eventClass) => eventClass._tag),
    );
    Object.freeze(this);
  }

  static make<
    const EventClasses extends readonly [
      EventClass,
      ...(readonly EventClass[]),
    ],
  >(
    ...eventClasses: EventClasses
  ): EventCatalog<EventClassesSchema<EventClasses>, EventClasses[number]> {
    validateEventClasses(eventClasses);
    return new EventCatalog(makeEventClassesSchema(eventClasses), eventClasses);
  }

  static empty(): EventCatalog<Schema.Schema<never>, never> {
    const eventClasses: readonly never[] = [];
    return new EventCatalog(Schema.make<never>(Schema.Never.ast), eventClasses);
  }

  static merge<
    const Catalogs extends readonly [
      EventCatalog<CatalogSchema>,
      ...ReadonlyArray<EventCatalog<CatalogSchema>>,
    ],
  >(
    ...catalogs: Catalogs
  ): EventCatalog<
    MergedCatalogSchema<Catalogs>,
    CatalogClassesOf<Catalogs[number]>
  > {
    const eventClasses = catalogs.flatMap((catalog) => catalog.eventClasses);
    validateEventClasses(eventClasses);
    return new EventCatalog(mergeCatalogSchemas(catalogs), eventClasses);
  }

  has(eventClass: EventClass): eventClass is Classes {
    return this.eventClasses.some(
      (catalogEventClass) => catalogEventClass === eventClass,
    );
  }

  hasEvent(event: unknown): event is Schema.Schema.Type<SchemaType> {
    if (typeof event !== "object" || event === null) {
      return false;
    }
    const constructor: unknown = Reflect.get(event, "constructor");
    return this.eventClasses.some((eventClass) => eventClass === constructor);
  }

  decode(input: unknown) {
    return Schema.decodeUnknown(Schema.asSchema(this.schema))(input, {
      onExcessProperty: "error",
    });
  }

  encode(event: Schema.Schema.Type<SchemaType>) {
    return Schema.encode(Schema.asSchema(this.schema))(event, {
      onExcessProperty: "error",
    });
  }
}
```

The exact immutable event universe for one definition.

The private type identifier makes catalog arguments nominal: a structural
object cannot claim a schema, constructor list, and tag list that disagree.

### [`EventCatalogDefinitionError`](./events/catalog.ts#L54)

_Class_

```ts
export class EventCatalogDefinitionError extends Schema.TaggedError<EventCatalogDefinitionError>()(
  "EventCatalogDefinitionError",
  {
    failure: Schema.Literal(
      "duplicate-tag",
      "invalid-event-class",
      "invalid-tag",
    ),
    tag: Schema.String,
  },
) {
  override get message(): string {
    switch (this.failure) {
      case "duplicate-tag":
        return `Duplicate event tag "${this.tag}"`;
      case "invalid-event-class":
        return `Event catalog member "${this.tag}" is not a schema-backed class`;
      case "invalid-tag":
        return `Event tag "${this.tag}" must be namespaced and versioned, for example "acme.consensus-reached/v1"`;
      default:
        return `Unknown event catalog failure "${this.failure}" for "${this.tag}"`;
    }
  }
}
```

Invalid catalogs fail during definition construction, before a run starts.

### [`EventCatalogDefinitionFailure`](./events/catalog.ts#L48)

_TypeAlias_

```ts
export type EventCatalogDefinitionFailure =
  | "duplicate-tag"
  | "invalid-event-class"
  | "invalid-tag";
```

Represents event catalog definition failure conditions.

### [`EventClass`](./events/catalog.ts#L10)

_TypeAlias_

```ts
export type EventClass = Schema.Schema.AnyNoContext & {
  readonly _tag: VersionedEventTag;
};
```

A schema-backed event constructor. The catalog retains both the schema and
constructor faces so persisted values decode back into their exact class.

### [`EventClassOf`](./events/catalog.ts#L40)

_TypeAlias_

```ts
export type EventClassOf<Catalog> = CatalogClassesOf<Catalog>;
```

The closed constructor union declared by a catalog.

### [`EventMetadata`](./kernel/event-services.ts#L22)

_Interface_

```ts
export interface EventMetadata {
  readonly causationId?: string;
  readonly correlationId?: string;
}
```

Causality metadata accepted from a customer event producer.

### [`EventOf`](./events/catalog.ts#L37)

_TypeAlias_

```ts
export type EventOf<Catalog> = Schema.Schema.Type<CatalogSchemaOf<Catalog>>;
```

The closed instance union declared by a catalog.

### [`InstallMode`](./runtime/packages.ts#L533)

_TypeAlias_

```ts
export type InstallMode = "published" | "workspace";
```

Represents install mode values.

### [`LedgerFailure`](./ledger/live.ts#L57)

_TypeAlias_

```ts
export type LedgerFailure =
  | LedgerStorageError
  | ParseResult.ParseError
  | LedgerSerializationError;
```

Represents ledger failure conditions.

### [`LinkController`](./network/link.ts#L49)

_Class_

```ts
export class LinkController extends Context.Tag(
  "@moltzap/simulator/LinkController",
)<LinkController, LinkControllerService>() {}
```

Experiment-facing directed-link control installed by the run kernel.

### [`LinkControllerService`](./network/link.ts#L37)

_Interface_

```ts
export interface LinkControllerService {
  /**
   * Keep one directed link disabled for the lifetime of the current Scope.
   * Overlapping acquisitions share a single physical down/up transition.
   */
  readonly disable: (
    from: ParticipantHandle,
    to: ParticipantHandle,
  ) => Effect.Effect<void, NetworkFailure, LinkDriver | Scope.Scope>;
}
```

Run-scoped, evidence-producing directed-link control.

### [`LinkDown`](./events/core.ts#L155)

_Class_

```ts
export class LinkDown extends Schema.TaggedClass<LinkDown>()(
  "moltzap.link-down/v1",
  {
    from: agentId,
    to: agentId,
  },
) {}
```

A directed participant link transitioned from available to unavailable.

### [`LinkUp`](./events/core.ts#L164)

_Class_

```ts
export class LinkUp extends Schema.TaggedClass<LinkUp>()("moltzap.link-up/v1", {
  from: agentId,
  to: agentId,
}) {}
```

A directed participant link transitioned from unavailable to available.

### [`MessageParts`](./../../protocol/dist/message/parts.d.ts#L41)

_TypeAlias_

```ts
export type MessageParts = Schema.Schema.Type<typeof messagePartsSchemaValue>;
```

Nonempty protocol message content.

### [`nanoclawRuntime`](./runtime/nanoclaw/runtime.ts#L357)

_Function_

```ts
export function nanoclawRuntime(
  options: NanoclawRuntimeOptions = {},
): AgentRuntime<NanoclawRuntimeAcquisitionError, NanoclawHostServices>
```

Construct a NanoClaw runtime that binds each roster identity to one
scoped container-backed process and waits for router-visible readiness.

**Returns:** The nanoclaw runtime result.

### [`NanoclawRuntimeAcquisitionError`](./runtime/nanoclaw/runtime.ts#L119)

_TypeAlias_

```ts
export type NanoclawRuntimeAcquisitionError = RuntimeAcquisitionFailed;
```

Failure returned when NanoClaw cannot become router-visible.

### [`NanoclawRuntimeOptions`](./runtime/nanoclaw/runtime.ts#L51)

_Interface_

```ts
export interface NanoclawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly NanoclawWorkspaceFile[];
  readonly modelId?: string;
  readonly installMode?: InstallMode;

  /**
   * Register conversations on first delivery in disposable evaluations.
   * Ordinary societies leave registration to their endpoint code.
   */
  readonly autoRegisterConversations?: boolean;

  /** Stdio MCP servers mounted into the NanoClaw container workspace. */
  readonly mcpServers?: readonly NanoclawMcpServer[];
}
```

Configuration captured by one reusable NanoClaw runtime value.

### [`Network`](./network/endpoint.ts#L197)

_Class_

```ts
export class Network extends Context.Tag("@moltzap/simulator/Network")<
  Network,
  NetworkService
>() {}
```

Network operations available to the customer program.

### [`NetworkFailure`](./network/router.ts#L51)

_Class_

```ts
export class NetworkFailure extends Schema.TaggedError<NetworkFailure>()(
  "NetworkFailure",
  {
    operation: networkOperation,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Network ${this.operation} failed: ${this.detail}`;
  }
}
```

An operational failure at a network boundary.

### [`NetworkService`](./network/endpoint.ts#L190)

_Interface_

```ts
export interface NetworkService {
  endpoint<const Name extends string>(
    name: Name,
  ): Effect.Effect<Endpoint<Name>, NetworkFailure>;
}
```

Controlled endpoint operations installed for one run scope.

### [`openClawRuntime`](./runtime/openclaw/runtime.ts#L323)

_Function_

```ts
export function openClawRuntime(
  options: OpenClawRuntimeOptions = {},
): AgentRuntime<OpenClawRuntimeAcquisitionError, OpenClawHostServices>
```

Construct an OpenClaw runtime that binds each roster identity to one
scoped gateway process and waits for router-visible readiness.

**Returns:** The open claw runtime result.

### [`OpenClawRuntimeAcquisitionError`](./runtime/openclaw/runtime.ts#L94)

_TypeAlias_

```ts
export type OpenClawRuntimeAcquisitionError = RuntimeAcquisitionFailed;
```

Failure returned when OpenClaw cannot become router-visible.

### [`OpenClawRuntimeOptions`](./runtime/openclaw/runtime.ts#L48)

_Interface_

```ts
export interface OpenClawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly OpenClawWorkspaceFile[];
  readonly modelId?: string;
  readonly installMode?: InstallMode;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly mcpServers?: readonly OpenClawMcpServer[];
}
```

Configuration captured by one reusable OpenClaw runtime value.

### [`ParticipantHandle`](./network/participant.ts#L22)

_Class_

```ts
export class ParticipantHandle<Name extends string = string> {
  readonly [participantHandleTypeId] = participantHandleTypeId;

  readonly name: Name;
  readonly id: AgentId;

  protected constructor(name: Name, id: AgentId) {
    this.name = name;
    this.id = id;
  }

  static [participantHandleConstruction]<const Name extends string>(
    name: Name,
    id: AgentId,
  ): ParticipantHandle<Name> {
    return new ParticipantHandle(name, id);
  }
}
```

A router-issued network identity. The hidden symbol prevents structurally
similar protocol data from being used as an identity handle.

### [`ProgramFailed`](./events/core.ts#L176)

_Class_

```ts
export class ProgramFailed extends Schema.TaggedClass<ProgramFailed>()(
  "moltzap.program-failed/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}
```

The customer program failed with a typed failure or defect.

### [`ProgramInterrupted`](./events/core.ts#L184)

_Class_

```ts
export class ProgramInterrupted extends Schema.TaggedClass<ProgramInterrupted>()(
  "moltzap.program-interrupted/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}
```

The customer program was interrupted.

### [`ProgramSucceeded`](./events/core.ts#L170)

_Class_

```ts
export class ProgramSucceeded extends Schema.TaggedClass<ProgramSucceeded>()(
  "moltzap.program-succeeded/v1",
  {},
) {}
```

The customer program returned successfully.

### [`ReadableRunLedger`](./kernel/event-services.ts#L28)

_Interface_

```ts
export interface ReadableRunLedger<Catalog extends AnyEventCatalog> {
  readonly ref: LedgerRef;
  readonly manifest: LedgerManifest;
  readonly records: Stream.Stream<LedgerRecord<Catalog>, LedgerFailure>;
  readonly events: <Event extends EventClassOf<Catalog>>(
    eventClass: Event,
  ) => Stream.Stream<Schema.Schema.Type<Event>, LedgerFailure>;
}
```

Definition-bound read access to every committed core and customer event.

### [`ReceivedMessage`](./network/router.ts#L77)

_Interface_

```ts
export interface ReceivedMessage {
  readonly taskId: TaskId;
  readonly message: Message;
}
```

A message delivered to one attached endpoint.

### [`RouterMessageCommitted`](./events/core.ts#L147)

_Class_

```ts
export class RouterMessageCommitted extends Schema.TaggedClass<RouterMessageCommitted>()(
  "moltzap.router-message-committed/v1",
  {
    ...CommittedRouterMessage.fields,
  },
) {}
```

The router durably committed one message. Payload content remains an
endpoint concern so this evidence also works with content-blind routers.

### [`RouterStarted`](./events/core.ts#L21)

_Class_

```ts
export class RouterStarted extends Schema.TaggedClass<RouterStarted>()(
  "moltzap.router-started/v1",
  {
    routerUrl: serverBaseUrlSchema,
  },
) {}
```

The run-scoped router is accepting participant connections.

### [`RouterStartFailed`](./events/core.ts#L29)

_Class_

```ts
export class RouterStartFailed extends Schema.TaggedClass<RouterStartFailed>()(
  "moltzap.router-start-failed/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}
```

Router acquisition failed before the data plane became available.

### [`RouterStopFailed`](./events/core.ts#L37)

_Class_

```ts
export class RouterStopFailed extends Schema.TaggedClass<RouterStopFailed>()(
  "moltzap.router-stop-failed/v1",
  {
    cause: Schema.NonEmptyString,
  },
) {}
```

Router release or stopped-router evidence collection failed.

### [`RunningAgent`](./runtime/runtime.ts#L59)

_Interface_

```ts
export interface RunningAgent {
  readonly termination: Effect.Effect<RuntimeTermination>;
}
```

The only post-acquisition lifecycle observation. Completion of this Effect
records a fact; customer policy decides whether that fact ends the run.

### [`RunStarted`](./events/core.ts#L13)

_Class_

```ts
export class RunStarted extends Schema.TaggedClass<RunStarted>()(
  "moltzap.run-started/v1",
  {
    definitionId: Schema.NonEmptyString,
  },
) {}
```

The run ledger is allocated and run-scoped acquisition has begun.

### [`RuntimeAcquisitionFailed`](./runtime/process.ts#L36)

_Class_

```ts
export class RuntimeAcquisitionFailed extends Schema.TaggedError<RuntimeAcquisitionFailed>()(
  "RuntimeAcquisitionFailed",
  {
    runtime: Schema.NonEmptyString,
    agent: Schema.NonEmptyString,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.runtime} runtime for "${this.agent}" failed to start: ${this.detail}`;
  }
}
```

An external runtime did not become a ready participant.

### [`RuntimeCompleted`](./runtime/runtime.ts#L19)

_Class_

```ts
export class RuntimeCompleted extends Schema.TaggedClass<RuntimeCompleted>()(
  "RuntimeCompleted",
  {},
) {}
```

An autonomous runtime completed normally.

### [`RuntimeExited`](./runtime/runtime.ts#L33)

_Class_

```ts
export class RuntimeExited extends Schema.TaggedClass<RuntimeExited>()(
  "RuntimeExited",
  {
    code: Schema.NonNegativeInt,
  },
) {}
```

A runtime process exited with an operating-system exit code.

### [`RuntimeFailed`](./runtime/runtime.ts#L25)

_Class_

```ts
export class RuntimeFailed extends Schema.TaggedClass<RuntimeFailed>()(
  "RuntimeFailed",
  {
    detail: Schema.String,
  },
) {}
```

An autonomous runtime completed with a recorded failure.

### [`RuntimeSignaled`](./runtime/runtime.ts#L41)

_Class_

```ts
export class RuntimeSignaled extends Schema.TaggedClass<RuntimeSignaled>()(
  "RuntimeSignaled",
  {
    signal: Schema.NonEmptyString,
  },
) {}
```

A runtime process terminated in response to an operating-system signal.

### [`RuntimeTermination`](./runtime/runtime.ts#L49)

_TypeAlias_

```ts
export type RuntimeTermination =
  | RuntimeCompleted
  | RuntimeFailed
  | RuntimeExited
  | RuntimeSignaled;
```

Exact terminal observation produced by an acquired runtime.

### [`simulator`](./definition.ts#L234)

_Variable_

```ts
export const simulator: Readonly<{ define: typeof defineSimulator }> =
  Object.freeze({
    define: defineSimulator,
  })
```

Discoverable entry point for code-first society definitions.

### [`SimulatorDefinition`](./definition.ts#L169)

_Interface_

```ts
export interface SimulatorDefinition<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
> {
  readonly id: Id;
  readonly catalog: DefinitionEventServices<Id, CustomerCatalogs>["catalog"];
  readonly customerCatalog: CustomerEventCatalog<CustomerCatalogs>;
  readonly ledger: DefinitionEventServices<Id, CustomerCatalogs>["ledger"];
  readonly events: DefinitionEventServices<Id, CustomerCatalogs>["events"];
  readonly agents: ReturnType<typeof makeAgentRosterBuilder<Id>>;
  readonly run: ReturnType<
    typeof makeRunner<
      Id,
      CatalogSchemaOf<CustomerEventCatalog<CustomerCatalogs>>,
      CatalogClassesOf<CustomerEventCatalog<CustomerCatalogs>>
    >
  >;
  readonly openLedger: ReturnType<
    typeof makeLedgerReader<
      Id,
      CatalogSchemaOf<CustomerEventCatalog<CustomerCatalogs>>,
      CatalogClassesOf<CustomerEventCatalog<CustomerCatalogs>>
    >
  >;
}
```

Definition-bound capabilities for one versioned family of simulator runs.

### [`SimulatorDefinitionError`](./definition.ts#L27)

_Class_

```ts
export class SimulatorDefinitionError extends Schema.TaggedError<SimulatorDefinitionError>()(
  "SimulatorDefinitionError",
  {
    definitionId: Schema.String,
    detail: Schema.NonEmptyString,
  },
) {
  override get message(): string {
    return `Simulator definition "${this.definitionId}" is invalid: ${this.detail}`;
  }
}
```

Reports simulator definition failures.

### [`SimulatorDefinitionId`](./definition.ts#L22)

_TypeAlias_

```ts
export type SimulatorDefinitionId = `${string}.${string}/v${number}`;
```

Stable code identity persisted in every ledger manifest.

### [`simulatorLayer`](./layer.ts#L23)

_Function_

```ts
export function simulatorLayer(options: SimulatorLayerOptions)
```

Provide the production router, filesystem ledger, and Effect Platform host
services once at the application boundary.

**Returns:** The simulator layer result.

### [`SimulatorLayerOptions`](./layer.ts#L12)

_Interface_

```ts
export interface SimulatorLayerOptions {
  readonly ledgerDirectory: string;
  readonly router: MoltZapRouterOptions;
}
```

Host configuration shared by every run provided with this Layer.

### [`SimulatorRunFailure`](./kernel/run.ts#L78)

_TypeAlias_

```ts
export type SimulatorRunFailure<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = AgentRosterAcquisitionError<Definitions> | LedgerFailure | NetworkFailure;
```

Represents simulator run failure conditions.

### [`SimulatorRunOptions`](./kernel/run.ts#L65)

_Interface_

```ts
export interface SimulatorRunOptions {
  readonly provenance?: JsonObject;
  readonly metadata?: JsonObject;
}
```

Optional run metadata; platform and runtime policy belong in Layers.

### [`SimulatorRunResult`](./kernel/run.ts#L71)

_Interface_

```ts
export interface SimulatorRunResult<A, E> {
  readonly exit: Exit.Exit<A, E>;
  readonly ledger: LedgerRef;
  readonly completion: LedgerCompletion;
}
```

The program Exit plus the durable ledger that proves the run.

### [`StartedAgentHandles`](./runtime/roster.ts#L43)

_TypeAlias_

```ts
export type StartedAgentHandles<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = Readonly<{
  [Name in Extract<keyof Definitions, string>]: AgentHandle<Name>;
}>;
```

Exact keyed handles installed only after every runtime is ready.

### [`VersionedEventTag`](./events/catalog.ts#L4)

_TypeAlias_

```ts
export type VersionedEventTag = `${string}.${string}/v${number}`;
```

Stable persisted identity for an event class.

## Files

- `definition.ts`
- `catalog.ts`
- `core.ts`
- `event-services.ts`
- `run.ts`
- `layer.ts`
- `live.ts`
- `conversation.ts`
- `endpoint.ts`
- `link.ts`
- `participant.ts`
- `router.ts`
- `effect.ts`
- `runtime.ts`
- `runtime.ts`
- `packages.ts`
- `process.ts`
- `roster.ts`
- `runtime.ts`
