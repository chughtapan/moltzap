/** @file Record certification, evidence persistence, and host projection. */

import {
  type AgentId,
  MOLTZAP_VERSION,
  SignedMessage,
} from "@moltzap/identity";
import { DateTime, Effect, Schema } from "effect";
import type {
  EngineActionFold,
  EngineConversation,
  EngineRuntime,
} from "./engine-types.js";
import type {
  InboundDeliveryInput,
  ProtocolEvidence,
  StagedRecord,
  CertifiedRecord as StoredCertifiedRecord,
} from "./store.js";
import {
  AgentAddress,
  GroupAddress,
  InboundMessage,
  type InboundMessage as InboundMessageValue,
} from "../contract.js";
import {
  type ActionCertifiedRecord,
  type AnchorHash,
  type CertifiedRecord,
  ClientRepresentationError,
  compareAgentIds,
  encodeCanonical,
  hashAnchor,
  hashRecord,
  type RecordCore,
  RecordCore as RecordCoreSchema,
} from "./representation.js";

const compareAscii = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
};

function requireNonEmpty<Value>(
  values: readonly Value[],
): Effect.Effect<readonly [Value, ...Value[]], ClientRepresentationError> {
  const first = values[0];
  if (first === undefined) {
    return Effect.fail(representationFailure());
  }
  return Effect.succeed([first, ...values.slice(1)]);
}

function representationFailure(): ClientRepresentationError {
  return new ClientRepresentationError();
}

/**
 * Resolve the immutable Router anchor bound when one action fold is created.
 * @param fold Selected action and its action-specific Router anchor.
 * @returns The canonical anchor hash committed by the record core.
 */
export const recordAnchorHash = (
  fold: EngineActionFold,
): Effect.Effect<AnchorHash, ClientRepresentationError> =>
  fold.action.kind === "GENESIS"
    ? hashAnchor(fold.action.anchor)
    : Effect.succeed(fold.action.anchorHash);

/**
 * Encode signer evidence in canonical decoded-AgentId order.
 * @param evidence Verified signer messages keyed by signer identity.
 * @returns Canonically ordered nonempty encoded evidence.
 */
const encodeOrderedEvidence = (
  evidence: ReadonlyMap<AgentId, SignedMessage>,
): Effect.Effect<
  readonly [unknown, ...unknown[]],
  ClientRepresentationError
> => {
  const messages = [...evidence.values()].sort((left, right) =>
    compareAgentIds(left.senderAgentId, right.senderAgentId),
  );
  return Effect.forEach(
    messages,
    (message) =>
      Schema.encode(SignedMessage)(message).pipe(
        Effect.mapError(representationFailure),
      ),
    { concurrency: 1 },
  ).pipe(Effect.flatMap(requireNonEmpty));
};

/**
 * Convert one verified inner signature into its durable evidence row.
 * @param conversationId Private conversation that owns the evidence.
 * @param kind Evidence statement family retained by the store.
 * @param subjectId Hash named by the evidence statement.
 * @param message Verified self-addressed evidence message.
 * @returns Canonical durable evidence without changing its signer bytes.
 */
export const protocolEvidence = (
  conversationId: string,
  kind: ProtocolEvidence["kind"],
  subjectId: string,
  message: SignedMessage,
): Effect.Effect<ProtocolEvidence, ClientRepresentationError> =>
  encodeCanonical(SignedMessage, message).pipe(
    Effect.map((canonicalEvidence) => ({
      conversationId,
      kind,
      subjectId,
      evidenceKey: message.senderAgentId,
      canonicalEvidence,
    })),
  );

/**
 * Build the action-certified record after its threshold is reached.
 * @param fold In-memory fold containing verified action evidence.
 * @param anchorHash Completed anchor bound by the record core.
 * @returns One evidence-independent record core with its action certificate.
 */
