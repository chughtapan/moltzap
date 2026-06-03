import { describe, expect, it } from "vitest";
import { agentId, userId } from "../testing/index.js";
import { type AuthenticatedIdentity } from "./actor-model.js";

const AGENT_UUID = "00000000-0000-4000-8000-000000000001";
const APP_UUID = "00000000-0000-4000-8000-000000000002";

describe("AuthenticatedIdentity shape", () => {
  it("constructs an AuthenticatedIdentity", () => {
    const identity: AuthenticatedIdentity = {
      agentId: agentId(AGENT_UUID),
      userId: userId(APP_UUID),
    };
    expect(identity.agentId).toBe(AGENT_UUID);
    expect(identity.userId).toBe(APP_UUID);
  });
});
