/** @file Client-owned evidence capture and checks without protocol or delivery locks. */

import { AgentCard, type VerifiedAgentCard } from "@moltzap/identity";
import { Effect, Option, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import type {
  CollectiveError,
  FailureDelivery,
  SendInput,
} from "../transport/collectives/forms.js";
import type { EndpointEngine } from "../transport/messaging/index.js";
import {
  CheckInputError,
  type Firewall,
  type FirewallCheck,
  type FirewallSettings,
  makeFirewall,
  Message,
  MessageContext,
  type MessageMiddleware,
  projectFeedback,
} from "../firewall/index.js";
import { FirewallSendError, type LocalGuidance } from "../firewall/runtime.js";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
  type FirewallCompletion,
  type FirewallEvidence,
  type FirewallHistoryEntry,
  type FirewallInboxEntry,
  MAXIMUM_RUNTIME_ITEM_BYTES,
} from "../store/index.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import {
  type CollectiveOperations,
  type CollectiveSendOutcome,
  encodeCollectiveContent,
  readCollectiveValue,
  withoutCollectivePart,
} from "../transport/collectives/index.js";
import { renderContent } from "../transport/collectives/render.js";
import { SendError } from "../transport/messaging/errors.js";
import {
  MembershipDescriptor,
  type PostIntent,
  RecordCore,
  type VerifiedMembership,
} from "../transport/wire/index.js";
import {
  decodeFirewallConfiguration,
  decodeFirewallInstallation,
  decodeFirewallRegistration,
  type FirewallConfiguration,
  type FirewallInstallation,
} from "./firewall-values.js";

// safer-arch-ignore file-implicit-boundary-module: Delivery composition and its admission worker share one immutable installation and evidence pipeline; this private implementation is exposed only through delivery/index.ts.

/** Trusted process composition installs fixed chains; agent-facing tools cannot change them. */
export interface FirewallOptions {
  readonly mode: "guidance" | "enforcement";
  readonly incoming: readonly MessageMiddleware[];
  readonly outgoing: readonly MessageMiddleware[];
  readonly settings: FirewallSettings;
  readonly facts: MessageContext["facts"];
  readonly codeDigest: string;
  readonly maximumHistoryRecords?: number;
  readonly maximumConcurrentChecks?: number;
}

/** Private immutable installation with one inference limit shared by both directions. */
export interface InstalledFirewall {
  readonly configuration: FirewallConfiguration;
  readonly configurationDigest: string;
  readonly metadata: FirewallInstallation;
  readonly firewall: Firewall;
  readonly permits: Effect.Semaphore;
}

const registrationMetadata = ({
  id,
  revision,
  rules,
  provenance,
}: MessageMiddleware) => ({
  id,
  revision,
  rules,
  provenance: provenance ?? {
    format: "unavailable",
    data: "No descriptive provenance was declared.",
  },
});

const captureRegistration = Effect.fn("captureRegistration")(function* (
  entry: MessageMiddleware,
) {
  const check = entry.check.bind(entry);
  const metadata = yield* decodeFirewallRegistration(
    registrationMetadata(entry),
  ).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
  return Object.freeze({ ...metadata, check });
});

/** Configuration and registration bytes are captured before a daemon accepts operations. */
export const installFirewall = Effect.fn("installFirewall")(function* (
  options: FirewallOptions,
) {
  const configuration = yield* captureConfiguration(options);
  const incoming = yield* Effect.forEach(
    options.incoming,
    captureRegistration,
    { concurrency: 1 },
  );
  const outgoing = yield* Effect.forEach(
    options.outgoing,
    captureRegistration,
    { concurrency: 1 },
  );
  const metadata = yield* decodeFirewallInstallation({
    configuration,
    settings: options.settings,
    incoming: incoming.map(registrationMetadata),
    outgoing: outgoing.map(registrationMetadata),
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
  const firewall = yield* makeFirewall({
    incoming,
    outgoing,
    settings: metadata.settings,
  });
  const bytes = yield* encodeRuntimeValue(metadata).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(new CheckInputError({ reason: "registration" })),
    ),
  );
  return Object.freeze({
    configuration,
    metadata,
    configurationDigest: createHash("sha256").update(bytes).digest("hex"),
    firewall,
    permits: yield* Effect.makeSemaphore(configuration.maximumConcurrentChecks),
  }) satisfies InstalledFirewall;
});

