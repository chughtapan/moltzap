/** @file Small boundary tests for the private addressed Client representation. */

import { AgentId, MOLTZAP_VERSION } from "@moltzap/identity";
import canonicalize from "canonicalize";
import { Effect, Encoding, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ActionHash,
  ActionSignatureStatement,
  CatchUpRequest,
  ClientRepresentationError,
  Content,
  ConversationId,
  decodeCanonical,
  decodeOuterBody,
  deriveConversationId,
  deriveEvidenceMessageId,
  encodeCanonical,
  maximumContentBytes,
  MembershipHash,
  mintPostId,
  quorumThreshold,
} from "./representation.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Exact wire fixtures keep the representation and its rejection assertion together. */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const identifier = (prefix: string, byteLength: number, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(byteLength).fill(byte))}`;

const firstAgentId = Schema.decodeUnknownSync(AgentId)(
  identifier("agt_", 16, 1),
);
const secondAgentId = Schema.decodeUnknownSync(AgentId)(
  identifier("agt_", 16, 2),
);
const conversationId = Schema.decodeUnknownSync(ConversationId)(
  identifier("cnv_", 32, 3),
);
const membershipHash = Schema.decodeUnknownSync(MembershipHash)(
  identifier("mbr_", 32, 4),
);

const canonicalInputBytes = (value: unknown): Uint8Array => {
  const text = Schema.decodeUnknownSync(Schema.String)(canonicalize(value));
  return utf8Encoder.encode(text);
};

const catchUpRequest = Schema.decodeUnknownSync(CatchUpRequest)({
  moltzapVersion: MOLTZAP_VERSION,
  kind: "catch_up_request",
  conversationId,
  membershipHash,
  requesterAgentId: firstAgentId,
  knownRecordHash: null,
  knownAnchorHash: null,
});

const expectRepresentationFailure = <Value>(
  effect: Effect.Effect<Value, ClientRepresentationError>,
) =>
  Effect.flip(effect).pipe(
    Effect.tap((failure) => {
      expect(failure).toBeInstanceOf(ClientRepresentationError);
      return Effect.void;
    }),
    Effect.asVoid,
  );

const verifiesCanonicalClosure = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bytes = yield* encodeCanonical(CatchUpRequest, catchUpRequest);
      expect(yield* decodeCanonical(CatchUpRequest, bytes)).toEqual(
        catchUpRequest,
      );

      const nonCanonical = utf8Encoder.encode(` ${utf8Decoder.decode(bytes)}`);
      yield* expectRepresentationFailure(
        decodeCanonical(CatchUpRequest, nonCanonical),
      );
      yield* expectRepresentationFailure(
        decodeCanonical(
          CatchUpRequest,
          canonicalInputBytes({ ...catchUpRequest, unexpected: true }),
        ),
      );
    }),
  );

const derivesPrivateIdentifiers = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const memberAgentIds = [firstAgentId, secondAgentId] as const;
      const firstConversationId = yield* deriveConversationId(memberAgentIds);
      const secondConversationId = yield* deriveConversationId(memberAgentIds);
      expect(firstConversationId).toBe(secondConversationId);
      yield* expectRepresentationFailure(
        deriveConversationId([secondAgentId, firstAgentId] as const),
      );

      const firstPostId = yield* mintPostId();
      const secondPostId = yield* mintPostId();
      expect(secondPostId).not.toBe(firstPostId);
    }),
  );

const enforcesContentBounds = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const empty = [{ type: "text", text: "" }] as const;
      const fixedBytes = yield* encodeCanonical(Content, empty);
      const maximumText = "x".repeat(
        maximumContentBytes - fixedBytes.byteLength,
      );
      const maximumContent = [{ type: "text", text: maximumText }] as const;
      expect(yield* encodeCanonical(Content, maximumContent)).toHaveLength(
        maximumContentBytes,
      );
      yield* expectRepresentationFailure(
        encodeCanonical(Content, [{ type: "text", text: `${maximumText}x` }]),
      );
    }),
  );

const derivesStableEvidenceIdentity = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const statement = Schema.decodeUnknownSync(ActionSignatureStatement)({
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_signature",
        signerAgentId: firstAgentId,
        actionHash: Schema.decodeUnknownSync(ActionHash)(
          identifier("ach_", 32, 5),
        ),
      });
      const first = yield* deriveEvidenceMessageId(statement);
      const retry = yield* deriveEvidenceMessageId(statement);
      expect(retry).toBe(first);
    }),
  );

const classifiesOnlyClosedOuterBodies = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bytes = yield* encodeCanonical(CatchUpRequest, catchUpRequest);
      expect(yield* decodeOuterBody(bytes)).toMatchObject({
        kind: "direct",
        packet: catchUpRequest,
      });
      yield* expectRepresentationFailure(
        decodeOuterBody(utf8Encoder.encode("{}")),
      );
    }),
  );

// @agent-code-guard/regression-only: these examples pin the accepted private Client wire boundary and hostile-input closure.
describe("Client protocol representation", () => {
  it(
    "accepts exact JCS and rejects alternate or open representations",
    verifiesCanonicalClosure,
  );
  it(
    "derives stable conversation and author-scoped post identities",
    derivesPrivateIdentifiers,
  );
  it("enforces the exact canonical content byte bound", enforcesContentBounds);
  it(
    "derives a stable inner evidence message identity",
    derivesStableEvidenceIdentity,
  );
  it(
    "classifies only complete exact outer bodies",
    classifiesOnlyClosedOuterBodies,
  );
  it("uses the admitted N2, N3, N4, and N10 quorum table", () => {
    expect(quorumThreshold(2)).toBe(2);
    expect(quorumThreshold(3)).toBe(3);
    expect(quorumThreshold(4)).toBe(3);
    expect(quorumThreshold(10)).toBe(7);
  });
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
