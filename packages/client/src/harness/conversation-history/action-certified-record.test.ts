/**
 * @file Pins body binding, exact fixed membership, canonical evidence order,
 * and mutation-resistant snapshots for private action-certified records.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CompleteEvidence } from "./evidence.js";
import {
  type ActionCertifiedRecord,
  planActionCertifiedRecord,
} from "./action-certified-record.js";

interface OpaqueActionBodyHash {
  readonly fixture: string;
}

interface OpaqueSignatureEvidence {
  readonly fixture: string;
}

const RECORD_BODY = { fixture: "record:current" };
const MEMBERSHIP_DESCRIPTOR = { fixture: "membership:current" };
const ROUTER_ANCHOR_HASH = { fixture: "router-anchor:current" };
const ACTION_BODY_HASH = { fixture: "action-body:current" };
const OTHER_ACTION_BODY_HASH = { fixture: "action-body:other" };

const makeAgentId = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );

const FIRST_MEMBER = makeAgentId(1);
const SECOND_MEMBER = makeAgentId(2);
const THIRD_MEMBER = makeAgentId(3);
const MEMBERS = Object.freeze([FIRST_MEMBER, SECOND_MEMBER, THIRD_MEMBER]);
const OUTSIDER = makeAgentId(250);

const evidenceFor = (signerAgentId: AgentIdValue): OpaqueSignatureEvidence => ({
  fixture: `verified:${signerAgentId}`,
});

const certificateFor = (
  signerAgentIds: readonly AgentIdValue[],
  actionBodyHash = ACTION_BODY_HASH,
): CompleteEvidence<OpaqueActionBodyHash, OpaqueSignatureEvidence> => ({
  subject: actionBodyHash,
  memberAgentIds: Object.freeze([...MEMBERS]),
  requiredSigners: MEMBERS.length,
  evidenceBySigner: signerAgentIds.map((signerAgentId) => ({
    signerAgentId,
    evidence: evidenceFor(signerAgentId),
  })),
});

const transition = (
  memberAgentIds: readonly AgentIdValue[],
  actionCertificate: CompleteEvidence<
    OpaqueActionBodyHash,
    OpaqueSignatureEvidence
  >,
) =>
  planActionCertifiedRecord({
    recordBody: RECORD_BODY,
    actionBodyHash: ACTION_BODY_HASH,
    fixedMembership: {
      memberAgentIds,
      verificationDescriptor: MEMBERSHIP_DESCRIPTOR,
    },
    routerAnchorHash: ROUTER_ANCHOR_HASH,
    actionCertificate,
    sameActionBodyHash: (left, right) => left.fixture === right.fixture,
  });

type PlannedRecord = ActionCertifiedRecord<
  typeof RECORD_BODY,
  typeof MEMBERSHIP_DESCRIPTOR,
  typeof ROUTER_ANCHOR_HASH,
  OpaqueActionBodyHash,
  OpaqueSignatureEvidence
>;

const successfulTransition = (
  result: ReturnType<typeof transition>,
): PlannedRecord =>
  Either.match(result, {
    onLeft: (error) => {
      throw error;
    },
    onRight: (record) => record,
  });

const failedTransition = (result: ReturnType<typeof transition>) =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected action-certified record planning to fail");
    },
  });

const certificateSignerIds = (record: PlannedRecord): AgentIdValue[] =>
  record.actionCertificate.evidenceBySigner.map((item) => item.signerAgentId);

describe("planActionCertifiedRecord closed bindings", () => {
  it("rejects another body before duplicate or signer-set inspection", () => {
    const duplicateMembership = [FIRST_MEMBER, FIRST_MEMBER];
    const certificate = certificateFor([], OTHER_ACTION_BODY_HASH);

    expect(
      failedTransition(transition(duplicateMembership, certificate)),
    ).toMatchObject({
      _tag: "ActionCertifiedBodyMismatchError",
      expectedActionBodyHash: ACTION_BODY_HASH,
      certificateActionBodyHash: OTHER_ACTION_BODY_HASH,
    });
  });

  it("rejects duplicate members in the canonical descriptor", () => {
    const duplicateMembership = [...MEMBERS, FIRST_MEMBER];

    expect(
      failedTransition(
        transition(duplicateMembership, certificateFor(MEMBERS)),
      ),
    ).toMatchObject({
      _tag: "DuplicateFixedMemberError",
      duplicateAgentId: FIRST_MEMBER,
    });
  });

  it("reports missing and extra certificate signers together", () => {
    const certificate = certificateFor([FIRST_MEMBER, SECOND_MEMBER, OUTSIDER]);

    expect(failedTransition(transition(MEMBERS, certificate))).toMatchObject({
      _tag: "ActionCertificateSignerSetMismatchError",
      missingSignerAgentIds: [THIRD_MEMBER],
      extraSignerAgentIds: [OUTSIDER],
    });
  });
});

describe("planActionCertifiedRecord canonical snapshot", () => {
  it("orders evidence by the descriptor for every signer permutation", () => {
    expect.hasAssertions();
    const signerOrders = fc.shuffledSubarray([...MEMBERS], {
      minLength: MEMBERS.length,
      maxLength: MEMBERS.length,
    });

    fc.assert(
      fc.property(signerOrders, (signerOrder) => {
        const record = successfulTransition(
          transition(MEMBERS, certificateFor(signerOrder)),
        );

        expect(record.fixedMembership.memberAgentIds).toEqual(MEMBERS);
        expect(certificateSignerIds(record)).toEqual(MEMBERS);
        expect(record.recordBody).toBe(RECORD_BODY);
        expect(record.routerAnchorHash).toBe(ROUTER_ANCHOR_HASH);
      }),
    );
  });
});

describe("planActionCertifiedRecord mutation boundary", () => {
  it("detaches frozen collection envelopes from mutable inputs", () => {
    const memberAgentIds = [...MEMBERS];
    const evidenceBySigner = MEMBERS.map((signerAgentId) => ({
      signerAgentId,
      evidence: evidenceFor(signerAgentId),
    }));
    const certificate = {
      subject: ACTION_BODY_HASH,
      memberAgentIds: [...MEMBERS],
      requiredSigners: MEMBERS.length,
      evidenceBySigner,
    };
    const record = successfulTransition(
      transition(memberAgentIds, certificate),
    );

    memberAgentIds.reverse();
    evidenceBySigner.length = 0;

    expect(record.fixedMembership.memberAgentIds).toEqual(MEMBERS);
    expect([
      ...record.actionCertificate.evidenceBySigner.map(
        (item) => item.signerAgentId,
      ),
    ]).toEqual(MEMBERS);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.fixedMembership)).toBe(true);
    expect(Object.isFrozen(record.fixedMembership.memberAgentIds)).toBe(true);
    expect(Object.isFrozen(record.actionCertificate)).toBe(true);
    expect(Object.isFrozen(record.actionCertificate.evidenceBySigner)).toBe(
      true,
    );
    expect(
      Reflect.set(record.fixedMembership.memberAgentIds, "0", OUTSIDER),
    ).toBe(false);
    for (const mutator of ["set", "delete", "clear"]) {
      expect(
        Reflect.get(record.actionCertificate.evidenceBySigner, mutator),
      ).toBeUndefined();
    }
  });
});
