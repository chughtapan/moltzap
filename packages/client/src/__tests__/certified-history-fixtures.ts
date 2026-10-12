/**
 * @file A signed two-member GENESIS record, the store rows its endpoint
 * keeps, and the corrupt reads of those rows stored-history tests start from.
 */

import {
  AgentCard,
  type AgentSigningAuthority,
  MOLTZAP_VERSION,
  SignedMessage,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type {
  EndpointStore,
  ProtocolEvidence,
  StoredAnchor,
  CertifiedRecord as StoredCertifiedRecord,
} from "../store/index.js";
import {
  inboundDelivery,
  protocolEvidence,
  stagedRecord,
} from "../transport/messaging/history/index.js";
import {
  ActionCore,
  type ActionHash,
  type CertifiedRecord,
  encodeCanonical,
  type EvidenceStatement,
  type GenesisActionCore,
  type GenesisAnchorBody,
  GenesisAnchorBody as GenesisAnchorBodySchema,
  hashAction,
  hashAnchor,
  hashPostIntent,
  hashRecord,
  MembershipDescriptor,
  mintPostId,
  type PostIntent,
  type RecordCore,
  type RecordHash,
  signEvidenceMessage,
  type VerifiedMembership,
} from "../transport/wire/index.js";

/** One member's verified card and the authority that signs as it. */
export interface SigningIdentity {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthority;
}

/** A GENESIS record core with its anchor and both certificates' signers. */
interface CertifiedGenesisParts {
  readonly recordCore: RecordCore;
  readonly recordHash: RecordHash;
  readonly anchor: GenesisAnchorBody;
  readonly signatures: readonly [unknown, unknown];
  readonly votes: readonly [unknown, unknown];
}

/**
 * A GENESIS record authored by `remote` and certified by both members, on a
 * genesis anchor at `routerInstanceId`. Each certificate lists `local`'s
 * signature first, whatever the members' AgentId order.
 * @param local One member of the two-member conversation.
 * @param remote The other member, who authors the post.
 * @param membership The verified two-member membership.
 * @param routerInstanceId The Router instance the genesis anchor binds.
 * @returns The complete certified record.
 */
export const buildCertifiedGenesis = (
  local: SigningIdentity,
  remote: SigningIdentity,
  membership: VerifiedMembership,
  routerInstanceId: GenesisAnchorBody["routerInstanceId"],
): Effect.Effect<CertifiedRecord> =>
  Effect.gen(function* () {
    const action = yield* genesisAction(remote, membership, routerInstanceId);
    const actionHash = yield* hashAction(action);
    const recordCore: RecordCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "record_core",
      membership: membership.descriptor,
      anchorHash: yield* hashAnchor(action.anchor),
      action,
      actionHash,
    };
    const recordHash = yield* hashRecord(recordCore);
    return certifiedGenesis({
      recordCore,
      recordHash,
      anchor: action.anchor,
      signatures: yield* Effect.all([
        signAction(local, actionHash),
        signAction(remote, actionHash),
      ]),
      votes: yield* Effect.all([
        voteDurable(local, membership, recordHash),
        voteDurable(remote, membership, recordHash),
      ]),
    });
  }).pipe(Effect.orDie, Effect.withSpan("buildCertifiedGenesis"));

/**
 * Keep a certified GENESIS record in `local`'s store as its endpoint does:
 * bind the local identity, lock the GENESIS proposal with the conversation's
 * membership and genesis anchor, then keep the record row, with one evidence
 * row per signer, and the remote author's post as the local delivery.
 * @param store The endpoint store to write.
 * @param local The card of the agent whose store this is.
 * @param membership The record's verified membership.
 * @param record A record from `buildCertifiedGenesis`.
 * @returns Completion once every write is durable.
 */
export const storeCertifiedGenesis = (
  store: EndpointStore,
  local: VerifiedAgentCard,
  membership: VerifiedMembership,
  record: CertifiedRecord,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* store.bindIdentity({
      agentId: local.agentId,
      canonicalAgentCard: yield* encodeCanonical(AgentCard, local),
    });
    yield* lockGenesis(store, membership, record);
    yield* store.applyCertifiedRecord(
      yield* storedRecordRow(record),
      yield* remotePost(local, membership, record),
    );
  }).pipe(Effect.orDie, Effect.withSpan("storeCertifiedGenesis"));

