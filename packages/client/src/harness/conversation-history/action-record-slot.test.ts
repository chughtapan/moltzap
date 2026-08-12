/**
 * @file Pins head-bound, single-child durable staging before an honest member
 * may sign one action-certified record.
 */

import { Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CertifiedHistoryHead } from "./certified-head-advance.js";
import {
  type ActionRecordSigningDomain,
  actionRecordSlotDisposition,
  type ActionRecordSlotStage,
  type StagedActionRecordCandidate,
  stageVerifiedActionRecord,
} from "./action-record-slot.js";

type Domain = ActionRecordSigningDomain<string, number, string>;
type Candidate = StagedActionRecordCandidate<string, number, string, string>;

const domain = (
  currentCertifiedRecordHash: string | null,
  overrides: Partial<Domain> = {},
): Domain => ({
  conversation: "conversation-a",
  membershipEpoch: 7,
  currentCertifiedRecordHash,
  ...overrides,
});

const candidate = (
  recordHash: string,
  previousRecordHash: string | null,
): Candidate => ({
  domain: {
    conversation: "conversation-a",
    membershipEpoch: 7,
    currentCertifiedRecordHash: previousRecordHash,
  },
  stagedRecord: {
    recordHash,
    previousRecordHash,
    record: `complete:${recordHash}`,
  },
});

const candidateInDomain = (
  recordHash: string,
  previousRecordHash: string | null,
  candidateDomain: Domain,
): Candidate => ({
  domain: candidateDomain,
  stagedRecord: {
    recordHash,
    previousRecordHash,
    record: `complete:${recordHash}`,
  },
});

const sameOptionalHash = (
  left: string | null,
  right: string | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.toLowerCase() === right.toLowerCase();

const sameDomain = (left: Domain, right: Domain): boolean =>
  left.conversation === right.conversation &&
  left.membershipEpoch === right.membershipEpoch &&
  sameOptionalHash(
    left.currentCertifiedRecordHash,
    right.currentCertifiedRecordHash,
  );

const transition = (input: {
  readonly currentHead: CertifiedHistoryHead<string>;
  readonly existing?: Candidate;
  readonly received: Candidate;
}) =>
  stageVerifiedActionRecord({
    ...input,
    sameDomain,
    sameRecordHash: (left, right) => left.toLowerCase() === right.toLowerCase(),
  });

const successfulTransition = (
  result: ReturnType<typeof transition>,
): ActionRecordSlotStage<string, number, string, string> =>
  Either.match(result, {
    onLeft: (error) => {
      throw error;
    },
    onRight: (stage) => stage,
  });

const failedTransition = (result: ReturnType<typeof transition>) =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected action-record staging to fail");
    },
  });

describe("stageVerifiedActionRecord head extension", () => {
  it("stages a genesis candidate against the null history anchor", () => {
    const received = candidate("record:genesis", null);
    const stage = successfulTransition(
      transition({ currentHead: { _tag: "empty" }, received }),
    );

    expect(stage).toEqual({
      candidate: received,
      disposition: actionRecordSlotDisposition.staged,
    });
  });

  it("stages a descendant against the current certified head", () => {
    const received = candidate("record:child", "record:parent");
    const stage = successfulTransition(
      transition({
        currentHead: { _tag: "certified", recordHash: "record:parent" },
        received,
      }),
    );

    expect(stage.disposition).toBe(actionRecordSlotDisposition.staged);
    expect(stage.candidate.stagedRecord.recordHash).toBe(
      received.stagedRecord.recordHash,
    );
  });
});

// @agent-code-guard/regression-only: these cases distinguish genesis, stale-parent, and stale-domain refusals.
describe("stageVerifiedActionRecord predecessor refusal", () => {
  it.each([
    {
      currentHead: { _tag: "empty" } as const,
      received: candidate("record:child", "record:parent"),
      expectedPreviousRecordHash: null,
      receivedPreviousRecordHash: "record:parent",
    },
    {
      currentHead: {
        _tag: "certified" as const,
        recordHash: "record:parent",
      },
      received: candidate("record:child", null),
      expectedPreviousRecordHash: "record:parent",
      receivedPreviousRecordHash: null,
    },
    {
      currentHead: {
        _tag: "certified" as const,
        recordHash: "record:parent",
      },
      received: candidate("record:child", "record:stale"),
      expectedPreviousRecordHash: "record:parent",
      receivedPreviousRecordHash: "record:stale",
    },
  ])(
    "rejects predecessor $receivedPreviousRecordHash",
    ({ currentHead, received, ...expected }) => {
      expect(
        failedTransition(transition({ currentHead, received })),
      ).toMatchObject({
        _tag: "ActionRecordPredecessorMismatchError",
        ...expected,
      });
    },
  );
});

