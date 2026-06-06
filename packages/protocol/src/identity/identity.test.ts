import { describe, expect, it } from "vitest";
import { validateAgent, validateAgentCard } from "./agents/index.js";

const VALID_AGENT = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "atlas-bot",
  status: "active",
  createdAt: "2026-03-14T12:00:00.000Z",
};

const VALID_CARD = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "atlas-bot",
  status: "active",
};

describe("AgentSchema acceptance", () => {
  it("accepts valid agent", () => {
    expect(validateAgent(VALID_AGENT)).toBe(true);
  });
});

describe("AgentSchema rejection", () => {
  it("rejects invalid agent name (uppercase)", () => {
    expect(validateAgent({ ...VALID_AGENT, name: "Atlas" })).toBe(false);
  });

  it("rejects agent name too short", () => {
    expect(validateAgent({ ...VALID_AGENT, name: "ab" })).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(validateAgent({ ...VALID_AGENT, status: "deleted" })).toBe(false);
  });
});

describe("AgentCardSchema acceptance", () => {
  it("accepts valid card with required fields only", () => {
    expect(validateAgentCard(VALID_CARD)).toBe(true);
  });

  it("accepts valid card with all optional fields", () => {
    expect(
      validateAgentCard({
        ...VALID_CARD,
        displayName: "Atlas Bot",
        description: "A helpful bot",
        ownerUserId: "660e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(true);
  });

  it("accepts short name (3 chars)", () => {
    expect(validateAgentCard({ ...VALID_CARD, name: "bot" })).toBe(true);
  });
});

describe("AgentCardSchema name bounds", () => {
  it("accepts long name (32 chars)", () => {
    expect(
      validateAgentCard({
        ...VALID_CARD,
        name: "a-very-long-agent-name-for-test",
      }),
    ).toBe(true);
  });

  it("rejects name too short (2 chars)", () => {
    expect(validateAgentCard({ ...VALID_CARD, name: "ab" })).toBe(false);
  });

  it("rejects name too long (33 chars)", () => {
    expect(
      validateAgentCard({
        ...VALID_CARD,
        name: "a-very-long-agent-name-for-testxx",
      }),
    ).toBe(false);
  });
});

describe("AgentCardSchema value rejection", () => {
  it("rejects uppercase name", () => {
    expect(validateAgentCard({ ...VALID_CARD, name: "Atlas" })).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(validateAgentCard({ ...VALID_CARD, status: "deleted" })).toBe(false);
  });

  it("rejects extra properties", () => {
    expect(validateAgentCard({ ...VALID_CARD, extra: true })).toBe(false);
  });
});

describe("AgentCardSchema required fields", () => {
  it("rejects missing status", () => {
    const noStatus = Object.fromEntries(
      Object.entries(VALID_CARD).filter(([key]) => key !== "status"),
    );
    expect(validateAgentCard(noStatus)).toBe(false);
  });

  it("rejects missing id", () => {
    const noId = Object.fromEntries(
      Object.entries(VALID_CARD).filter(([key]) => key !== "id"),
    );
    expect(validateAgentCard(noId)).toBe(false);
  });

  it("rejects missing name", () => {
    const noName = Object.fromEntries(
      Object.entries(VALID_CARD).filter(([key]) => key !== "name"),
    );
    expect(validateAgentCard(noName)).toBe(false);
  });
});