/** An exact prepared post is checked before any durable intent exists. */
interface OutgoingCandidate {
  readonly intent: PostIntent;
  readonly membership: VerifiedMembership;
  readonly canonicalIntent: Uint8Array;
}

/** The terminal hold does not ask the provider to run after two stale attempts. */
export interface CheckedMessage {
  readonly completion: FirewallCompletion;
  readonly result: FirewallCheck;
  readonly guidance?: LocalGuidance;
}

/** Store and verified local attribution remain outside middleware's data-only interface. */
export interface FirewallEnvironment {
  readonly store: EndpointStore;
  readonly installed: InstalledFirewall;
  readonly localAgentCard: VerifiedAgentCard;
}

function projectMessage(
  intent: PostIntent,
  cards: readonly AgentCard[],
  supported = true,
) {
  const recipients = cards
    .map((card) => card.agentId)
    .filter((id) => id !== intent.authorAgentId);
  const content = supported
    ? withoutCollectivePart(intent.content)
    : intent.content;
  const [first, ...rest] = content;
  return Schema.decodeUnknown(Message)({
    id: messageId(intent),
    sender: intent.authorAgentId,
    recipients,
    text: first === undefined ? "" : renderContent([first, ...rest]),
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
  );
}

function messageId(intent: PostIntent): string {
  const identity = `${intent.authorAgentId}:${intent.postId}`;
  return `msg_${createHash("sha256").update(identity).digest("hex")}`;
}

function isMulticast(intent: PostIntent): Effect.Effect<boolean> {
  return readCollectiveValue(intent.content).pipe(
    Effect.map(
      Option.match({
        onNone: () => true,
        onSome: (value) =>
          value.kind === "operation" && value.op === "multicast",
      }),
    ),
    Effect.catchTag("CollectivePartInvalidError", () => Effect.succeed(false)),
  );
}

const decodeHistory = Effect.fn("decodeFirewallHistory")(function* (
  entry: FirewallHistoryEntry,
) {
  const record = yield* decodeRuntimeValue(
    RecordCore,
    entry.canonicalRecordCore,
  );
  const membership = yield* decodeRuntimeValue(
    MembershipDescriptor,
    entry.canonicalMembership,
  );
  const cards = yield* Effect.forEach(
    membership.members,
    (card) => Schema.decodeUnknown(AgentCard)(card),
    { concurrency: 1 },
  ).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
  );
  const intent = record.action.postIntent;
  if (!cards.some((card) => card.agentId === intent.authorAgentId)) {
    return yield* new EndpointStoreError({ reason: "corrupt" });
  }
  const supported = yield* isMulticast(intent);
  return {
    message: yield* projectMessage(intent, cards, supported),
    intent,
    cards,
    supported,
    admitted: entry.visible,
    visible: entry.visible && supported,
  };
});

/** Certified local sends are admitted evidence without granting host visibility to owner history. */
const contextFrom = Effect.fn("firewallContext")(function* (
  environment: FirewallEnvironment,
  evidence: FirewallEvidence,
  candidateCards: readonly AgentCard[],
) {
  const history = yield* Effect.forEach(evidence.history, decodeHistory, {
    concurrency: 1,
  });
  const cards = new Map<string, AgentCard>();
  for (const card of [
    environment.localAgentCard,
    ...candidateCards,
    ...history.flatMap((entry) => entry.cards),
  ]) {
    cards.set(card.agentId, card);
  }
  return new MessageContext({
    agentId: environment.localAgentCard.agentId,
    principal: environment.localAgentCard.principalId,
    participants: [...cards.values()].map((card) => ({
      agentId: card.agentId,
      principal: card.principalId,
    })),
    history: contextHistory(history, environment.localAgentCard.agentId),
    earlierHistoryOmitted: evidence.earlierHistoryOmitted,
    facts: environment.installed.configuration.facts,
    gaps: [
      ...(evidence.overflow
        ? ["Authorized earlier history exceeds the 2 MiB evidence byte bound."]
        : []),
      ...(evidence.pendingOutgoing
        ? ["An earlier outgoing intent has not reached certified completion."]
        : []),
    ],
    authorization: { kind: "absent" },
  });
});

