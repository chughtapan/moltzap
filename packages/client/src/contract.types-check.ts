/**
 * @file The public Client is one addressed structural endpoint whose sends are
 * operations and whose inbound deliveries are tagged items. Every send carries
 * an address, text and an optional collective operation, multicast by
 * default; each inbound delivery carries one item plus transport-only
 * acknowledgment. A multicast item carries the certified direct or
 * complete-group message.
 */

import type { DateTime, Effect, Scope, Stream } from "effect";
import type {
  acquireHarnessEndpoint,
  AgentAddress,
  CollectiveOperation,
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
  ListenError,
  MessageAddressInput,
  PostId,
  SendError,
  SendInput,
} from "./index.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type ExpectedCollectiveOperation = Readonly<{ op?: "multicast" }>;
type ExpectedSendInput = Readonly<{
  to: MessageAddressInput;
  text: string;
  collective?: CollectiveOperation;
}>;
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
type ExpectedMulticastItem = Readonly<{
  kind: "multicast";
  message: InboundMessage;
}>;
type ExpectedDelivery = Readonly<{
  item: InboundItem;
  acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}>;
type ExpectedEndpoint = Readonly<{
  send: (input: SendInput) => Effect.Effect<void, SendError>;
  messages: Stream.Stream<InboundDelivery, ListenError>;
}>;

type CollectiveOperationIsExact = Expect<
  Equal<CollectiveOperation, ExpectedCollectiveOperation>
>;
type SendInputIsExact = Expect<Equal<SendInput, ExpectedSendInput>>;
type InboundItemIsExact = Expect<Equal<InboundItem, ExpectedMulticastItem>>;
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
      to: MessageAddressInput;
      text: string;
      collective?: CollectiveOperation;
      outcome:
        | Readonly<{ kind: "certified"; postId: PostId }>
        | Readonly<{ kind: "failed"; reason: SendError["reason"] }>;
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
  SendInputIsExact,
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
  HistoryExportRecordIsExact,
  ListenReasonsAreExact,
  AcknowledgeReasonsAreExact,
  ConnectReasonsAreExact,
  AcquisitionIsScoped,
  AcquisitionResultIsExact,
];
