import { it as effectIt } from "@effect/vitest";
import { ForbiddenError } from "@moltzap/protocol/rpc";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import type { Message } from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
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
  type FakeChannelService,
} from "./test-utils/index.js";

/** Re-exports the public API from `current module`. */
export {
  MoltZapChannelCore,
  ForbiddenError,
  buildMessage,
  createFakeChannelService,
  flushDispatchChainEffect,
};
/** Re-exports the public API from `current module`. */
export type {
  ChannelService,
  CrossConversationEntry,
  EnrichedInboundMessage,
  FakeChannelService,
  Message,
};

/** Provides the stuck message lease timeout ms runtime value. */
export const STUCK_MESSAGE_LEASE_TIMEOUT_MS = 50;
/** Provides the effect test runtime value. */
export const effectTest = effectIt.effect;
/** Provides the alice cached name runtime value. */
export const ALICE_CACHED_NAME = "Alice (cached)";
/** Provides the alice resolved name runtime value. */
export const ALICE_RESOLVED_NAME = "Alice (via resolve)";
/** Provides the multiline text runtime value. */
export const MULTILINE_TEXT = "line one\nline two";
/** Provides the caption text runtime value. */
export const CAPTION_TEXT = "caption";
/** Provides the first text runtime value. */
export const FIRST_TEXT = "first";
/** Provides the second text runtime value. */
export const SECOND_TEXT = "second";
/** Provides the time to vote text runtime value. */
export const TIME_TO_VOTE_TEXT = "Time to vote";
/** Provides the after marker text runtime value. */
export const AFTER_MARKER_TEXT = "after marker";
/** Provides the old discussion text runtime value. */
export const OLD_DISCUSSION_TEXT = "old discussion";
/** Provides the marker lease id runtime value. */
export const MARKER_LEASE_ID = testLeaseId("lease-marker");
/** Provides the devs group name runtime value. */
export const DEVS_GROUP_NAME = "devs";
/** Provides the first visit text runtime value. */
export const FIRST_VISIT_TEXT = "first visit";

/** Reports test inbound handler failures. */
export class TestInboundHandlerError extends Data.TaggedError(
  "TestInboundHandlerError",
)<{
  readonly message: string;
}> {}

type AdmissionRequest = DispatchAdmissionRequest;

const FALLBACK_RECEIVED_AT = "1970-01-01T00:00:00.000Z";
const LEASE_MOCK_PREFIX = "lease-mock";
const DISPATCH_MOCK_PREFIX = "dispatch-mock";

const admissionRequest = (
  params: Parameters<NonNullable<ChannelService["requestDispatch"]>>[0],
): AdmissionRequest => {
  const message: Message = {
    id: /* Safe because the surrounding invariant establishes this asserted shape. */ params.messageId as Message["id"],
    conversationId:
      /* Safe because the surrounding invariant establishes this asserted shape. */ params.conversationId as Message["conversationId"],
    senderId:
      /* Safe because the surrounding invariant establishes this asserted shape. */ params.senderAgentId as Message["senderId"],
    parts:
      /* Safe because admission fixtures establish nonempty protocol message parts before this adapter runs. */ (params.parts ??
        []) as Message["parts"],
    createdAt: params.receivedAt ?? FALLBACK_RECEIVED_AT,
  };
  return {
    message,
    conversationId: params.conversationId,
    senderAgentId: params.senderAgentId,
    attempt: params.attempt ?? 0,
    receivedAt: params.receivedAt ?? FALLBACK_RECEIVED_AT,
    pending:
      /* Safe because the surrounding invariant establishes this asserted shape. */ (params.pending ??
        []) as AdmissionRequest["pending"],
  };
};

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

/**
 * Executes the install admission operation.
 * @param fake Value supplied to the operation.
 * @param decide Value supplied to the operation.
 */
export function installAdmission(
  fake: FakeChannelService,
  decide: (
    request: AdmissionRequest,
  ) => Effect.Effect<DispatchAdmissionDecision, ServiceRpcError>,
): void {
  let counter = 0;
  fake.service.requestDispatch = (params) =>
    decide(admissionRequest(params)).pipe(
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

/** Provides the agent runtime value. */
export const agent: (agentLabel: string) => AgentId = testAgentId;
/** Provides the conversation runtime value. */
export const conversation: (conversationLabel: string) => ConversationId =
  testConversationId;
/** Provides the message runtime value. */
export const message: (messageLabel: string) => MessageId = testMessageId;
/** Re-exports the public API from `current module`. */
export { testLeaseId };
/**
 * Provides the participant runtime value.
 * @param agentLabel Value supplied to the operation.
 * @returns The created channel core fixture.
 */
export const participant = (agentLabel: string): string =>
  "agent:" + agent(agentLabel);

/** Describes channel core fixture. */
export interface ChannelCoreFixture {
  readonly fake: FakeChannelService;
  readonly service: ChannelService;
  readonly core: MoltZapChannelCore;
  readonly inbound: EnrichedInboundMessage[];
}

/**
 * Creates channel core fixture.
 * @returns The created channel core fixture.
 */
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

/**
 * Executes the custom setup operation.
 * @returns The custom setup result.
 */
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

/**
 * Executes the force resolve agent name path operation.
 * @param fake Value supplied to the operation.
 */
export function forceResolveAgentNamePath(fake: FakeChannelService): void {
  /* Safe because the surrounding invariant establishes this asserted shape. */
  (
    fake.service as { getAgentName: (id: string) => string | undefined }
  ).getAgentName = () => undefined;
}