/**
 * `store` as it reads once `signer`'s action evidence row is filed under
 * `claimed`, so the row's key no longer names the member who signed it.
 * Every read that returns the row returns it misfiled: the recovery
 * snapshot's evidence and certified records, and each history page.
 * @param store The store holding the row.
 * @param signer The member whose action evidence row is misfiled.
 * @param claimed The member the row is filed under instead.
 * @returns The store with every read of the row misfiled.
 */
export function withMisattributedActionEvidence(
  store: EndpointStore,
  signer: string,
  claimed: string,
): EndpointStore {
  return {
    ...store,
    recover: () =>
      store.recover().pipe(
        Effect.map((recovery) => ({
          ...recovery,
          evidence: recovery.evidence.map((evidence) =>
            misattributeEvidence(evidence, signer, claimed),
          ),
          certifiedRecords: recovery.certifiedRecords.map((record) =>
            misattributeRecordEvidence(record, signer, claimed),
          ),
        })),
      ),
    readConversation: (request) =>
      store.readConversation(request).pipe(
        Effect.map((page) => ({
          ...page,
          records: page.records.map((record) =>
            misattributeRecordEvidence(record, signer, claimed),
          ),
        })),
      ),
  };
}

/**
 * `store` as it reads once its genesis anchor rows claim to select
 * `recordHash`, which only a completed re-anchor row does, so the rows'
 * columns no longer match the genesis bodies they hold.
 * @param store The store holding the genesis anchor rows.
 * @param recordHash The record each genesis row claims to select.
 * @returns The store with every genesis anchor row selecting `recordHash`.
 */
export function withGenesisAnchorSelecting(
  store: EndpointStore,
  recordHash: string,
): EndpointStore {
  return {
    ...store,
    recover: () =>
      store.recover().pipe(
        Effect.map((recovery) => ({
          ...recovery,
          anchors: recovery.anchors.map(
            (anchor): StoredAnchor =>
              anchor.previousAnchorHash === undefined
                ? { ...anchor, selectedRecordHash: recordHash }
                : anchor,
          ),
        })),
      ),
  };
}

/**
 * Sign one evidence statement as `identity` and encode it as the JWS
 * representation a certificate carries.
 * @param identity The member who signs.
 * @param statement The evidence statement it signs.
 * @returns The encoded signer message.
 */
export function signEvidence(
  identity: SigningIdentity,
  statement: EvidenceStatement,
) {
  return signEvidenceMessage({
    statement,
    agentCard: identity.card,
    signingAuthority: identity.authority,
  }).pipe(Effect.flatMap((message) => Schema.encode(SignedMessage)(message)));
}

function genesisAction(
  author: SigningIdentity,
  membership: VerifiedMembership,
  routerInstanceId: GenesisAnchorBody["routerInstanceId"],
) {
  return Effect.gen(function* () {
    const postIntent: PostIntent = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "post_intent",
      conversationId: membership.descriptor.conversationId,
      membershipHash: membership.hash,
      authorAgentId: author.card.agentId,
      postId: yield* mintPostId(),
      content: [{ type: "text", text: "certified before restart" }],
    };
    const action: GenesisActionCore = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "GENESIS",
      conversationId: membership.descriptor.conversationId,
      membership: membership.descriptor,
      anchor: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "genesis_anchor_body",
        conversationId: membership.descriptor.conversationId,
        membershipHash: membership.hash,
        routerInstanceId,
      },
      previousRecordHash: null,
      postIntent,
      postIntentHash: yield* hashPostIntent(postIntent),
    };
    return action;
  });
}

function signAction(identity: SigningIdentity, actionHash: ActionHash) {
  return signEvidence(identity, {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "action_signature",
    signerAgentId: identity.card.agentId,
    actionHash,
  });
}

