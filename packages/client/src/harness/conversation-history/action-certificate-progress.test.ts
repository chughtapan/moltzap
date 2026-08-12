/**
 * @file Pins exact-member unanimity, fail-closed evidence merge, and immutable
 * complete snapshots for private OpenFloorV1 action certificates.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  actionCertificateDisposition,
  type ActionCertificateMerge,
  type ActionCertificateProgress,
  makeActionCertificateProgress,
  mergeVerifiedActionSignature,
} from "./action-certificate-progress.js";

interface OpaqueActionBodyHash {
  readonly fixture: string;
}

interface OpaqueSignatureEvidence {
  readonly fixture: string;
}

type Progress = ActionCertificateProgress<
  OpaqueActionBodyHash,
  OpaqueSignatureEvidence
>;
type Merge = ActionCertificateMerge<
  OpaqueActionBodyHash,
  OpaqueSignatureEvidence
>;

const ACTION_BODY_HASH = { fixture: "action-body:current" };
const OTHER_ACTION_BODY_HASH = { fixture: "action-body:other" };

const makeAgentId = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );

const membersFor = (memberCount: number): readonly AgentIdValue[] => {
  const members: AgentIdValue[] = [];
  for (let seed = 0; seed < memberCount; seed += 1) {
    members.push(makeAgentId(seed));
  }
  return members;
};

const evidenceFor = (
  signerAgentId: AgentIdValue,
  variant = "verified",
): OpaqueSignatureEvidence => ({
  fixture: `${signerAgentId}:${variant}`,
});

const validProgress = (memberAgentIds: ReadonlySet<AgentIdValue>): Progress =>
  Either.match(
    makeActionCertificateProgress<
      OpaqueActionBodyHash,
      OpaqueSignatureEvidence
    >({
      actionBodyHash: ACTION_BODY_HASH,
      memberAgentIds,
    }),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (progress) => progress,
    },
  );

const mergeSignature = (
  progress: Progress,
  signerAgentId: AgentIdValue,
  actionBodyHash: OpaqueActionBodyHash,
  evidence: OpaqueSignatureEvidence,
) =>
  mergeVerifiedActionSignature({
    progress,
    signature: { actionBodyHash, signerAgentId, evidence },
    sameActionBodyHash: (left, right) => left.fixture === right.fixture,
    sameSignatureEvidence: (left, right) =>
      left.fixture.toLowerCase() === right.fixture.toLowerCase(),
  });

const validMerge = (
  progress: Progress,
  signerAgentId: AgentIdValue,
  evidence: OpaqueSignatureEvidence,
): Merge =>
  Either.match(
    mergeSignature(progress, signerAgentId, ACTION_BODY_HASH, evidence),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (merge) => merge,
    },
  );

const failedMerge = (
  progress: Progress,
  signerAgentId: AgentIdValue,
  actionBodyHash: OpaqueActionBodyHash,
  evidence: OpaqueSignatureEvidence,
) =>
  Either.match(
    mergeSignature(progress, signerAgentId, actionBodyHash, evidence),
    {
      onLeft: (error) => error,
      onRight: () => {
        throw new Error("Expected action-signature merge to fail");
      },
    },
  );

const mergeEveryMember = (
  initial: Progress,
  members: readonly AgentIdValue[],
): Merge => {
  let progress = initial;
  let finalMerge: Merge | undefined;
  for (const signerAgentId of members) {
    finalMerge = validMerge(
      progress,
      signerAgentId,
      evidenceFor(signerAgentId),
    );
    progress = finalMerge.progress;
  }
  if (finalMerge === undefined) {
    throw new Error("Expected a nonempty member fixture");
  }
  return finalMerge;
};

describe("makeActionCertificateProgress membership", () => {
  it("rejects an empty fixed membership without consulting durability", () => {
    const result = makeActionCertificateProgress<
      OpaqueActionBodyHash,
      OpaqueSignatureEvidence
    >({
      actionBodyHash: ACTION_BODY_HASH,
      memberAgentIds: new Set(),
    });

    expect(
      Either.match(result, {
        onLeft: (error) => error,
        onRight: () => {
          throw new Error("Expected empty membership to fail");
        },
      }),
    ).toMatchObject({
      _tag: "EmptyActionCertificateMembershipError",
      memberCount: 0,
    });
  });

  it("captures an immutable membership snapshot without retaining the input", () => {
    const firstMember = makeAgentId(1);
    const secondMember = makeAgentId(2);
    const laterMember = makeAgentId(3);
    const input = new Set([firstMember, secondMember]);
    const progress = validProgress(input);

    input.delete(firstMember);
    input.add(laterMember);

    expect([...progress.memberAgentIds]).toEqual([firstMember, secondMember]);
    expect(progress.memberAgentIds).not.toBe(input);
    expect(Object.isFrozen(progress)).toBe(true);
    expect(Object.isFrozen(progress.memberAgentIds)).toBe(true);
    expect(Object.isFrozen(progress.signatureEvidenceBySigner)).toBe(true);
  });
});

// @agent-code-guard/regression-only: these cases pin body-before-signer refusal and nonmember state preservation.
describe("mergeVerifiedActionSignature binding refusal", () => {
  it("rejects another body before inspecting its signer", () => {
    const member = makeAgentId(1);
    const outsider = makeAgentId(250);
    const progress = validProgress(new Set([member]));

    expect(
      failedMerge(
        progress,
        outsider,
        OTHER_ACTION_BODY_HASH,
        evidenceFor(outsider),
      ),
    ).toMatchObject({
      _tag: "ActionCertificateBodyMismatchError",
      expectedActionBodyHash: ACTION_BODY_HASH,
      receivedActionBodyHash: OTHER_ACTION_BODY_HASH,
    });
    expect(progress.signatureEvidenceBySigner.size).toBe(0);
  });

  it("rejects a nonmember without changing collected evidence", () => {
    const member = makeAgentId(1);
    const outsider = makeAgentId(250);
    const progress = validMerge(
      validProgress(new Set([member, makeAgentId(2)])),
      member,
      evidenceFor(member),
    ).progress;
    const evidenceSnapshot = new Map(progress.signatureEvidenceBySigner);

    expect(
      failedMerge(progress, outsider, ACTION_BODY_HASH, evidenceFor(outsider)),
    ).toMatchObject({
      _tag: "NonMemberActionCertificateSignerError",
      signerAgentId: outsider,
    });
    expect([...progress.signatureEvidenceBySigner]).toEqual([
      ...evidenceSnapshot,
    ]);
  });
});

// @agent-code-guard/regression-only: these cases distinguish semantic duplicate evidence from a same-signer conflict.
describe("mergeVerifiedActionSignature retry handling", () => {
  it("makes caller-equal duplicate evidence harmless", () => {
    const firstMember = makeAgentId(1);
    const secondMember = makeAgentId(2);
    const acceptedEvidence = { fixture: "SIGNATURE:ONE" };
    const progress = validMerge(
      validProgress(new Set([firstMember, secondMember])),
      firstMember,
      acceptedEvidence,
    ).progress;
    const duplicate = validMerge(progress, firstMember, {
      fixture: "signature:one",
    });

    expect(duplicate).toEqual({
      progress,
      disposition: actionCertificateDisposition.duplicate,
      completion: null,
    });
    expect(duplicate.progress).toBe(progress);
  });

  it("rejects conflicting evidence from the same signer without mutation", () => {
    const firstMember = makeAgentId(1);
    const secondMember = makeAgentId(2);
    const acceptedEvidence = { fixture: "signature:accepted" };
    const receivedEvidence = { fixture: "signature:conflict" };
    const progress = validMerge(
      validProgress(new Set([firstMember, secondMember])),
      firstMember,
      acceptedEvidence,
    ).progress;
    const evidenceSnapshot = new Map(progress.signatureEvidenceBySigner);

    expect(
      failedMerge(progress, firstMember, ACTION_BODY_HASH, receivedEvidence),
    ).toMatchObject({
      _tag: "ConflictingActionSignatureEvidenceError",
      signerAgentId: firstMember,
      existingEvidence: acceptedEvidence,
      receivedEvidence,
    });
    expect([...progress.signatureEvidenceBySigner]).toEqual([
      ...evidenceSnapshot,
    ]);
  });
});

const arrivalOrders = fc.integer({ min: 1, max: 30 }).chain((memberCount) => {
  const seeds: number[] = [];
  for (let seed = 0; seed < memberCount; seed += 1) {
    seeds.push(seed);
  }
  const order = fc.shuffledSubarray(seeds, {
    minLength: memberCount,
    maxLength: memberCount,
  });
  return fc.tuple(order, order);
});

describe("action-certificate exact-member completion law", () => {
  it("completes only on the last exact member in every arrival order", () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(arrivalOrders, ([leftSeeds, rightSeeds]) => {
        const members = membersFor(leftSeeds.length);
        const initial = validProgress(new Set(members));
        const leftOrder = leftSeeds.map(makeAgentId);
        const rightOrder = rightSeeds.map(makeAgentId);
        const left = mergeEveryMember(initial, leftOrder);
        const right = mergeEveryMember(initial, rightOrder);

        expect(left.disposition).toBe(actionCertificateDisposition.completed);
        expect(right.disposition).toBe(actionCertificateDisposition.completed);
        const leftEvidence = left.completion?.signatureEvidenceBySigner;
        const rightEvidence = right.completion?.signatureEvidenceBySigner;
        if (leftEvidence === undefined || rightEvidence === undefined) {
          throw new Error("Expected exact-member completion evidence");
        }
        for (const member of members) {
          expect(leftEvidence.get(member)).toEqual(rightEvidence.get(member));
        }
        expect(left.completion?.signatureEvidenceBySigner.size).toBe(
          members.length,
        );
      }),
    );
  });

  it("remains incomplete after every strict fixed-member prefix", () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 30 }), (memberCount) => {
        const members = membersFor(memberCount);
        let progress = validProgress(new Set(members));

        for (const signerAgentId of members.slice(0, -1)) {
          const merge = validMerge(
            progress,
            signerAgentId,
            evidenceFor(signerAgentId),
          );
          expect(merge.disposition).toBe(
            actionCertificateDisposition.collecting,
          );
          expect(merge.completion).toBeNull();
          progress = merge.progress;
        }
      }),
    );
  });
});

// @agent-code-guard/regression-only: this case pins copy-on-write progress and the separate complete evidence envelope.
// @agent-code-guard/regression-only: this case pins independent evidence snapshots at completion.
describe("action-certificate completion snapshot", () => {
  it("freezes independent progress and complete evidence maps", () => {
    const [firstMember, secondMember] = membersFor(2);
    if (firstMember === undefined || secondMember === undefined) {
      throw new Error("Expected two member fixtures");
    }
    const initial = validProgress(new Set([firstMember, secondMember]));
    const first = validMerge(initial, firstMember, evidenceFor(firstMember));
    const completed = validMerge(
      first.progress,
      secondMember,
      evidenceFor(secondMember),
    );
    const completion = completed.completion;
    if (completion === null) {
      throw new Error("Expected exact-member completion");
    }

    expect(initial.signatureEvidenceBySigner.size).toBe(0);
    expect(first.progress.signatureEvidenceBySigner).not.toBe(
      initial.signatureEvidenceBySigner,
    );
    expect(completed.progress.signatureEvidenceBySigner).not.toBe(
      first.progress.signatureEvidenceBySigner,
    );
    expect(completion.signatureEvidenceBySigner).not.toBe(
      completed.progress.signatureEvidenceBySigner,
    );
    expect(Object.isFrozen(completed.progress)).toBe(true);
    expect(Object.isFrozen(completed.progress.signatureEvidenceBySigner)).toBe(
      true,
    );
    expect(Object.isFrozen(completion)).toBe(true);
    expect(Object.isFrozen(completion.signatureEvidenceBySigner)).toBe(true);
  });
});

const expectNoMutator = (view: object, name: string): void => {
  expect(Reflect.get(view, name)).toBeUndefined();
};

// @agent-code-guard/regression-only: casted views must not regain native Map or Set mutation methods.
describe("action-certificate collection mutation boundary", () => {
  it("exposes closure-backed views without collection mutators", () => {
    const member = makeAgentId(1);
    const initial = validProgress(new Set([member]));
    const completed = validMerge(initial, member, evidenceFor(member));
    const completion = completed.completion;
    if (completion === null) {
      throw new Error("Expected exact-member completion");
    }

    for (const name of ["add", "delete", "clear"]) {
      expectNoMutator(initial.memberAgentIds, name);
    }
    for (const evidenceView of [
      completed.progress.signatureEvidenceBySigner,
      completion.signatureEvidenceBySigner,
    ]) {
      for (const name of ["set", "delete", "clear"]) {
        expectNoMutator(evidenceView, name);
      }
    }
    expect([...initial.memberAgentIds]).toEqual([member]);
    expect([...completed.progress.signatureEvidenceBySigner]).toEqual([
      [member, evidenceFor(member)],
    ]);
    expect([...completion.signatureEvidenceBySigner]).toEqual([
      [member, evidenceFor(member)],
    ]);
  });
});