// @agent-code-guard/regression-only: this case pins the domain's certified-head binding separately from the record predecessor.
describe("stageVerifiedActionRecord domain-head refusal", () => {
  it("rejects a stale signing-domain head even when the record extends", () => {
    const received = candidateInDomain(
      "record:child",
      "record:parent",
      domain("record:stale"),
    );

    expect(
      failedTransition(
        transition({
          currentHead: { _tag: "certified", recordHash: "record:parent" },
          received,
        }),
      ),
    ).toMatchObject({
      _tag: "ActionRecordPredecessorMismatchError",
      expectedPreviousRecordHash: "record:parent",
      receivedDomainRecordHash: "record:stale",
      receivedPreviousRecordHash: "record:parent",
    });
  });
});

// @agent-code-guard/regression-only: both domain components select a different durable slot.
describe("stageVerifiedActionRecord slot key", () => {
  it.each([{ conversation: "conversation-b" }, { membershipEpoch: 8 }])(
    "rejects an existing slot from another domain: %o",
    (domainChange) => {
      const existing = candidateInDomain(
        "record:child",
        "record:parent",
        domain("record:parent", domainChange),
      );
      const received = candidate("record:child", "record:parent");

      expect(
        failedTransition(
          transition({
            currentHead: { _tag: "certified", recordHash: "record:parent" },
            existing,
            received,
          }),
        ),
      ).toMatchObject({
        _tag: "ActionRecordSlotDomainMismatchError",
        expectedDomain: received.domain,
        storedDomain: existing.domain,
      });
    },
  );
});

describe("stageVerifiedActionRecord single-child law", () => {
  it("rejects every distinct child hash within one signing domain", () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(fc.string(), (recordHash) => {
        const conflictingRecordHash = `${recordHash}x`;
        const existing = candidate(recordHash, null);
        const received = candidate(conflictingRecordHash, null);

        expect(
          failedTransition(
            transition({
              currentHead: { _tag: "empty" },
              existing,
              received,
            }),
          ),
        ).toMatchObject({
          _tag: "ConflictingActionRecordChildError",
          stagedRecordHash: recordHash,
          receivedRecordHash: conflictingRecordHash,
        });
      }),
    );
  });

  it("uses caller hash semantics to recognize a harmless duplicate", () => {
    const existing = candidateInDomain(
      "RECORD:CHILD",
      "HEAD:PARENT",
      domain("HEAD:PARENT"),
    );
    const received = candidate("record:child", "head:parent");
    const stage = successfulTransition(
      transition({
        currentHead: { _tag: "certified", recordHash: "head:parent" },
        existing,
        received,
      }),
    );

    expect(stage).toEqual({
      candidate: existing,
      disposition: actionRecordSlotDisposition.duplicate,
    });
    expect(stage.candidate).toBe(existing);
  });
});

// @agent-code-guard/regression-only: mutation checks pin each copied envelope surrounding the opaque record.
describe("stageVerifiedActionRecord immutable staging snapshot", () => {
  it("does not retain mutable candidate-envelope state", () => {
    const received = {
      domain: {
        conversation: "conversation-a",
        membershipEpoch: 7,
        currentCertifiedRecordHash: "record:parent",
      },
      stagedRecord: {
        recordHash: "record:child",
        previousRecordHash: "record:parent",
        record: "complete:record:child",
      },
    };
    const stage = successfulTransition(
      transition({
        currentHead: { _tag: "certified", recordHash: "record:parent" },
        received,
      }),
    );

    received.domain.conversation = "mutated:conversation";
    received.stagedRecord.recordHash = "mutated:hash";
    received.stagedRecord.previousRecordHash = "mutated:predecessor";
    received.stagedRecord.record = "mutated:record";

    expect(stage.candidate).toEqual(candidate("record:child", "record:parent"));
    expect(Object.isFrozen(stage.candidate)).toBe(true);
    expect(Object.isFrozen(stage.candidate.domain)).toBe(true);
    expect(Object.isFrozen(stage.candidate.stagedRecord)).toBe(true);
  });
});
