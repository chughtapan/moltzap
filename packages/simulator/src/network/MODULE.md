# simulator/network

_`packages/simulator/src/network`_

## Purpose

Compatible simulator network contracts and run-scoped services.

## Public surface

### [`AgentConnection`](./router.ts#L50)

_Interface_

```ts
export interface AgentConnection<Name extends string = string> {
  readonly agent: AgentHandle<Name>;
}
```

Runtime identity issued for one scope-owned autonomous agent.

### [`AgentHandle`](./participant.ts#L58)

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

### [`AttachedEndpoint`](./router.ts#L55)

_Interface_

```ts
export interface AttachedEndpoint<Name extends string> {
  readonly participant: ParticipantHandle<Name>;
  readonly transport: EndpointTransport;
}
```

Router output used by an experiment-controlled endpoint.

### [`ConversationAddress`](./conversation.ts#L28)

_Class_

```ts
export class ConversationAddress {
  readonly [conversationAddressTypeId] = conversationAddressTypeId;

  readonly conversationId: ConversationId;
  readonly participants: ConversationParticipants;

  constructor(
    conversationId: ConversationId,
    participants: ConversationParticipants,
  ) {
    if (participants.length === 0) {
      // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- This synchronous public constructor rejects invalid JavaScript input before creating a nominal address.
      throw new TypeError("conversation participants must not be empty");
    }
    const [first, ...rest] = participants;
    if (
      new Set(participants.map(({ id }) => id)).size !== participants.length
    ) {
      // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- This synchronous public constructor rejects invalid JavaScript input before creating a nominal address.
      throw new TypeError(
        "conversation participants must be unique by AgentId",
      );
    }
    this.conversationId = conversationId;
    this.participants = Object.freeze([first, ...rest]);
    Object.freeze(this);
  }
}
```

A participant-independent network address. Binding an endpoint produces a
conversation socket; the address itself never implies a sender.

### [`ConversationParticipants`](./conversation.ts#L19)

_TypeAlias_

```ts
export type ConversationParticipants = readonly [
  ParticipantHandle,
  ...(readonly ParticipantHandle[]),
];
```

Every conversation has at least one participant of any network role.

### [`ConversationSocket`](./conversation.ts#L72)

_Class_

```ts
export class ConversationSocket {
  readonly [conversationSocketTypeId] = conversationSocketTypeId;

  /** Ordered semantic turns for this endpoint and conversation. */
  readonly messages: Stream.Stream<HarnessTurn, NetworkError>;

  readonly endpoint: ParticipantHandle;
  readonly address: ConversationAddress;

  private constructor(
    endpoint: ParticipantHandle,
    address: ConversationAddress,
    messages: Stream.Stream<HarnessTurn, NetworkError>,
  ) {
    this.endpoint = endpoint;
    this.address = address;
    this.messages = messages;
  }

  static [conversationSocketConstruction](
    endpoint: ParticipantHandle,
    address: ConversationAddress,
    messages: Stream.Stream<HarnessTurn, NetworkError>,
  ): ConversationSocket {
    return new ConversationSocket(endpoint, address, messages);
  }

  /**
   * Receive the next ordered turn. Selection policy belongs in the consuming
   * Effect, so the socket never skips an earlier turn.
   * @returns The next turn, or a typed receive failure when the stream ends.
   */
  receive(): Effect.Effect<HarnessTurn, NetworkError> {
    return this.messages.pipe(
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              networkError(
                "receive",
                `conversation ${this.address.conversationId} ended before another turn arrived`,
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

### [`Endpoint`](./endpoint.ts#L30)

_Class_

```ts
export class Endpoint<Name extends string = string> {
  readonly [endpointTypeId] = endpointTypeId;

  readonly participant: ParticipantHandle<Name>;
  private readonly inbox: EndpointInbox;
  private readonly transport: EndpointTransport;

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
   * Start one conversation through this endpoint's semantic daemon client.
   * @param input Caller-minted conversation identity, peers, and initial content.
   * @returns Completion after the daemon accepts the semantic START.
   */
  start(input: StartInput): Effect.Effect<void, NetworkError> {
    return this.transport.start(input);
  }

  /**
   * Observe semantic turns delivered after this stream is subscribed.
   * @returns A live fan-out stream of turns for this endpoint.
   */
  messages(): Stream.Stream<HarnessTurn, NetworkError> {
    return this.inbox.messages;
  }

