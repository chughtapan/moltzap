/** @file Public addressed-message schema behavior. */

import { Either, Encoding, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentAddress,
  Content,
  GroupAddress,
  MessageAddressInput,
  PostId,
  SendInput,
} from "./contract.js";

const canonicalGroup32 = `group:${Array.from(
  Array(32).keys(),
  (index) => `member-${String(index).padStart(2, "0")}`,
).join(",")}`;

const canonicalGroup33 = `group:${Array.from(
  Array(33).keys(),
  (index) => `member-${String(index).padStart(2, "0")}`,
).join(",")}`;

const decodingFails = (
  schema: Schema.Schema.AnyNoContext,
  value: unknown,
): boolean =>
  Either.match(Schema.decodeUnknownEither(schema)(value), {
    onLeft: () => true,
    onRight: () => false,
  });

// @agent-code-guard/regression-only: Address schemas pin the accepted public runtime grammar.
describe("public address schemas", () => {
  it("accepts exact agent addresses and arbitrary group input order", () => {
    const direct = "agent:alice-agent";
    const unorderedGroup = "group:carol-agent,bob-agent";

    expect(Schema.decodeUnknownSync(AgentAddress)(direct)).toBe(direct);
    expect(Schema.decodeUnknownSync(MessageAddressInput)(unorderedGroup)).toBe(
      unorderedGroup,
    );
  });

  it("accepts canonical 3-member and 32-member groups", () => {
    const threeMembers = "group:alice-agent,bob-agent,carol-agent";

    expect(Schema.decodeUnknownSync(GroupAddress)(threeMembers)).toBe(
      threeMembers,
    );
    expect(Schema.decodeUnknownSync(GroupAddress)(canonicalGroup32)).toBe(
      canonicalGroup32,
    );
  });

  it("rejects noncanonical, 2-member, and 33-member group outputs", () => {
    expect(
      decodingFails(GroupAddress, "group:carol-agent,alice-agent,bob-agent"),
    ).toBe(true);
    expect(decodingFails(GroupAddress, "group:alice-agent,bob-agent")).toBe(
      true,
    );
    expect(decodingFails(GroupAddress, canonicalGroup33)).toBe(true);
  });
});

// @agent-code-guard/regression-only: Identifier schemas pin the closed durable send grammar.
describe("public post identifiers", () => {
  it("accepts the exact post identifier grammar", () => {
    const postId = `pst_${Encoding.encodeBase64Url(
      new Uint8Array(32).fill(7),
    )}`;

    expect(Schema.decodeUnknownSync(PostId)(postId)).toBe(postId);
  });
});

// @agent-code-guard/regression-only: Content schemas pin the exact semantic boundary and canonical byte cap.
describe("public content", () => {
  it("accepts exact nonempty semantic content", () => {
    const content = [
      { type: "text", text: "Meet at 10?" },
      { type: "data", value: { available: true, hour: 10 } },
    ];

    expect(Schema.decodeUnknownSync(Content)(content)).toEqual(content);
  });

  it("accepts content at the exact canonical byte cap", () => {
    const text = "a".repeat(32_741);
    const content = [{ type: "text", text }];

    expect(Schema.decodeUnknownSync(Content)(content)).toEqual(content);
  });

  it("rejects empty, non-JSON, ill-formed, oversized, and open content", () => {
    expect(decodingFails(Content, [])).toBe(true);
    expect(decodingFails(Content, [{ type: "data", value: Number.NaN }])).toBe(
      true,
    );
    expect(decodingFails(Content, [{ type: "text", text: "\ud800" }])).toBe(
      true,
    );
    expect(
      decodingFails(Content, [{ type: "text", text: "a".repeat(32_742) }]),
    ).toBe(true);
    expect(
      decodingFails(Content, [{ type: "text", text: "hello", extra: true }]),
    ).toBe(true);
  });
});

// @agent-code-guard/regression-only: SendInput remains a closed two-field boundary with no host retry identity.
describe("public send input", () => {
  it("decodes only the exact send input fields", () => {
    const input = {
      to: "agent:bob-agent",
      content: [{ type: "text", text: "Hello" }],
    };

    expect(Schema.decodeUnknownSync(SendInput)(input)).toEqual(input);
    expect(decodingFails(SendInput, { ...input, inherited: true })).toBe(true);
    expect(
      decodingFails(SendInput, { ...input, idempotencyKey: "outbox-43" }),
    ).toBe(true);
  });
});