export const makeActionCertifiedRecord = (
  fold: EngineActionFold,
  anchorHash: RecordCore["anchorHash"],
): Effect.Effect<ActionCertifiedRecord, ClientRepresentationError> =>
  Effect.gen(function* () {
    const signatures = yield* encodeOrderedEvidence(fold.actionEvidence);
    const recordCore: RecordCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "record_core",
      membership: fold.conversation.membership.descriptor,
      anchorHash,
      action: fold.action,
      actionHash: fold.actionHash,
    };
    const actionCertifiedRecord: ActionCertifiedRecord = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record",
      recordHash: yield* hashRecord(recordCore),
      recordCore,
      routerAnchor: fold.routerAnchor,
      actionCertificate: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_certificate",
        actionHash: fold.actionHash,
        signatures,
      },
    };
    return actionCertifiedRecord;
  }).pipe(Effect.withSpan("makeActionCertifiedRecord"));

/**
 * Add a durability certificate without changing the certified record hash.
 * @param actionCertifiedRecord Action-certified core being finalized.
 * @param fold In-memory fold containing verified durability evidence.
 * @returns One complete certified record with mergeable durability votes.
 */
export const makeCertifiedRecord = (
  actionCertifiedRecord: ActionCertifiedRecord,
  fold: EngineActionFold,
): Effect.Effect<CertifiedRecord, ClientRepresentationError> =>
  encodeOrderedEvidence(fold.durabilityEvidence).pipe(
    Effect.map((votes) => {
      const certifiedRecord: CertifiedRecord = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "certified_record",
        actionCertifiedRecord,
        durabilityCertificate: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "durability_certificate",
          recordHash: actionCertifiedRecord.recordHash,
          votes,
        },
      };
      return certifiedRecord;
    }),
  );

/**
 * Convert one verified record core to the store's evidence-free staging row.
 * @param record Verified action-certified record from the protocol fold.
 * @returns Canonical evidence-free row used for atomic staging.
 */
export const stagedRecord = (
  record: ActionCertifiedRecord,
): Effect.Effect<StagedRecord, ClientRepresentationError> => {
  const action = record.recordCore.action;
  return encodeCanonical(RecordCoreSchema, record.recordCore).pipe(
    Effect.map((canonicalRecordCore) => ({
      conversationId: action.conversationId,
      recordHash: record.recordHash,
      ...(action.previousRecordHash === null
        ? {}
        : { previousRecordHash: action.previousRecordHash }),
      membershipHash:
        action.kind === "GENESIS"
          ? action.postIntent.membershipHash
          : action.membershipHash,
      anchorHash: record.recordCore.anchorHash,
      actionHash: record.recordCore.actionHash,
      authorAgentId: action.postIntent.authorAgentId,
      postId: action.postIntent.postId,
      canonicalRecordCore,
    })),
  );
};

/**
 * Convert a complete wire record into one complete store promotion row.
 * @param record Complete certified wire record.
 * @param fold In-memory fold retaining verified signer messages.
 * @returns Store promotion data with separate action and durability evidence.
 */
export const storedCertifiedRecord = (
  record: CertifiedRecord,
  fold: EngineActionFold,
): Effect.Effect<StoredCertifiedRecord, ClientRepresentationError> =>
  Effect.gen(function* () {
    const staged = yield* stagedRecord(record.actionCertifiedRecord);
    const actionEvidence = yield* Effect.forEach(
      [...fold.actionEvidence.values()],
      (message) =>
        protocolEvidence(
          staged.conversationId,
          "action",
          staged.actionHash,
          message,
        ),
      { concurrency: 1 },
    );
    const durabilityEvidence = yield* Effect.forEach(
      [...fold.durabilityEvidence.values()],
      (message) =>
        protocolEvidence(
          staged.conversationId,
          "durability",
          staged.recordHash,
          message,
        ),
      { concurrency: 1 },
    );
    return { ...staged, actionEvidence, durabilityEvidence };
  }).pipe(Effect.withSpan("storedCertifiedRecord"));

