/** @file Multi-endpoint certification, failure, quorum, and replay tests. */

import type { SignedMessage } from "@moltzap/identity";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { EndpointRecovery } from "./store.js";
import {
  makeScriptedEngineHarness,
  type ScriptedEngineHarness,
  scriptedMessageKind,
} from "../__tests__/endpoint-engine-multi.fixture.js";
import {
  CertifiedRecord,
  decodeCanonical,
  decodeOuterBody,
  durabilityThreshold,
  makeActionBinding,
  signEvidenceMessage,
  signOuterEvidence,
  verifyStartProposal,
} from "./representation.js";

/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function -- Each scripted trace keeps the delivery phases beside their durable assertions. */

interface ClassifiedMessage {
  readonly kind: string;
  readonly message: SignedMessage;
}

const indexes = (length: number): readonly number[] =>
  Array.from({ length }, (_, index) => index);

const classify = (
  messages: readonly SignedMessage[],
): Effect.Effect<readonly ClassifiedMessage[]> =>
  Effect.forEach(
    messages,
    (message) =>
      scriptedMessageKind(message).pipe(
        Effect.map((kind) => ({ kind, message })),
      ),
    { concurrency: 1 },
  );

const messagesOfKind = (
  classified: readonly ClassifiedMessage[],
  kind: string,
): readonly SignedMessage[] =>
  classified
    .filter((candidate) => candidate.kind === kind)
    .map(({ message }) => message);

const recoverAll = (
  harness: ScriptedEngineHarness,
): Effect.Effect<readonly EndpointRecovery[]> =>
  Effect.forEach(
    harness.stores,
    (store) => store.recover().pipe(Effect.orDie),
    {
      concurrency: 1,
    },
  );

const makeConflictingActionEvidence = (
  harness: ScriptedEngineHarness,
  proposalMessage: SignedMessage,
): Effect.Effect<SignedMessage> =>
  Effect.gen(function* () {
    const payload = yield* decodeOuterBody(proposalMessage.body).pipe(
      Effect.orDie,
    );
    if (payload.kind !== "direct" || payload.packet.kind !== "start_proposal") {
      return yield* Effect.die("missing scripted START proposal");
    }
    const signer = harness.identities[1];
    const input = harness.inputs[1];
    if (signer === undefined || input === undefined) {
      return yield* Effect.die("missing scripted Byzantine signer");
    }
    const conflictingAction = {
      ...payload.packet.action,
      content: [{ type: "text", text: "conflicting-action" }] as const,
    };
    const evidence = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: conflictingAction.moltzapVersion,
        kind: "action_signature",
        signerAgentId: signer.card.agentId,
        action: yield* makeActionBinding(conflictingAction).pipe(Effect.orDie),
      },
      agentCard: signer.card,
      signingAuthority: signer.authority,
    }).pipe(Effect.orDie);
    const membership = yield* verifyStartProposal({
      proposal: payload.packet,
      registrySignerPublicKey: input.registrySignerPublicKey,
    }).pipe(Effect.orDie);
    return yield* signOuterEvidence({
      evidence,
      membership,
      agentCard: signer.card,
      signingAuthority: signer.authority,
    }).pipe(Effect.orDie);
  });

const assertCertifiedStart = (
  recovery: EndpointRecovery,
  memberCount: number,
) =>
  Effect.gen(function* () {
    expect(recovery.stagedRecords).toHaveLength(1);
    expect(recovery.certifiedRecords).toHaveLength(1);
    expect(
      recovery.evidence.filter(({ kind }) => kind === "action"),
    ).toHaveLength(memberCount);
    expect(
      recovery.evidence.filter(({ kind }) => kind === "durability"),
    ).toHaveLength(memberCount);
    const stored = recovery.certifiedRecords[0];
    if (stored === undefined) {
      return yield* Effect.die("missing scripted certified record");
    }
    const certified = yield* decodeCanonical(
      CertifiedRecord,
      stored.canonicalCertifiedRecord,
    ).pipe(Effect.orDie);
    expect(
      certified.actionCertifiedRecord.actionCertificate.signatures,
    ).toHaveLength(memberCount);
    expect(certified.durabilityVotes).toHaveLength(
      durabilityThreshold(memberCount),
    );
  });

const certifiesAtMembershipSize = (memberCount: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeScriptedEngineHarness(memberCount);
        const startFiber = yield* Effect.fork(
          harness.engines[0]?.start(
            harness.startInput(0, `membership-${memberCount}`),
          ) ?? Effect.die("missing scripted author"),
        );
        yield* harness.waitForOutbound;
        yield* harness.pump();
        yield* Fiber.join(startFiber);

        const recoveries = yield* recoverAll(harness);
        yield* Effect.forEach(
          recoveries,
          (recovery) => assertCertifiedStart(recovery, memberCount),
          { concurrency: 1, discard: true },
        );
      }),
    ),
  );

