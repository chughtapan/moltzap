import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { agentsList, register } from "./agents/index.js";

const VALID_CARD = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "atlas-bot",
  status: "active",
};

const acceptsAgentCard = (value: unknown): boolean =>
  agentsList.validateResult({ agents: [value] });

describe("agent-name boundary", () => {
  it("registration and persisted agent records accept the same names", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        expect(register.validateParams({ name })).toBe(
          acceptsAgentCard({ ...VALID_CARD, name }),
        );
      }),
    );
  });
});

describe("AgentCardSchema acceptance", () => {
  it("accepts valid card with required fields only", () => {
    expect(acceptsAgentCard(VALID_CARD)).toBe(true);
  });

  it("accepts valid card with all optional fields", () => {
    expect(
      acceptsAgentCard({
        ...VALID_CARD,
        displayName: "Atlas Bot",
        description: "A helpful bot",
        ownerUserId: "660e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(true);
  });

  it("accepts short name (3 chars)", () => {
    expect(acceptsAgentCard({ ...VALID_CARD, name: "bot" })).toBe(true);
  });
});

describe("AgentCardSchema name bounds", () => {
  it("accepts long name (32 chars)", () => {
    expect(
      acceptsAgentCard({
        ...VALID_CARD,
        name: "a-very-long-agent-name-for-test",
      }),
    ).toBe(true);
  });

  it("rejects name too short (2 chars)", () => {
    expect(acceptsAgentCard({ ...VALID_CARD, name: "ab" })).toBe(false);
  });

  it("rejects name too long (33 chars)", () => {
    expect(
      acceptsAgentCard({
        ...VALID_CARD,
        name: "a-very-long-agent-name-for-testxx",
      }),
    ).toBe(false);
  });
});

describe("AgentCardSchema value rejection", () => {
  it("rejects uppercase name", () => {
    expect(acceptsAgentCard({ ...VALID_CARD, name: "Atlas" })).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(acceptsAgentCard({ ...VALID_CARD, status: "deleted" })).toBe(false);
  });

  it("rejects extra properties", () => {
    expect(acceptsAgentCard({ ...VALID_CARD, extra: true })).toBe(false);
  });
});

describe("AgentCardSchema required fields", () => {
  it("rejects missing status", () => {
    const noStatus = Object.fromEntries(
      Object.entries(VALID_CARD).filter(([key]) => key !== "status"),
    );
    expect(acceptsAgentCard(noStatus)).toBe(false);
  });

  it("rejects missing id", () => {
    const noId = Object.fromEntries(
      Object.entries(VALID_CARD).filter(([key]) => key !== "id"),
    );
    expect(acceptsAgentCard(noId)).toBe(false);
  });

  it("rejects missing name", () => {
    const noName = Object.fromEntries(
      Object.entries(VALID_CARD).filter(([key]) => key !== "name"),
    );
    expect(acceptsAgentCard(noName)).toBe(false);
  });
});