function contextHistory(
  history: ReadonlyArray<
    Effect.Effect.Success<ReturnType<typeof decodeHistory>>
  >,
  localAgentId: string,
): MessageContext["history"] {
  return history.map((entry) => ({
    id: entry.message.id,
    sender: entry.message.sender,
    recipients: entry.message.recipients,
    text: entry.message.text,
    visibility: entry.visible ? "runtime" : "assessor",
    admission:
      entry.admitted || entry.message.sender === localAgentId
        ? "admitted"
        : "withheld",
  }));
}

interface AssessmentInput {
  readonly direction: "incoming" | "outgoing";
  readonly evidence: FirewallEvidence;
  readonly canonicalCandidate: Uint8Array;
  readonly message?: Message;
  readonly cards: readonly AgentCard[];
  readonly terminal: boolean;
}

/** Projection failure holds enforcement while shadow admission omits unusable advice. */
const guidanceProjection = Effect.fn("guidanceProjection")(function* (
  result: FirewallCheck,
  input: AssessmentInput,
  context: MessageContext,
  checkId: string,
) {
  if (input.direction !== "incoming" || result.guidance.length === 0) {
    return { result };
  }
  const subjects = guidanceSubjects(result, input, context);
  const selected = new Set(result.guidance.flatMap((entry) => entry.subjects));
  const guidance: LocalGuidance = {
    checkId,
    instructions: result.guidance,
    subjects,
  };
  const bytes = yield* encodeRuntimeValue(guidance);
  if (
    subjects.length !== selected.size ||
    bytes.byteLength + input.canonicalCandidate.byteLength >
      MAXIMUM_RUNTIME_ITEM_BYTES
  ) {
    return {
      result: { ...unavailable("check-unavailable"), checks: result.checks },
    };
  }
  return { result, guidance };
});

/** Hex references survive host credential redaction and preserve native audit correlation. */
const assess = Effect.fn("assessMessage")(function* (
  environment: FirewallEnvironment,
  input: AssessmentInput,
) {
  const context = yield* contextFrom(environment, input.evidence, input.cards);
  const checkId = `chk_${randomBytes(32).toString("hex")}`;
  yield* environment.store.beginFirewallAttempt({
    checkId,
    direction: input.direction,
    revision: input.evidence.revision,
    canonicalCandidate: input.canonicalCandidate,
    canonicalInput: yield* encodeRuntimeValue({
      configurationDigest: environment.installed.configurationDigest,
      installation: environment.installed.metadata,
      context,
      message: input.message ?? null,
      terminal: input.terminal,
    }),
  });
  const assessed = yield* runAssessment(environment, input, context);
  const projection = yield* guidanceProjection(
    assessed,
    input,
    context,
    checkId,
  );
  const result = projection.result;
  const shadow =
    input.terminal && environment.installed.configuration.mode === "guidance";
  const admit =
    environment.installed.configuration.mode === "guidance" ||
    result.judgment === "allow";
  return {
    result,
    completion: {
      checkId,
      admit,
      canonicalResult: yield* encodeRuntimeValue(result),
      ...(shadow ? ({ shadow: true } as const) : {}),
    },
    ...(admit && projection.guidance !== undefined
      ? { guidance: projection.guidance }
      : {}),
  } satisfies CheckedMessage;
});

function runAssessment(
  environment: FirewallEnvironment,
  input: AssessmentInput,
  context: MessageContext,
) {
  if (input.terminal) {
    return Effect.succeed(unavailable("unresolved-evidence"));
  }
  if (input.message === undefined) {
    return Effect.succeed(unavailable("check-unavailable"));
  }
  const check =
    input.direction === "incoming"
      ? environment.installed.firewall.checkIncoming(input.message, context)
      : environment.installed.firewall.checkOutgoing(input.message, context);
  return check.pipe(
    Effect.catchTag("CheckInputError", () =>
      Effect.succeed(unavailable("check-unavailable")),
    ),
  );
}

