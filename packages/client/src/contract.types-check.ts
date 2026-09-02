/**
 * @file The public Client is one addressed structural endpoint. Sends always
 * create one fresh Client-owned intent, and inbound deliveries carry a certified
 * direct or complete-group message plus transport-only acknowledgment.
 */

import type { DateTime, Effect, Scope, Stream } from "effect";
import type {
  acquireHarnessEndpoint,
  AgentAddress,
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
  InboundMessage,
  ListenError,
  MessageAddressInput,
  PostId,
  SendError,
  SendInput,
} from "./index.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type ExpectedSendInput = Readonly<{
  to: MessageAddressInput;
  content: Content;
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
type ExpectedDelivery = Readonly<{
  message: InboundMessage;
  acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}>;
type ExpectedEndpoint = Readonly<{
  send: (input: SendInput) => Effect.Effect<void, SendError>;
  messages: Stream.Stream<InboundDelivery, ListenError>;
}>;

type SendInputIsExact = Expect<Equal<SendInput, ExpectedSendInput>>;
type DirectMessageIsExact = Expect<Equal<DirectMessage, ExpectedDirectMessage>>;
type GroupMessageIsExact = Expect<Equal<GroupMessage, ExpectedGroupMessage>>;
type InboundMessageIsExact = Expect<
  Equal<InboundMessage, DirectMessage | GroupMessage>
>;
type DeliveryIsExact = Expect<Equal<InboundDelivery, ExpectedDelivery>>;
type EndpointIsExact = Expect<Equal<HarnessEndpoint, ExpectedEndpoint>>;
type ExpectedHistoryExportRecord =
  | Readonly<{ kind: "inbound"; message: InboundMessage; at: DateTime.Utc }>
  | Readonly<{
      kind: "outbound";
      to: MessageAddressInput;
      content: Content;
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
  SendInputIsExact,
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