const completesAfterTheAuthorStops = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const memberCount = 7;
        const harness = yield* makeScriptedEngineHarness(memberCount);
        const author = harness.engines[0];
        if (author === undefined) {
          return yield* Effect.die("missing scripted author");
        }
        const startFiber = yield* Effect.fork(
          author.start(harness.startInput(0, "author-stops")),
        );
        yield* harness.waitForOutbound;

        const proposal = harness.takeOutbound();
        expect(yield* classify(proposal)).toMatchObject([
          { kind: "start_proposal" },
        ]);
        yield* harness.deliver(proposal);
        yield* harness.drain();

        const signatures = harness.takeOutbound();
        expect(
          messagesOfKind(yield* classify(signatures), "action_signature"),
        ).toHaveLength(memberCount);
        yield* harness.deliver(signatures);
        yield* harness.drain();

        const certifiedActionAndVotes = harness.takeOutbound();
        const ready = yield* classify(certifiedActionAndVotes);
        expect(messagesOfKind(ready, "action_certified_record")).toHaveLength(
          memberCount,
        );
        expect(messagesOfKind(ready, "durability_vote")).toHaveLength(
          memberCount,
        );

        const survivors = indexes(memberCount).slice(1);
        yield* harness.deliver(certifiedActionAndVotes, {
          endpointIndexes: survivors,
        });
        yield* harness.drain(survivors);
        yield* harness.pump({ endpointIndexes: survivors });

        const recoveries = yield* recoverAll(harness);
        expect(recoveries[0]?.stagedRecords).toHaveLength(1);
        expect(recoveries[0]?.certifiedRecords).toHaveLength(0);
        expect(
          recoveries[0]?.evidence.filter(({ kind }) => kind === "action"),
        ).toHaveLength(memberCount);
        expect(
          recoveries[0]?.evidence.filter(({ kind }) => kind === "durability"),
        ).toHaveLength(0);
        for (const recovery of recoveries.slice(1)) {
          yield* assertCertifiedStart(recovery, memberCount);
        }
        yield* Fiber.interrupt(startFiber);
      }),
    ),
  );

const separatesEvidenceAndDeduplicatesDelivery = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const memberCount = 4;
        const harness = yield* makeScriptedEngineHarness(memberCount);
        const author = harness.engines[0];
        if (author === undefined) {
          return yield* Effect.die("missing scripted author");
        }
        const startFiber = yield* Effect.fork(
          author.start(harness.startInput(0, "evidence-kinds")),
        );
        yield* harness.waitForOutbound;

        const proposal = harness.takeOutbound();
        yield* harness.deliver(proposal, { copies: 2 });
        yield* harness.drain();

        const signatures = harness.takeOutbound();
        expect(
          messagesOfKind(yield* classify(signatures), "action_signature"),
        ).toHaveLength(memberCount);
        const proposalMessage = proposal[0];
        if (proposalMessage === undefined) {
          return yield* Effect.die("missing scripted proposal");
        }
        const conflicting = yield* makeConflictingActionEvidence(
          harness,
          proposalMessage,
        );
        yield* harness.deliver([conflicting], { copies: 3 });
        const beforeHonestEvidence = yield* recoverAll(harness);
        expect(
          beforeHonestEvidence.every(
            ({ evidence }) =>
              evidence.filter(({ kind }) => kind === "action").length === 0,
          ),
        ).toBe(true);
        yield* harness.deliver(signatures, { copies: 3 });
        yield* harness.drain();

        const ready = yield* classify(harness.takeOutbound());
        const actionRecords = messagesOfKind(ready, "action_certified_record");
        const durabilityVotes = messagesOfKind(ready, "durability_vote");
        expect(actionRecords).toHaveLength(memberCount);
        expect(durabilityVotes).toHaveLength(memberCount);

        yield* harness.deliver(actionRecords, { copies: 2 });
        yield* harness.deliver(signatures, { copies: 2 });
        let recoveries = yield* recoverAll(harness);
        for (const recovery of recoveries) {
          expect(recovery.certifiedRecords).toHaveLength(0);
          expect(
            recovery.evidence.filter(({ kind }) => kind === "action"),
          ).toHaveLength(memberCount);
          expect(
            recovery.evidence.filter(({ kind }) => kind === "durability"),
          ).toHaveLength(0);
        }

        const threshold = durabilityThreshold(memberCount);
        yield* harness.deliver(durabilityVotes.slice(0, threshold - 1), {
          copies: 3,
        });
        recoveries = yield* recoverAll(harness);
        expect(
          recoveries.every(
            ({ certifiedRecords }) => certifiedRecords.length === 0,
          ),
        ).toBe(true);

        yield* harness.deliver(
          durabilityVotes.slice(threshold - 1, threshold),
          { copies: 3 },
        );
        yield* harness.drain();
        yield* harness.deliver(durabilityVotes, { copies: 3 });
        yield* harness.pump({ copies: 2 });
        yield* Fiber.join(startFiber);

        recoveries = yield* recoverAll(harness);
        for (const recovery of recoveries) {
          yield* assertCertifiedStart(recovery, memberCount);
        }
      }),
    ),
  );

describe("private multi-endpoint engine", () => {
  for (const memberCount of [3, 4, 7]) {
    it(
      `certifies START across ${memberCount} real engines`,
      () => certifiesAtMembershipSize(memberCount),
      10_000,
    );
  }

  it(
    "lets non-authors complete from an emitted certificate and quorum after the author stops",
    completesAfterTheAuthorStops,
    10_000,
  );
  it(
    "ignores a signed conflicting action, separates durability, and folds replay idempotently",
    separatesEvidenceAndDeduplicatesDelivery,
  );
});

/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function -- Restore repository defaults. */