function voteDurable(
  identity: SigningIdentity,
  membership: VerifiedMembership,
  recordHash: RecordHash,
) {
  return signEvidence(identity, {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "durability_vote",
    signerAgentId: identity.card.agentId,
    conversationId: membership.descriptor.conversationId,
    membershipHash: membership.hash,
    recordHash,
  });
}

function certifiedGenesis(parts: CertifiedGenesisParts): CertifiedRecord {
  return {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "certified_record",
    actionCertifiedRecord: {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certified_record",
      recordHash: parts.recordHash,
      recordCore: parts.recordCore,
      routerAnchor: parts.anchor,
      actionCertificate: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_certificate",
        actionHash: parts.recordCore.actionHash,
        signatures: parts.signatures,
      },
    },
    durabilityCertificate: {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "durability_certificate",
      recordHash: parts.recordHash,
      votes: parts.votes,
    },
  };
}

function lockGenesis(
  store: EndpointStore,
  membership: VerifiedMembership,
  record: CertifiedRecord,
) {
  return Effect.gen(function* () {
    const certified = record.actionCertifiedRecord;
    const conversationId = membership.descriptor.conversationId;
    if (certified.routerAnchor.kind !== "genesis_anchor_body") {
      return yield* Effect.dieMessage("expected a genesis-anchored record");
    }
    return yield* store.lockGenesisProposal(
      {
        conversationId,
        membershipHash: membership.hash,
        canonicalMembership: yield* encodeCanonical(
          MembershipDescriptor,
          membership.descriptor,
        ),
        anchorHash: certified.recordCore.anchorHash,
        canonicalAnchor: yield* encodeCanonical(
          GenesisAnchorBodySchema,
          certified.routerAnchor,
        ),
      },
      {
        conversationId,
        actionHash: certified.recordCore.actionHash,
        canonicalActionCore: yield* encodeCanonical(
          ActionCore,
          certified.recordCore.action,
        ),
      },
    );
  });
}

function storedRecordRow(record: CertifiedRecord) {
  return Effect.gen(function* () {
    const certified = record.actionCertifiedRecord;
    const staged = yield* stagedRecord(certified);
    const row: StoredCertifiedRecord = {
      ...staged,
      actionEvidence: yield* evidenceRows(
        staged.conversationId,
        "action",
        staged.actionHash,
        certified.actionCertificate.signatures,
      ),
      durabilityEvidence: yield* evidenceRows(
        staged.conversationId,
        "durability",
        staged.recordHash,
        record.durabilityCertificate.votes,
      ),
    };
    return row;
  });
}

function evidenceRows(
  conversationId: string,
  kind: ProtocolEvidence["kind"],
  subjectId: string,
  representations: readonly unknown[],
) {
  return Effect.forEach(
    representations,
    (representation) =>
      Schema.decodeUnknown(SignedMessage)(representation).pipe(
        Effect.flatMap((message) =>
          protocolEvidence(conversationId, kind, subjectId, message),
        ),
      ),
    { concurrency: 1 },
  );
}

function remotePost(
  local: VerifiedAgentCard,
  membership: VerifiedMembership,
  record: CertifiedRecord,
) {
  const certified = record.actionCertifiedRecord;
  if (certified.recordCore.action.postIntent.authorAgentId === local.agentId) {
    return Effect.dieMessage("expected a remote-authored record");
  }
  return inboundDelivery(
    {
      conversationId: membership.descriptor.conversationId,
      membership,
      currentAnchor: certified.routerAnchor,
    },
    record,
    local.agentId,
  );
}

function misattributeEvidence(
  evidence: ProtocolEvidence,
  signer: string,
  claimed: string,
): ProtocolEvidence {
  return evidence.kind === "action" && evidence.evidenceKey === signer
    ? { ...evidence, evidenceKey: claimed }
    : evidence;
}

function misattributeRecordEvidence(
  record: StoredCertifiedRecord,
  signer: string,
  claimed: string,
): StoredCertifiedRecord {
  return {
    ...record,
    actionEvidence: record.actionEvidence.map((evidence) =>
      misattributeEvidence(evidence, signer, claimed),
    ),
  };
}