  /**
   * Bind this endpoint as the receiver for an existing address.
   * @param address Conversation whose participant set includes this endpoint.
   * @returns The endpoint-bound socket or a typed address mismatch.
   */
  socket(
    address: ConversationAddress,
  ): Effect.Effect<ConversationSocket, NetworkError> {
    const isParticipant = address.participants.some(
      (participant) => participant.id === this.participant.id,
    );
    return isParticipant
      ? this.inbox
          .conversation(address.conversationId)
          .pipe(
            Effect.map((messages) =>
              makeConversationSocket(this.participant, address, messages),
            ),
          )
      : Effect.fail(
          networkError(
            "socket",
            `participant ${this.participant.name} is not addressed by the conversation`,
          ),
        );
  }
}
```

A run-scoped participant controlled directly by the experiment program.

### [`EndpointInbox`](./endpoint.ts#L20)

_Interface_

```ts
export interface EndpointInbox {
  /** Live fan-out stream for observers of every endpoint turn. */
  readonly messages: Stream.Stream<HarnessTurn, NetworkError>;
  /** Obtain the shared ordered cursor for one bound conversation. */
  readonly conversation: (
    conversationId: ConversationId,
  ) => Effect.Effect<Stream.Stream<HarnessTurn, NetworkError>>;
}
```

Run-scoped receive cursors maintained by the simulator kernel.

### [`EndpointTransport`](./router.ts#L44)

_Interface_

```ts
export interface EndpointTransport {
  readonly received: Stream.Stream<HarnessTurn, NetworkError>;
  readonly start: (input: StartInput) => Effect.Effect<void, NetworkError>;
}
```

A ready, scope-owned endpoint attachment. The receive ingress is subscribed
before acquisition returns and retains turns until its consumer advances.

### [`InboundLinkStage`](./link.ts#L69)

_TypeAlias_

```ts
export type InboundLinkStage = <
  A extends { readonly message: SignedMessage },
  E,
>(
  inbound: Stream.Stream<A, E>,
) => Stream.Stream<A, E>;
```

Wraps one in-process inbound delivery stream with the active policies of its
receiver. The stage preserves per-sender FIFO order while letting deliveries
from different senders progress independently.

### [`LinkController`](./link.ts#L155)

_Class_

```ts
export class LinkController extends Context.Tag(
  "@moltzap/simulator/LinkController",
)<LinkController, LinkControllerService>() {}
```

Experiment-facing directed-link control installed by the run kernel.

### [`LinkControllerService`](./link.ts#L125)

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
  ) => Effect.Effect<void, NetworkError, LinkDriver | Scope.Scope>;
  /** Delay every delivery on one directed link for the current Scope. */
  readonly delay: (
    from: ParticipantHandle,
    to: ParticipantHandle,
    duration: Duration.DurationInput,
  ) => Effect.Effect<void, NetworkError, LinkDriver | Scope.Scope>;
  /** Park every delivery on one directed link for the current Scope. */
  readonly hold: (
    from: ParticipantHandle,
    to: ParticipantHandle,
  ) => Effect.Effect<void, NetworkError, LinkDriver | Scope.Scope>;
  /** Install one custom policy on a directed link for the current Scope. */
  readonly shape: (
    from: ParticipantHandle,
    to: ParticipantHandle,
    policy: LinkPolicy,
    description: string,
  ) => Effect.Effect<void, NetworkError, LinkDriver | Scope.Scope>;
}
```

Run-scoped, evidence-producing directed-link control.

### [`LinkDelivery`](./link.ts#L16)

_Interface_

```ts
export interface LinkDelivery {
  /** Message sender identity. */
  readonly from: AgentId;
  /** Receiving participant identity. */
  readonly to: AgentId;
  /** Identity-owned opaque signed message carried by the delivery. */
  readonly message: SignedMessage;
}
```

One opaque signed message about to cross a directed link.

### [`LinkDriver`](./link.ts#L119)

_Class_

```ts
export class LinkDriver extends Context.Tag("@moltzap/simulator/LinkDriver")<
  LinkDriver,
  LinkDriverService
>() {}
```

Platform link implementation. A program only requires this service when it
actually acquires a disabled-link scope.

### [`LinkDriverService`](./link.ts#L93)

_Interface_

```ts
export interface LinkDriverService {
  readonly disable: (
    from: AgentId,
    to: AgentId,
  ) => Effect.Effect<void, NetworkError>;
  readonly enable: (
    from: AgentId,
    to: AgentId,
  ) => Effect.Effect<void, NetworkError>;
  /**
   * Install one policy on a directed link until the returned lease clears.
   * Policies stack in installation order on the same link. The same
   * pre-permit/post-linearization interruption rule applies to `clear`.
   */
  readonly apply: (
    from: AgentId,
    to: AgentId,
    policy: LinkPolicy,
    description: string,
  ) => Effect.Effect<LinkPolicyLease, NetworkError>;
}
```

Platform operations that change one directed data-plane link.

Waiting for the platform's serialization permit is interruptible and leaves
the link in its pre-call state. Once the permit is acquired, the mutation is
an uninterruptible linearization point and is never rolled back. A pending
interruption can therefore surface after the mutation with the link in its
post-call state. A typed failure occurs before that point and also leaves the
pre-call state. A caller that must own or compensate a committed mutation
masks the driver call through scope-finalizer registration. Scoped release
awaits `enable` instead of detaching cleanup.

### [`linkPolicy`](./link.ts#L44)

_Variable_

```ts
export const linkPolicy:
```

Canonical link policies for the common traffic shapes.

### [`LinkPolicy`](./link.ts#L41)

_TypeAlias_

```ts
export type LinkPolicy = (delivery: LinkDelivery) => Effect.Effect<LinkVerdict>;
```

Decides one delivery on a directed link. A policy reads only its input and
the ambient Clock; the link interpreter, never the policy, spends time and
records evidence.

