/**
 * @file Pins fail-closed single-candidate staging for one Router re-anchor
 * signing domain before any honest endpoint vote can be produced.
 */

import { Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type ConflictingReanchorCandidateError,
  reanchorCandidateDisposition,
  type ReanchorCandidateStage,
  type ReanchorSigningDomain,
  type ReanchorSlotDomainMismatchError,
  type StagedReanchorCandidate,
  stageVerifiedReanchorCandidate,
} from "./reanchor-candidate-slot.js";

type Domain = ReanchorSigningDomain<string, number, string, string>;
type Candidate = StagedReanchorCandidate<Domain, string>;

const DOMAIN: Domain = {
  conversation: "conversation-a",
  membershipEpoch: 1,
  precedingAnchorHash: "anchor-previous",
  routerInstance: "router-current",
};

const sameDomain = (left: Domain, right: Domain): boolean =>
  left.conversation === right.conversation &&
  left.membershipEpoch === right.membershipEpoch &&
  left.precedingAnchorHash === right.precedingAnchorHash &&
  left.routerInstance === right.routerInstance;

const transitionEmpty = (received: Candidate) =>
  stageVerifiedReanchorCandidate({
    received,
    sameDomain,
    sameBodyHash: (left, right) => left === right,
  });

const transitionExisting = (staged: Candidate, received: Candidate) =>
  stageVerifiedReanchorCandidate({
    staged,
    received,
    sameDomain,
    sameBodyHash: (left, right) => left === right,
  });

type CandidateTransition = ReturnType<typeof transitionExisting>;

const successfulTransition = (
  transition: CandidateTransition,
): ReanchorCandidateStage<Domain, string> =>
  Either.match(transition, {
    onLeft: (error) => {
      throw error;
    },
    onRight: (stage) => stage,
  });

const failedTransition = (
  staged: Candidate,
  received: Candidate,
):
  | ConflictingReanchorCandidateError<string>
  | ReanchorSlotDomainMismatchError<Domain> =>
  Either.match(transitionExisting(staged, received), {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected candidate staging to fail");
    },
  });

describe("stageVerifiedReanchorCandidate idempotent staging", () => {
  it("returns a fresh snapshot for durable staging into an empty slot", () => {
    const received = { domain: DOMAIN, bodyHash: "body-a" };
    const stage = successfulTransition(transitionEmpty(received));

    expect(stage).toEqual({
      candidate: received,
      disposition: reanchorCandidateDisposition.staged,
    });
    expect(stage.candidate).not.toBe(received);
    expect(Object.isFrozen(stage.candidate)).toBe(true);
  });

  it("makes an identical retry harmless without replacing durable state", () => {
    const staged = { domain: DOMAIN, bodyHash: "body-a" };
    const received = { domain: { ...DOMAIN }, bodyHash: "body-a" };
    const stage = successfulTransition(transitionExisting(staged, received));

    expect(stage).toEqual({
      candidate: staged,
      disposition: reanchorCandidateDisposition.duplicate,
    });
    expect(stage.candidate).toBe(staged);
  });
});

describe("stageVerifiedReanchorCandidate conflicting body", () => {
  it("rejects a conflicting body in the same signing domain", () => {
    const staged = { domain: DOMAIN, bodyHash: "body-a" };
    const received = { domain: { ...DOMAIN }, bodyHash: "body-b" };

    expect(failedTransition(staged, received)).toMatchObject({
      _tag: "ConflictingReanchorCandidateError",
      stagedBodyHash: "body-a",
      receivedBodyHash: "body-b",
    });
  });

  it("rejects every distinct body hash in the same signing domain", () => {
    fc.assert(
      fc.property(fc.string(), (bodyHash) => {
        const conflictingBodyHash = `${bodyHash}x`;
        const staged = { domain: DOMAIN, bodyHash };
        const received = {
          domain: { ...DOMAIN },
          bodyHash: conflictingBodyHash,
        };

        expect(failedTransition(staged, received)).toMatchObject({
          _tag: "ConflictingReanchorCandidateError",
          stagedBodyHash: bodyHash,
          receivedBodyHash: conflictingBodyHash,
        });
      }),
    );
  });
});

describe("stageVerifiedReanchorCandidate domain key", () => {
  it.each([
    { conversation: "conversation-b" },
    { membershipEpoch: 2 },
    { precedingAnchorHash: "anchor-other" },
    { routerInstance: "router-other" },
  ])("rejects a slot keyed by another domain: %o", (domainChange) => {
    const staged = { domain: DOMAIN, bodyHash: "body-a" };
    const received = {
      domain: { ...DOMAIN, ...domainChange },
      bodyHash: "body-a",
    };

    expect(failedTransition(staged, received)).toMatchObject({
      _tag: "ReanchorSlotDomainMismatchError",
      expectedDomain: DOMAIN,
      receivedDomain: received.domain,
    });
  });
});
