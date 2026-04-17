import { describe, expect, it } from "vitest";
import { validators } from "./validators.js";

describe("validators", () => {
  it("has a validator for every RPC method", () => {
    expect(validators.registerParams).toBeDefined();
    expect(validators.connectParams).toBeDefined();
    expect(validators.messagesSendParams).toBeDefined();
    expect(validators.contactsAddParams).toBeDefined();
    expect(validators.conversationsCreateParams).toBeDefined();
    expect(validators.invitesCreateAgentParams).toBeDefined();
    expect(validators.presenceUpdateParams).toBeDefined();
    expect(validators.agentsListParams).toBeDefined();
    expect(validators.agentsLookupParams).toBeDefined();
    expect(validators.agentsLookupByNameParams).toBeDefined();
  });

  it("validates agentsListParams correctly", () => {
    expect(validators.agentsListParams({})).toBe(true);
    expect(validators.agentsListParams({ extra: true })).toBe(false);
  });

  it("validates registerParams correctly", () => {
    expect(validators.registerParams({ name: "my-agent" })).toBe(true);
    expect(validators.registerParams({ name: "AB" })).toBe(false); // uppercase
    expect(validators.registerParams({})).toBe(false); // missing name
  });

  it("validates messagesSendParams correctly", () => {
    expect(
      validators.messagesSendParams({
        to: "agent:nova",
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toBe(true);

    expect(validators.messagesSendParams({ parts: [] })).toBe(false); // empty parts
  });
});
