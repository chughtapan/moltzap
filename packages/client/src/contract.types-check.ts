/**
 * @file The public Client is one addressed structural endpoint whose sends are
 * operations or collective responses and whose inbound deliveries are tagged
 * items. An operation carries an address, text and an optional collective
 * operation, multicast by default or a gather or all_gather with its deadline
 * and schema; a response names its request and no address. Each inbound
 * delivery carries one item plus transport-only acknowledgment: a multicast
 * with the certified direct or complete-group message, a collective request
 * naming the conversation it arrived in, a collective result that names an
 * all_gather's close post, or an operation failure. A send returns a
 * collecting operation's id and fails with a closed send reason or a
 * collective failure.
 */

import type { DateTime, Effect, Scope, Stream } from "effect";
import type {
  acquireHarnessEndpoint,
  AgentAddress,
  CollectiveError,
  CollectiveOperation,
  CollectiveResponse,
  ConnectError,
  Content,
  ContentPart,
  DeliveryAcknowledgeError,
  DirectMessage,
  GroupAddress,
  GroupMessage,
  HarnessEndpoint,
  HistoryExportRecord,
  InboundDelivery,
  InboundItem,
  InboundMessage,
  JsonValue,
  ListenError,
  MessageAddressInput,
  PostId,
  SendError,
  SendInput,
  SendResult,
} from "./index.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type CollectiveId = CollectiveError["id"];
type ExpectedRequestedSchema = Readonly<{
  $schema?: string;
  type: "object";
  properties: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  required?: readonly string[];
}>;
type ExpectedAnswerContent = Readonly<
  Record<string, string | number | boolean | readonly string[]>
>;
type ExpectedCollectiveOperation =
  | Readonly<{ op?: "multicast" }>
  | Readonly<{
      op: "gather" | "all_gather";
      deadline: number;
      requestedSchema: ExpectedRequestedSchema;
    }>;
type ExpectedCollectiveResponse =
  | Readonly<{
      id: CollectiveId;
      action: "accept";
      content: ExpectedAnswerContent;
    }>
  | Readonly<{ id: CollectiveId; action: "decline" | "cancel" }>;
type ExpectedSendInput =
  | Readonly<{
      to: MessageAddressInput;
      text: string;
      collective?: CollectiveOperation;
    }>
  | Readonly<{ collectiveResponse: CollectiveResponse }>;
type ExpectedSendResult = Readonly<{ operationId?: CollectiveId }>;
type ExpectedDirectMessage = Readonly<{
  kind: "direct";
  postId: PostId;
  address: AgentAddress;
  sender: AgentAddress;
  content: Content;
}>;
type ExpectedGroupMessage = Readonly<{
  kind: "group";
  postId: PostId;
  address: GroupAddress;
  sender: AgentAddress;
  members: readonly [
    AgentAddress,
    AgentAddress,
    AgentAddress,
    ...AgentAddress[],
  ];
  content: Content;
}>;
type ExpectedMemberOutcome =
  | Readonly<{ kind: "answered"; content: ExpectedAnswerContent }>
  | Readonly<{ kind: "declined" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "invalid"; reason: string }>
  | Readonly<{ kind: "no-answer" }>;
type ExpectedInboundItem =
  | Readonly<{ kind: "multicast"; message: InboundMessage }>
  | Readonly<{
      kind: "collectiveRequest";
      id: CollectiveId;
      postId: PostId;
      from: AgentAddress;
      to: MessageAddressInput;
      question: string;
      requestedSchema: ExpectedRequestedSchema;
      deadlineAt: number;
    }>
  | Readonly<{
      kind: "collectiveResult";
      id: CollectiveId;
      to: MessageAddressInput;
      question: string;
      outcomes: readonly [
        Readonly<{ member: AgentAddress; outcome: ExpectedMemberOutcome }>,
        ...Array<
          Readonly<{ member: AgentAddress; outcome: ExpectedMemberOutcome }>
        >,
      ];
      closePostId?: PostId;
    }>
  | Readonly<{
      kind: "operationFailed";
      id: CollectiveId;
      to: MessageAddressInput;
      error: string;
    }>;
type ExpectedDelivery = Readonly<{
  item: InboundItem;
  acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}>;
type ExpectedEndpoint = Readonly<{
  send: (
    input: SendInput,
    options?: Readonly<{ failureDelivery?: "result" | "inbound" }>,
  ) => Effect.Effect<SendResult, SendError | CollectiveError>;
  messages: Stream.Stream<InboundDelivery, ListenError>;
}>;

