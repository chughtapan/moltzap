/** @file Golden and hostile-boundary tests for the private Client representation. */

import {
  AgentSigningAuthority,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  SignedMessage,
} from "@moltzap/identity";
import canonicalize from "canonicalize";
import { Effect, Encoding, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ConversationId } from "../contract.js";
import {
  CatchUpRequest,
  ClientRepresentationError,
  Content,
  decodeCanonical,
  decodeOuterBody,
  deriveEvidenceMessageId,
  DurabilityVoteStatement,
  encodeCanonical,
  hashContent,
  Membership,
  RecordHash,
  signEvidenceMessage,
  verifyMembership,
  verifyStableEvidence,
} from "./representation.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/no-hardcoded-assertion-literals -- These focused cryptographic fixtures keep each exact representation and its rejection assertion together. */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const conversationId = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000001",
);
const registryKeyRepresentation = {
  crv: "Ed25519",
  kty: "OKP",
  x: "y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0",
} as const;
const firstPrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHsbmQdBGQFs1eXLEWxKDblLeG//B9s8WmWEMQHvw4f8
-----END PRIVATE KEY-----`;

const firstCardRepresentation = {
  payload:
    "eyJhZ2VudElkIjoiYWd0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVEiLCJhZ2VudE5hbWUiOiJhZ2VudC1vbmUiLCJpc3N1ZWRBdCI6IjIwMjYtMDgtMTNUMDA6MDA6MDFaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi43MjkuMSIsInByaW5jaXBhbElkIjoicHJuX0N3c0xDd3NMQ3dzTEN3c0xDd3NMQ3ciLCJwdWJsaWNLZXkiOnsiY3J2IjoiRWQyNTUxOSIsImt0eSI6Ik9LUCIsIngiOiIzclVKOTJ0SVAwREU0ZWttRVQxem1lNlNJV1RwNUcwS2lGM1pqTC1Bb0tnIn19",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6c2RFN0NFOENLYVFvMDlSYzdYUEVXbVVNN3puOS00RmxZRzR5QlFhODQtNCIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
      signature:
        "7gbf_w3RQVDaiX99yl3XrPAlVUweI_3R8P89ZRqOAB1P6KMP8fK71Ey3QHxEwmo_qnoVnZLVBuZomdnlOFRZAw",
    },
  ],
};

const secondCardRepresentation = {
  payload:
    "eyJhZ2VudElkIjoiYWd0X0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWciLCJhZ2VudE5hbWUiOiJhZ2VudC10d28iLCJpc3N1ZWRBdCI6IjIwMjYtMDgtMTNUMDA6MDA6MDJaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi43MjkuMSIsInByaW5jaXBhbElkIjoicHJuX0RBd01EQXdNREF3TURBd01EQXdNREEiLCJwdWJsaWNLZXkiOnsiY3J2IjoiRWQyNTUxOSIsImt0eSI6Ik9LUCIsIngiOiJwZ1liNXhZbW9UVXVKWTRHbktLQnltRnVGSGJuZXRLRG55Vm1uYkZBTU9zIn19",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6c2RFN0NFOENLYVFvMDlSYzdYUEVXbVVNN3puOS00RmxZRzR5QlFhODQtNCIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
      signature:
        "srmWhPubdYbD4O2t85NncbzdJcLKkiaKYd3ZZtSees0mGJh_AJblHAJiFpFeNmoxBsoJEWRLnwAZ6S6npQkUBg",
    },
  ],
};

const canonicalInputBytes = (value: unknown): Uint8Array => {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new Error("fixture is not representable as canonical JSON");
  }
  return utf8Encoder.encode(text);
};

const makeFixture = Effect.gen(function* () {
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeyRepresentation,
  );
  const membership = yield* Schema.decodeUnknown(Membership)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "membership",
    conversationId,
    membershipEpoch: 0,
    members: [firstCardRepresentation, secondCardRepresentation],
  });
  const verifiedMembership = yield* verifyMembership(
    membership,
    registrySignerPublicKey,
  );
  const signingAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(firstPrivateKey),
  );
  return { registrySignerPublicKey, verifiedMembership, signingAuthority };
});

const makesCatchUpRequest = Effect.gen(function* () {
  const fixture = yield* makeFixture;
  return {
    fixture,
    request: yield* Schema.decodeUnknown(CatchUpRequest)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "catch_up_request",
      conversationId,
      membershipHash: fixture.verifiedMembership.hash,
      requesterAgentId: fixture.verifiedMembership.members[0].agentId,
      knownRecordHash: null,
      knownAnchorHash: null,
    }),
  };
});

const verifiesCanonicalClosure = async () => {
  const { request } = await Effect.runPromise(makesCatchUpRequest);
  const bytes = await Effect.runPromise(
    encodeCanonical(CatchUpRequest, request),
  );
  const decoded = await Effect.runPromise(
    decodeCanonical(CatchUpRequest, bytes),
  );
  expect(decoded).toEqual(request);

  const nonCanonical = utf8Encoder.encode(` ${utf8Decoder.decode(bytes)}`);
  const nonCanonicalError = await Effect.runPromise(
    Effect.flip(decodeCanonical(CatchUpRequest, nonCanonical)),
  );
  expect(nonCanonicalError).toBeInstanceOf(ClientRepresentationError);
  const excessError = await Effect.runPromise(
    Effect.flip(
      decodeCanonical(
        CatchUpRequest,
        canonicalInputBytes({ ...request, unexpected: true }),
      ),
    ),
  );
  expect(excessError).toBeInstanceOf(ClientRepresentationError);
};

const rejectsMixedNullPosition = async () => {
  const { request } = await Effect.runPromise(makesCatchUpRequest);
  const knownRecordHash = Schema.decodeUnknownSync(RecordHash)(
    `rch_${Encoding.encodeBase64Url(new Uint8Array(32).fill(7))}`,
  );
  const error = await Effect.runPromise(
    Effect.flip(
      decodeCanonical(
        CatchUpRequest,
        canonicalInputBytes({ ...request, knownRecordHash }),
      ),
    ),
  );
  expect(error).toBeInstanceOf(ClientRepresentationError);
};

const enforcesContentBounds = async () => {
  const empty = [{ type: "text", text: "" }] as const;
  const fixedBytes = await Effect.runPromise(encodeCanonical(Content, empty));
  const maximumText = "x".repeat(32_768 - fixedBytes.byteLength);
  const maximumContent = [{ type: "text", text: maximumText }] as const;
  const maximumBytes = await Effect.runPromise(
    encodeCanonical(Content, maximumContent),
  );
  expect(maximumBytes).toHaveLength(32_768);
  const error = await Effect.runPromise(
    Effect.flip(hashContent([{ type: "text", text: `${maximumText}x` }])),
  );
  expect(error).toBeInstanceOf(ClientRepresentationError);
};

const signsDeterministicStableEvidence = async () => {
  const { fixture } = await Effect.runPromise(makesCatchUpRequest);
  const recordHash = Schema.decodeUnknownSync(RecordHash)(
    `rch_${Encoding.encodeBase64Url(new Uint8Array(32).fill(9))}`,
  );
  const statement = Schema.decodeUnknownSync(DurabilityVoteStatement)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "durability_vote",
    signerAgentId: fixture.verifiedMembership.members[0].agentId,
    conversationId,
    membershipHash: fixture.verifiedMembership.hash,
    recordHash,
  });
  const expectedId = await Effect.runPromise(
    deriveEvidenceMessageId(statement),
  );
  const signed = await Effect.runPromise(
    signEvidenceMessage({
      statement,
      agentCard: fixture.verifiedMembership.members[0],
      signingAuthority: fixture.signingAuthority,
    }),
  );
  const representation = await Effect.runPromise(
    Schema.encode(SignedMessage)(signed),
  );
  const verified = await Effect.runPromise(
    verifyStableEvidence({
      representation,
      membership: fixture.verifiedMembership,
    }),
  );
  expect(signed.messageId).toBe(expectedId);
  expect(verified.statement).toEqual(statement);
};

const classifiesOnlyExactOuterBodies = async () => {
  const { request } = await Effect.runPromise(makesCatchUpRequest);
  const bytes = await Effect.runPromise(
    encodeCanonical(CatchUpRequest, request),
  );
  const decoded = await Effect.runPromise(decodeOuterBody(bytes));
  expect(decoded.kind).toBe("direct");
  const error = await Effect.runPromise(
    Effect.flip(decodeOuterBody(utf8Encoder.encode("{}"))),
  );
  expect(error).toBeInstanceOf(ClientRepresentationError);
};

const rejectsUnsortedMembership = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const reversed = Schema.decodeUnknownSync(Membership)({
    ...fixture.verifiedMembership.membership,
    members: [secondCardRepresentation, firstCardRepresentation],
  });
  const error = await Effect.runPromise(
    Effect.flip(verifyMembership(reversed, fixture.registrySignerPublicKey)),
  );
  expect(error).toBeInstanceOf(ClientRepresentationError);
};

const enforcesMembershipBounds = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const oversized = {
    ...fixture.verifiedMembership.membership,
    members: Array.from({ length: 33 }, () => firstCardRepresentation),
  };
  const error = await Effect.runPromise(
    Effect.flip(Schema.decodeUnknown(Membership)(oversized)),
  );
  expect(error).toBeDefined();
};

// @agent-code-guard/regression-only: these examples pin the accepted private Client wire boundary and its hostile-input closure.
describe("Client protocol representation", () => {
  it(
    "accepts exact JCS and rejects alternate or open representations",
    verifiesCanonicalClosure,
  );
  it(
    "requires catch-up record and anchor positions to be jointly null",
    rejectsMixedNullPosition,
  );
  it("enforces the exact canonical content byte bound", enforcesContentBounds);
  it(
    "signs and verifies deterministic self-addressed evidence",
    signsDeterministicStableEvidence,
  );
  it(
    "classifies only complete exact outer bodies",
    classifiesOnlyExactOuterBodies,
  );
  it(
    "rejects membership not sorted by decoded AgentId",
    rejectsUnsortedMembership,
  );
  it(
    "enforces the closed membership cardinality bound",
    enforcesMembershipBounds,
  );
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