const addressFor = (agentName: string) =>
  Schema.decodeUnknown(AgentAddress)(`agent:${agentName}`).pipe(
    Effect.mapError(representationFailure),
  );

const projectGroupMessage = (
  conversation: EngineConversation,
  intent: RecordCore["action"]["postIntent"],
  sender: Effect.Effect.Success<ReturnType<typeof addressFor>>,
): Effect.Effect<InboundMessageValue, ClientRepresentationError> =>
  Effect.gen(function* () {
    const names = conversation.membership.members
      .map((member) => member.agentName)
      .sort(compareAscii);
    const address = yield* Schema.decodeUnknown(GroupAddress)(
      `group:${names.join(",")}`,
    ).pipe(Effect.mapError(representationFailure));
    const members = yield* Effect.forEach(names, addressFor, {
      concurrency: 1,
    });
    const first = members[0];
    const second = members[1];
    const third = members[2];
    if (first === undefined || second === undefined || third === undefined) {
      return yield* Effect.fail(representationFailure());
    }
    return {
      kind: "group",
      postId: intent.postId,
      address,
      sender,
      members: [first, second, third, ...members.slice(3)],
      content: intent.content,
    };
  });

/**
 * Project one remote record to its exact host-visible addressed message.
 * @param conversation Verified local conversation state and member cards.
 * @param record Complete remote-authored certified record.
 * @returns Canonical direct or group message for pending Client delivery.
 */
const projectInboundMessage = (
  conversation: EngineConversation,
  record: CertifiedRecord,
): Effect.Effect<InboundMessageValue, ClientRepresentationError> =>
  Effect.gen(function* () {
    const intent = record.actionCertifiedRecord.recordCore.action.postIntent;
    const author = conversation.membership.members.find(
      (member) => member.agentId === intent.authorAgentId,
    );
    if (author === undefined) {
      return yield* Effect.fail(representationFailure());
    }
    const sender = yield* addressFor(author.agentName);
    if (conversation.membership.members.length === 2) {
      const directMessage: InboundMessageValue = {
        kind: "direct",
        postId: intent.postId,
        address: sender,
        sender,
        content: intent.content,
      };
      return directMessage;
    }
    return yield* projectGroupMessage(conversation, intent, sender);
  }).pipe(Effect.withSpan("projectInboundMessage"));

/** The store's canonical pending delivery beside the message it encodes. */
export interface InboundDeliveryProjection {
  readonly input: InboundDeliveryInput;
  readonly message: InboundMessageValue;
}

/**
 * Encode the remote projection atomically retained during promotion.
 * @param conversation Verified local conversation state and member cards.
 * @param record Complete remote-authored certified record.
 * @param recipientAgentId Local recipient that owns the pending delivery.
 * @returns Canonical pending-delivery input for atomic record promotion, with
 * the decoded message it was encoded from.
 */
export const inboundDelivery = (
  conversation: EngineConversation,
  record: CertifiedRecord,
  recipientAgentId: AgentId,
): Effect.Effect<InboundDeliveryProjection, ClientRepresentationError> =>
  projectInboundMessage(conversation, record).pipe(
    Effect.flatMap((message) =>
      encodeCanonical(InboundMessage, message).pipe(
        Effect.map((canonicalMessage) => ({
          input: { recipientAgentId, canonicalMessage },
          message,
        })),
      ),
    ),
  );

/**
 * Record one durable inbound delivery in the history export, if any.
 * @param runtime Current engine state and protocol dependencies.
 * @param message The exact host-visible message the store now holds.
 * @returns Completion; a missing export records nothing.
 */
export const exportInbound = (
  runtime: EngineRuntime,
  message: InboundMessageValue,
): Effect.Effect<void> =>
  DateTime.now.pipe(
    Effect.flatMap((at) =>
      runtime.input.historyExport.record({ kind: "inbound", message, at }),
    ),
  );
