import { it as effectIt } from "@effect/vitest";
import { ForbiddenError } from "@moltzap/protocol/transport";
import type { LeaseId, Message } from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { Data, Effect } from "effect";

import {
  MoltZapChannelCore,
  type ChannelService,
  type DispatchAdmissionDecision,
  type DispatchAdmissionRequest,
  type DispatchReleaseFrame,
  type EnrichedInboundMessage,
} from "./channel-core.js";
import type { CrossConversationEntry, ServiceRpcError } from "./service.js";
import {
  buildMessage,
  createFakeChannelService,
  flushDispatchChainEffect,
  testAgentId,
  testConversationId,
  testLeaseId,
  testMessageId,
  testTaskId,
  type FakeChannelService,
} from "./test-utils/index.js";

export {
  MoltZapChannelCore,
  ForbiddenError,
  buildMessage,
  createFakeChannelService,
  flushDispatchChainEffect,
};
export type {
  ChannelService,
  CrossConversationEntry,
  EnrichedInboundMessage,
  FakeChannelService,
  Message,
};

export const STUCK_MESSAGE_LEASE_TIMEOUT_MS = 50;
export const effectTest = effectIt.effect;
export const ALICE_CACHED_NAME = "Alice (cached)";
export const ALICE_RESOLVED_NAME = "Alice (via resolve)";
export const MULTILINE_TEXT = "line one\nline two";
export const CAPTION_TEXT = "caption";
export const FIRST_TEXT = "first";
export const SECOND_TEXT = "second";
export const DENIED_LEASE_ID = testLeaseId("lease-den");
export const TIME_TO_VOTE_TEXT = "Time to vote";
export const AFTER_MARKER_TEXT = "after marker";
export const OLD_DISCUSSION_TEXT = "old discussion";
export const MARKER_LEASE_ID = testLeaseId("lease-marker");
export const DEVS_GROUP_NAME = "devs";
export const FIRST_VISIT_TEXT = "first visit";

export class TestInboundHandlerError extends Data.TaggedError(
  "TestInboundHandlerError",
)<{
  readonly message: string;
}> {}

type LegacyAdmissionRequest = DispatchAdmissionRequest;

const FALLBACK_RECEIVED_AT = "1970-01-01T00:00:00.000Z";
const LEASE_MOCK_PREFIX = "lease-mock";
const DISPATCH_MOCK_PREFIX = "dispatch-mock";

const legacyAdmissionRequest = (
  params: Parameters<NonNullable<ChannelService["requestDispatch"]>>[0],
): LegacyAdmissionRequest => ({
  message: {
    id: params.messageId as Message["id"],
    conversationId: params.conversationId as Message["conversationId"],
    senderId: params.senderAgentId as Message["senderId"],
    parts: (params.parts as Message["parts"] | undefined) ?? [],
    createdAt: params.receivedAt ?? FALLBACK_RECEIVED_AT,
  } as Message,
  conversationId: params.conversationId,
  senderAgentId: params.senderAgentId,
  attempt: params.attempt ?? 0,
  receivedAt: params.receivedAt ?? FALLBACK_RECEIVED_AT,
  pending: (params.pending ?? []) as LegacyAdmissionRequest["pending"],
});

const grantVerdict = (
  decision: Extract<DispatchAdmissionDecision, { readonly _tag: "grant" }>,
): Extract<
  DispatchReleaseFrame["verdict"],
  { readonly decision: "grant" }
> => ({
  decision: "grant",
  ...(decision.leaseId !== undefined ? { leaseId: decision.leaseId } : {}),
  ...(decision.leaseTimeoutMs !== undefined
    ? { leaseTimeoutMs: decision.leaseTimeoutMs }
    : {}),
  ...(decision.dispatchMessageId !== undefined
    ? { dispatchMessageId: decision.dispatchMessageId }
    : {}),
});

const holdOrDenyVerdict = (
  decision: Exclude<DispatchAdmissionDecision, { readonly _tag: "grant" }>,
): Exclude<
  DispatchReleaseFrame["verdict"],
  { readonly decision: "grant" }
> => ({
  decision: decision._tag,
  ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
});

const releaseVerdict = (
  decision: DispatchAdmissionDecision,
): DispatchReleaseFrame["verdict"] => {
  if (decision._tag === "grant") {
    return grantVerdict(decision);
  }
  return holdOrDenyVerdict(decision);
};

const releaseFrame = (
  decision: DispatchAdmissionDecision,
  leaseId: LeaseId,
  dispatchId: string,
): DispatchReleaseFrame => ({
  dispatchId,
  leaseId,
  verdict: releaseVerdict(decision),
  ...(decision._tag === "grant" && decision.leaseTimeoutMs !== undefined
    ? { leaseTimeoutMs: decision.leaseTimeoutMs }
    : {}),
});

const leaseIdForDecision = (
  decision: DispatchAdmissionDecision,
  counter: number,
): LeaseId =>
  decision._tag === "grant" && decision.leaseId !== undefined
    ? decision.leaseId
    : testLeaseId(LEASE_MOCK_PREFIX + "-" + counter.toString());

const dispatchIdForCounter = (counter: number): string =>
  DISPATCH_MOCK_PREFIX + "-" + counter.toString();

export function installAdmission(
  fake: FakeChannelService,
  decide: (
    request: LegacyAdmissionRequest,
  ) => Effect.Effect<DispatchAdmissionDecision, ServiceRpcError>,
): void {
  let counter = 0;
  fake.service.requestDispatch = (params) =>
    decide(legacyAdmissionRequest(params)).pipe(
      Effect.map((decision) => {
        counter += 1;
        const leaseId = leaseIdForDecision(decision, counter);
        const dispatchId = dispatchIdForCounter(counter);
        queueMicrotask(() => {
          fake.emit.dispatchRelease(
            releaseFrame(decision, leaseId, dispatchId),
          );
        });
        return { leaseId, dispatchId };
      }),
    );
}

export const agent: (agentLabel: string) => AgentId = testAgentId;
export const conversation: (conversationLabel: string) => ConversationId =
  testConversationId;
export const message: (messageLabel: string) => MessageId = testMessageId;
export const task: (taskLabel: string) => TaskId = testTaskId;
export { testLeaseId };
export const participant = (agentLabel: string): string =>
  "agent:" + agent(agentLabel);

export interface ChannelCoreFixture {
  readonly fake: FakeChannelService;
  readonly service: ChannelService;
  readonly core: MoltZapChannelCore;
  readonly inbound: EnrichedInboundMessage[];
}

export function createChannelCoreFixture(): ChannelCoreFixture {
  const fake = createFakeChannelService({ ownAgentId: "agent-self" });
  const inbound: EnrichedInboundMessage[] = [];
  const core = new MoltZapChannelCore({ service: fake.service });
  core.onInbound((msg) =>
    Effect.sync(() => {
      inbound.push(msg);
    }),
  );
  return { fake, service: fake.service, core, inbound };
}

export function customSetup(): {
  fake: FakeChannelService;
  core: MoltZapChannelCore;
  received: EnrichedInboundMessage[];
} {
  const fake = createFakeChannelService({ ownAgentId: "agent-self" });
  const received: EnrichedInboundMessage[] = [];
  const core = new MoltZapChannelCore({ service: fake.service });
  core.onInbound((m) =>
    Effect.sync(() => {
      received.push(m);
    }),
  );
  return { fake, core, received };
}

export function forceResolveAgentNamePath(fake: FakeChannelService): void {
  (
    fake.service as { getAgentName: (id: string) => string | undefined }
  ).getAgentName = () => undefined;
}