type CollectiveOperationIsExact = Expect<
  Equal<CollectiveOperation, ExpectedCollectiveOperation>
>;
type CollectiveResponseIsExact = Expect<
  Equal<CollectiveResponse, ExpectedCollectiveResponse>
>;
type SendInputIsExact = Expect<Equal<SendInput, ExpectedSendInput>>;
type SendResultIsExact = Expect<Equal<SendResult, ExpectedSendResult>>;
type InboundItemIsExact = Expect<Equal<InboundItem, ExpectedInboundItem>>;
type DirectMessageIsExact = Expect<Equal<DirectMessage, ExpectedDirectMessage>>;
type GroupMessageIsExact = Expect<Equal<GroupMessage, ExpectedGroupMessage>>;
type InboundMessageIsExact = Expect<
  Equal<InboundMessage, DirectMessage | GroupMessage>
>;
type DeliveryIsExact = Expect<Equal<InboundDelivery, ExpectedDelivery>>;
type EndpointIsExact = Expect<Equal<HarnessEndpoint, ExpectedEndpoint>>;
type ExpectedHistoryExportRecord =
  | Readonly<{ kind: "inbound"; item: InboundItem; at: DateTime.Utc }>
  | Readonly<{
      kind: "outbound";
      input: SendInput;
      outcome:
        | Readonly<{
            kind: "sent";
            operationId?: CollectiveId;
            postIds: readonly PostId[];
          }>
        | Readonly<{ kind: "failed"; error: string }>;
      at: DateTime.Utc;
    }>
  | Readonly<{ kind: "export-failed"; reason: string; at: DateTime.Utc }>;
type HistoryExportRecordIsExact = Expect<
  Equal<HistoryExportRecord, ExpectedHistoryExportRecord>
>;
type ContentIsNonempty = Expect<
  Content extends readonly [ContentPart, ...ContentPart[]] ? true : false
>;
type AgentAddressIsInput = Expect<
  AgentAddress extends MessageAddressInput ? true : false
>;
type GroupAddressIsInput = Expect<
  GroupAddress extends MessageAddressInput ? true : false
>;
type SendReasonsAreExact = Expect<
  Equal<
    SendError["reason"],
    | "invalid-address"
    | "unknown-agent"
    | "membership-invalid"
    | "content-invalid"
    | "not-registered"
    | "version-mismatch"
    | "certification-unavailable"
    | "persistence-failed"
    | "network-unavailable"
  >
>;
type CollectiveFailureKindsAreExact = Expect<
  Equal<
    CollectiveError["failure"]["kind"],
    | "members-unreachable"
    | "schema-invalid"
    | "answer-invalid"
    | "request-unknown"
    | "request-answered"
    | "request-expired"
  >
>;
type ListenReasonsAreExact = Expect<
  Equal<
    ListenError["reason"],
    | "already-listening"
    | "incompatible-daemon"
    | "transport-failed"
    | "decode-failed"
  >
>;
type AcknowledgeReasonsAreExact = Expect<
  Equal<
    DeliveryAcknowledgeError["reason"],
    | "unknown-delivery"
    | "delivery-conflict"
    | "persistence-failed"
    | "transport-failed"
  >
>;
type ConnectReasonsAreExact = Expect<
  Equal<
    ConnectError["reason"],
    "transport-failed" | "decode-failed" | "incompatible-daemon"
  >
>;
type AcquisitionIsScoped = Expect<
  Equal<Parameters<typeof acquireHarnessEndpoint>, [endpoint: URL]>
>;
type AcquisitionResultIsExact = Expect<
  Equal<
    ReturnType<typeof acquireHarnessEndpoint>,
    Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope>
  >
>;

/** Compile-time witnesses for the accepted public Client boundary. */
export type HarnessEndpointCanaries = [
  CollectiveOperationIsExact,
  CollectiveResponseIsExact,
  SendInputIsExact,
  SendResultIsExact,
  InboundItemIsExact,
  DirectMessageIsExact,
  GroupMessageIsExact,
  InboundMessageIsExact,
  DeliveryIsExact,
  EndpointIsExact,
  ContentIsNonempty,
  AgentAddressIsInput,
  GroupAddressIsInput,
  SendReasonsAreExact,
  CollectiveFailureKindsAreExact,
  HistoryExportRecordIsExact,
  ListenReasonsAreExact,
  AcknowledgeReasonsAreExact,
  ConnectReasonsAreExact,
  AcquisitionIsScoped,
  AcquisitionResultIsExact,
];