### [`LinkPolicyLease`](./link.ts#L77)

_Interface_

```ts
export interface LinkPolicyLease {
  readonly clear: Effect.Effect<void, NetworkError>;
}
```

Removes one installed policy from its directed link.

### [`linkVerdict`](./link.ts#L34)

_Variable_

```ts
export const linkVerdict = Data.taggedEnum<LinkVerdict>()
```

Constructors and matchers for the closed verdict union.

### [`LinkVerdict`](./link.ts#L26)

_TypeAlias_

```ts
export type LinkVerdict = Data.TaggedEnum<{
  deliver: Record<never, never>;
  drop: { readonly reason?: string };
  delay: { readonly duration: Duration.Duration };
  hold: Record<never, never>;
}>;
```

Closed per-delivery decision returned by a link policy.

### [`makeAgentHandle`](./participant.ts#L81)

_Function_

```ts
export function makeAgentHandle<const Name extends string>(
  name: Name,
  id: AgentId,
): AgentHandle<Name>
```

Construct an agent handle at the simulator network boundary.

**Returns:** Nominal autonomous-agent identity.

### [`makeEndpoint`](./endpoint.ts#L105)

_Function_

```ts
export function makeEndpoint<const Name extends string>(
  attachment: AttachedEndpoint<Name>,
  inbox: EndpointInbox,
): Endpoint<Name>
```

Construct a controlled endpoint from one ready attachment and its inbox.

**Returns:** The immutable controlled endpoint capability.

### [`makeParticipantHandle`](./participant.ts#L47)

_Function_

```ts
export function makeParticipantHandle<const Name extends string>(
  name: Name,
  id: AgentId,
): ParticipantHandle<Name>
```

Construct a participant handle at the simulator network boundary.

**Returns:** Nominal participant identity.

### [`makeRouterStopReport`](./router.ts#L33)

_Function_

```ts
export function makeRouterStopReport(): RouterStopped
```

Construct a nominal stop report at a platform boundary.

**Returns:** Immutable evidence that the Router scope released.

### [`Network`](./endpoint.ts#L122)

_Class_

```ts
export class Network extends Context.Tag("@moltzap/simulator/Network")<
  Network,
  NetworkService
>() {}
```

Network operations available to the customer program.

### [`networkError`](./failure.ts#L40)

_Function_

```ts
export function networkError(
  operation: NetworkOperation,
  cause: unknown,
): NetworkError
```

Normalize an implementation failure at the network boundary. Error causes
contribute their message alone so one operation reads the same way whether
the boundary raised a thrown Error or a plain description.

**Returns:** Typed network failure.

### [`NetworkError`](./failure.ts#L20)

_Class_

```ts
export class NetworkError extends Schema.TaggedError<NetworkError>()(
  "NetworkError",
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

An operational failure at a simulator network boundary.

### [`NetworkOperation`](./failure.ts#L17)

_TypeAlias_

```ts
export type NetworkOperation = typeof networkOperation.Type;
```

Network operation names used by typed failures.

### [`NetworkService`](./endpoint.ts#L115)

_Interface_

```ts
export interface NetworkService {
  endpoint<const Name extends string>(
    name: Name,
  ): Effect.Effect<Endpoint<Name>, NetworkError>;
}
```

Controlled endpoint operations installed for one run scope.

### [`ParticipantHandle`](./participant.ts#L22)

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

A network participant identity. The hidden symbol prevents structurally
similar identity data from being used as a simulator handle.

### [`ParticipantIds`](./router.ts#L38)

_TypeAlias_

```ts
export type ParticipantIds = readonly [AgentId, ...(readonly AgentId[])];
```

Nonempty participant identities accepted by a transport boundary.

### [`Router`](./router.ts#L61)

_Interface_

```ts
export interface Router {
  readonly address: URL;

  /** Awaits the stop report completed by scoped release. */
  readonly stopped: Effect.Effect<RouterStopped, NetworkError>;
}
```

Run-scoped Router fixture lifecycle.

### [`RouterProvider`](./router.ts#L74)

_Class_

```ts
export class RouterProvider extends Context.Tag(
  "@moltzap/simulator/RouterProvider",
)<RouterProvider, RouterProviderService>() {}
```

Router acquisition service supplied by the platform Layer.

### [`RouterProviderService`](./router.ts#L69)

_Interface_

```ts
export interface RouterProviderService {
  readonly acquire: Effect.Effect<Router, NetworkError, Scope.Scope>;
}
```

Router acquisition service supplied by the platform Layer.

### [`RouterStopped`](./router.ts#L17)

_Class_

```ts
export class RouterStopped {
  readonly [routerStoppedTypeId]: typeof routerStoppedTypeId;

  private constructor() {
    this[routerStoppedTypeId] = routerStoppedTypeId;
  }

  static [routerStoppedConstruction](): RouterStopped {
    return new RouterStopped();
  }
}
```

Shutdown evidence available only after the Router scope has released.

## Files

- `conversation.ts`
- `endpoint.ts`
- `failure.ts`
- `index.ts`
- `link.ts`
- `participant.ts`
- `router.ts`
