/** @file Address resolution against verified immutable Registry cards. */

import type { RegistryLookupResult } from "@moltzap/identity/registry";
import {
  AgentCard,
  AgentId,
  AgentName,
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
  PrincipalId,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import canonicalize from "canonicalize";
import { Effect, Encoding, Redacted, Schema } from "effect";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { maximumMembers, MessageAddressInput } from "../wire/values.js";
import {
  type AddressRegistryPort,
  type ResolvedMessageAddress,
  resolveMessageAddress,
} from "./address.js";

interface AddressFixture {
  readonly cards: readonly [
    VerifiedAgentCard,
    VerifiedAgentCard,
    VerifiedAgentCard,
  ];
  readonly registry: AddressRegistryPort;
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const makeAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

const issueCard = (input: {
  readonly byte: number;
  readonly name: string;
  readonly authority: AgentSigningAuthorityValue;
  readonly registryPrivateKey: KeyObject;
  readonly registrySignerPublicKey: typeof Ed25519PublicKey.Type;
}): Effect.Effect<VerifiedAgentCard> =>
  Effect.gen(function* () {
    const thumbprint = createHash("sha256")
      .update(canonicalize(input.registrySignerPublicKey) ?? "")
      .digest("base64url");
    const protectedText = canonicalize({
      alg: "Ed25519",
      kid: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${thumbprint}`,
      typ: "application/vnd.moltzap.agent-card+jws",
    });
    const payloadText = canonicalize({
      agentId: Schema.decodeUnknownSync(AgentId)(
        identifier("agt_", input.byte),
      ),
      agentName: Schema.decodeUnknownSync(AgentName)(input.name),
      issuedAt: "2026-08-27T12:00:00Z",
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", input.byte),
      ),
      publicKey: AgentSigningAuthority.publicKey(input.authority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.dieMessage("canonical card fixture failed");
    }
    const protectedValue = Buffer.from(protectedText).toString("base64url");
    const payload = Buffer.from(payloadText).toString("base64url");
    const signature = signBytes(
      null,
      Buffer.from(`${protectedValue}.${payload}`),
      input.registryPrivateKey,
    ).toString("base64url");
    const card = yield* Schema.decodeUnknown(AgentCard)({
      payload,
      signatures: [{ protected: protectedValue, signature }],
    });
    return yield* AgentCard.verify({
      agentCard: card,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
  }).pipe(Effect.orDie);

const makeFixture = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const authority = yield* makeAuthority();
  const local = yield* issueCard({
    byte: 1,
    name: "agent-1",
    authority,
    registryPrivateKey: registryKeys.privateKey,
    registrySignerPublicKey,
  });
  const second = yield* issueCard({
    byte: 10,
    name: "agent-10",
    authority,
    registryPrivateKey: registryKeys.privateKey,
    registrySignerPublicKey,
  });
  const third = yield* issueCard({
    byte: 2,
    name: "agent-2",
    authority,
    registryPrivateKey: registryKeys.privateKey,
    registrySignerPublicKey,
  });
  const cards = [local, second, third] as const;
  const lookup = (
    request: Parameters<AddressRegistryPort["lookup"]>[0],
  ): RegistryLookupResult => {
    const found = cards.find((card) =>
      "agentName" in request
        ? card.agentName === request.agentName
        : card.agentId === request.agentId,
    );
    return found === undefined
      ? { kind: "not_found" }
      : { kind: "found", agentCard: found };
  };
  const fixture: AddressFixture = {
    cards,
    registry: {
      lookup: (request) => Effect.succeed(lookup(request)),
    },
  };
  return fixture;
}).pipe(Effect.orDie);

const decodeInput = (value: string) =>
  Schema.decodeUnknownSync(MessageAddressInput)(value);

const memberNames = (resolved: ResolvedMessageAddress) =>
  resolved.memberCards.map((card) => card.agentName);

const thirtyTwoRemoteNames = Array.from(
  Array(32).keys(),
  (index) => `remote-${String(index).padStart(2, "0")}`,
).join(",");

// @agent-code-guard/regression-only: Resolution pins canonical runtime and private membership projections.
describe("resolved address state", () => {
  it("resolves a direct peer into deterministic private membership", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const inputAddress = "agent:agent-2";
        const expectedKind = "direct";
        const expectedNames = ["agent-1", "agent-2"];
        const resolved = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput(inputAddress),
        });

        expect(resolved.kind).toBe(expectedKind);
        expect(resolved.address).toBe(inputAddress);
        expect(memberNames(resolved)).toEqual(expectedNames);
      }),
    ));

  it("inserts self and renders complete groups in unsigned ASCII order", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const inputAddress = "group:agent-2,agent-10";
        const expectedKind = "group";
        const expectedAddress = "group:agent-1,agent-10,agent-2";
        const expectedNames = ["agent-1", "agent-2", "agent-10"];
        const resolved = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput(inputAddress),
        });

        expect(resolved.kind).toBe(expectedKind);
        expect(resolved.address).toBe(expectedAddress);
        expect(memberNames(resolved)).toEqual(expectedNames);
      }),
    ));
});

const membershipInvalid = "membership-invalid";
const unknownAgent = "unknown-agent";

// @agent-code-guard/regression-only: Resolution pins closed membership and lookup failures.
describe("invalid address membership", () => {
  it("refuses a direct address to self", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;

        const error = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput("agent:agent-1"),
        }).pipe(Effect.flip);

        expect(error.reason).toBe(membershipInvalid);
        expect(error.detail).toBeDefined();
      }),
    ));

  it("refuses a group naming an agent twice", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;

        const error = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput("group:agent-10,agent-10"),
        }).pipe(Effect.flip);

        expect(error.reason).toBe(membershipInvalid);
        expect(error.detail).toBeDefined();
      }),
    ));

  it("refuses an unknown agent and names it in the message", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const address = "agent:unknown-agent";

        const error = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput(address),
        }).pipe(Effect.flip);

        expect(error.reason).toBe(unknownAgent);
        expect(error.message).toContain(address);
      }),
    ));
});

// @agent-code-guard/regression-only: Resolution pins the direct address a one-other-agent group names.
describe("group naming one other agent", () => {
  it("resolves to that agent's direct conversation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const direct = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput("agent:agent-2"),
        });

        const resolved = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput("group:agent-2"),
        });

        expect(resolved).toEqual(direct);
      }),
    ));

  it("resolves to that agent's direct conversation when self is listed too", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const direct = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput("agent:agent-2"),
        });

        const resolved = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput("group:agent-1,agent-2"),
        });

        expect(resolved).toEqual(direct);
      }),
    ));
});

// @agent-code-guard/regression-only: Resolution pins the accepted group-size boundary.
describe("group size", () => {
  it("refuses a group naming only self", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;

        const error = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput("group:agent-1"),
        }).pipe(Effect.flip);

        expect(error.reason).toBe(membershipInvalid);
      }),
    ));

  it("refuses a group over the member limit and states the limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;

        const error = yield* resolveMessageAddress({
          localAgentCard: fixture.cards[0],
          registry: fixture.registry,
          to: decodeInput(`group:${thirtyTwoRemoteNames}`),
        }).pipe(Effect.flip);

        expect(error.reason).toBe(membershipInvalid);
        expect(error.message).toContain(String(maximumMembers));
      }),
    ));
});
