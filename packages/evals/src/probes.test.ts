import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@moltzap/protocol/identity";
import { agentId } from "@moltzap/protocol/testing";
import { AgentProcessExited } from "@moltzap/simulator";
import { Schema } from "effect";
import {
  SharedProbeRuntimeTerminated,
  hasFinalApprovalReceipt,
  sharedConversationProbePrompt,
} from "./probes.js";

describe("shared conversation probe prompt", () => {
  it("does not disclose either exact answer to the participant society", () => {
    const prompt = sharedConversationProbePrompt();

    assert.notInclude(prompt, "PROPOSAL:12");
    assert.notInclude(prompt, "FINAL:12");
    assert.include(prompt, "PROPOSAL:");
    assert.include(prompt, "FINAL:");
    assert.include(prompt, "calculate 7 + 5");
  });

  it("binds the final response to the exact witness receipt", () => {
    assert.isTrue(
      hasFinalApprovalReceipt("FINAL:12:RECEIPT:123456789", "123456789"),
    );
    assert.isFalse(
      hasFinalApprovalReceipt("FINAL:12:RECEIPT:987654321", "123456789"),
    );
    assert.isFalse(hasFinalApprovalReceipt("FINAL:12", "123456789"));
  });
});

it("retains the simulator event that stops probe policy", () => {
  const observation = AgentProcessExited.make({
    agentName: Schema.decodeSync(AgentName)("nanoclaw-proposer"),
    agentId: agentId("00000000-0000-4000-8000-000000000101"),
    runtime: "nanoclaw",
    code: 1,
  });
  const failure = SharedProbeRuntimeTerminated.make({ observation });

  assert.strictEqual(failure.observation, observation);
  assert.instanceOf(failure.observation, AgentProcessExited);
});
