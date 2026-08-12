import { describe, expect, it } from "vitest";

import { identityRpcMethods } from "#identity";
import { AuthenticatedAgent } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { InvalidParamsError } from "#transport";
import { agentsSearch } from "./agents.js";

const AGENT_CARD = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "atlas-bot",
  status: "active",
};

describe("agent/identity/agents/search", () => {
  it("accepts the closed query and cursor contract", () => {
    expect(agentsSearch.validateParams({})).toBe(true);
    expect(agentsSearch.validateParams({ query: "" })).toBe(true);
    expect(
      agentsSearch.validateParams({ query: "atlas", cursor: "next-page" }),
    ).toBe(true);
    expect(agentsSearch.validateParams({ limit: 10 })).toBe(false);
    expect(agentsSearch.validateParams({ count: 10 })).toBe(false);
  });

  it("validates the paginated AgentCard result", () => {
    expect(
      agentsSearch.validateResult({
        agents: [AGENT_CARD],
        nextCursor: "next-page",
      }),
    ).toBe(true);
    expect(agentsSearch.validateResult({ agents: [AGENT_CARD] })).toBe(true);
    expect(agentsSearch.validateResult({ agents: [] })).toBe(true);
    expect(agentsSearch.validateResult({ items: [AGENT_CARD] })).toBe(false);
  });

  it("declares its authority, errors, and identity catalog membership", () => {
    expect(agentsSearch.requires).toEqual([AuthenticatedAgent, ActiveAgent]);
    expect(agentsSearch.errors).toEqual([InvalidParamsError]);
    expect(identityRpcMethods).toContain(agentsSearch);
  });
});