/** The check permit covers capture and inference, never intent activation or protocol work. */
const checkOutgoing = (
  environment: FirewallEnvironment,
  candidate: OutgoingCandidate,
  terminal = false,
): Effect.Effect<CheckedMessage, EndpointStoreError> =>
  environment.installed.permits
    .withPermits(1)(
      Effect.gen(function* () {
        const evidence = yield* environment.store.readFirewallEvidence({
          conversationId: candidate.intent.conversationId,
          maximumRecords:
            environment.installed.configuration.maximumHistoryRecords,
        });
        const cards = candidate.membership.members;
        return yield* assess(environment, {
          direction: "outgoing",
          evidence,
          canonicalCandidate: candidate.canonicalIntent,
          message: yield* projectMessage(candidate.intent, cards),
          cards,
          terminal,
        });
      }),
    )
    .pipe(Effect.withSpan("checkOutgoing"));

/** Only the immutable certified candidate supplies author and recipient attribution. */
export const checkIncoming = (
  environment: FirewallEnvironment,
  entry: FirewallInboxEntry,
  terminal = false,
): Effect.Effect<CheckedMessage, EndpointStoreError> =>
  environment.installed.permits
    .withPermits(1)(
      Effect.gen(function* () {
        const evidence = yield* environment.store.readFirewallEvidence({
          beforeDelivery: entry.deliveryToken,
          maximumRecords:
            environment.installed.configuration.maximumHistoryRecords,
        });
        const candidate =
          evidence.candidate === undefined
            ? undefined
            : yield* decodeHistory(evidence.candidate);
        const item = yield* decodeRuntimeValue(
          InboundItem,
          entry.canonicalItem,
        );
        const message =
          candidate === undefined
            ? undefined
            : yield* checkedIncomingProjection(item, candidate);
        return yield* assess(environment, {
          direction: "incoming",
          evidence,
          canonicalCandidate: entry.canonicalItem,
          ...(message === undefined ? {} : { message }),
          cards: candidate?.cards ?? [],
          terminal,
        });
      }),
    )
    .pipe(Effect.withSpan("checkIncoming"));

function checkedIncomingProjection(
  item: InboundItem,
  candidate: Effect.Effect.Success<ReturnType<typeof decodeHistory>>,
) {
  if (item.kind !== "multicast" || !candidate.supported) {
    return Effect.succeed(undefined);
  }
  const author = candidate.cards.find(
    (card) => card.agentId === candidate.intent.authorAgentId,
  );
  const sameMessage =
    item.message.postId === candidate.intent.postId &&
    item.message.sender === `agent:${author?.agentName}` &&
    renderContent(item.message.content) === candidate.message.text;
  return sameMessage && sameAudience(item.message, candidate.cards)
    ? Effect.succeed(candidate.message)
    : Effect.fail(new EndpointStoreError({ reason: "corrupt" }));
}

function sameAudience(
  message: Extract<InboundItem, { kind: "multicast" }>["message"],
  cards: readonly AgentCard[],
): boolean {
  if (message.kind === "direct") {
    return cards.length === 2;
  }
  const expected = cards.map((card) => `agent:${card.agentName}`);
  return (
    expected.length === message.members.length &&
    message.members.every((member) => expected.includes(member))
  );
}

/**
 * Application multicast checks precede intent creation; protocol sends retain their own path.
 *
 * ```mermaid
 * flowchart LR
 *   D[Exact draft and resolved members] --> C[Capture local evidence]
 *   C --> F[Run full outgoing middleware chain]
 *   F --> A[Compare evidence and candidate atomically]
 *   A -->|allow| I[Bind intent and run existing protocol]
 *   A -->|refuse| E[Return send error and registered feedback]
 *   A -->|stale once| C
 * ```
 */
export const sendWithFirewall = (
  environment: FirewallEnvironment,
  engine: EndpointEngine,
  collectives: CollectiveOperations,
  request: {
    readonly input: SendInput;
    readonly failureDelivery: FailureDelivery;
  },
): Effect.Effect<
  CollectiveSendOutcome,
  SendError | CollectiveError | FirewallSendError
> => {
  const { input, failureDelivery } = request;
  if (
    "text" in input &&
    (input.collective?.op === undefined || input.collective.op === "multicast")
  ) {
    return sendMulticast(environment, engine, input);
  }
  return checkUnsupported(environment, input).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(new SendError({ reason: "persistence-failed" })),
    ),
    Effect.withSpan("sendWithFirewall"),
    Effect.flatMap(
      (
        checked,
      ): Effect.Effect<
        CollectiveSendOutcome,
        SendError | CollectiveError | FirewallSendError
      > =>
        checked.completion.admit
          ? collectives.send(input, failureDelivery)
          : Effect.fail(refusedSend(checked)),
    ),
  );
};

function unavailable(
  reason: "check-unavailable" | "unresolved-evidence",
): FirewallCheck {
  return {
    judgment: "hold",
    reason,
    feedback: projectFeedback([], [], reason),
    guidance: [],
    checks: [],
  };
}

/** Only already admitted history and the incoming candidate can explain a selected subject. */
function guidanceSubjects(
  result: FirewallCheck,
  input: AssessmentInput,
  context: MessageContext,
): LocalGuidance["subjects"] {
  const selected = new Set(result.guidance.flatMap((entry) => entry.subjects));
  const available = context.history.filter(
    (entry) => entry.visibility === "runtime" && entry.admission === "admitted",
  );
  const candidate = input.message === undefined ? [] : [input.message];
  const subjects = new Map(
    [...available, ...candidate].map((entry) => [entry.id, entry]),
  );
  return [...subjects.values()]
    .filter((entry) => selected.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      sender: entry.sender,
      recipients: entry.recipients,
      text: entry.text,
    }));
}

function captureConfiguration(options: FirewallOptions) {
  return decodeFirewallConfiguration({
    mode: options.mode,
    facts: options.facts,
    codeDigest: options.codeDigest,
    maximumHistoryRecords: options.maximumHistoryRecords ?? 256,
    maximumConcurrentChecks: options.maximumConcurrentChecks ?? 4,
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "settings" })),
    ),
  );
}

function checkUnsupported(environment: FirewallEnvironment, input: SendInput) {
  return environment.installed.permits.withPermits(1)(
    Effect.gen(function* () {
      const evidence = yield* environment.store.readFirewallEvidence({
        maximumRecords:
          environment.installed.configuration.maximumHistoryRecords,
      });
      const checked = yield* assess(environment, {
        direction: "outgoing",
        evidence,
        canonicalCandidate: yield* encodeRuntimeValue(input),
        cards: [],
        terminal: false,
      });
      yield* environment.store.finishFirewallAttempt(checked.completion);
      return checked;
    }),
  );
}

/** Projection deliberately excludes provider diagnostics and assessor-only evidence. */
function refusedSend(checked: CheckedMessage): FirewallSendError {
  return new FirewallSendError({
    checkId: checked.completion.checkId,
    refusal:
      checked.result.reason === "eligible"
        ? "unresolved-evidence"
        : checked.result.reason,
    feedback: checked.result.feedback,
  });
}

function sendMulticast(
  environment: FirewallEnvironment,
  engine: EndpointEngine,
  input: Extract<SendInput, { readonly text: string }>,
) {
  return encodeCollectiveContent(
    { kind: "operation", op: "multicast" },
    input.text,
  ).pipe(
    Effect.catchTag("CollectiveContentError", () =>
      Effect.fail(new SendError({ reason: "content-invalid" })),
    ),
    Effect.flatMap((content) =>
      engine.sendChecked({ to: input.to, content }, (candidate, terminal) =>
        checkOutgoing(environment, candidate, terminal).pipe(
          Effect.map((checked) => ({
            completion: checked.completion,
            refusal: refusedSend(checked),
          })),
        ),
      ),
    ),
    Effect.map((post) => ({ postIds: [post.postId] })),
  );
}
