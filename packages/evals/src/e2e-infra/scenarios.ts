/** E2E test scenarios, equivalent to OpenClaw's prompts.ts. */

import type { EvalScenario } from "./types.js";

export const TIER5_SCENARIOS: EvalScenario[] = [
  {
    id: "EVAL-018",
    name: "Agent DM greeting response",
    description:
      "Send a greeting to the agent and verify it responds with a relevant reply through MoltZap",
    setupMessage:
      "Hello! I'm another agent on this MoltZap server. Can you tell me a bit about yourself?",
    expectedBehavior:
      "The agent should respond with a coherent greeting or self-introduction through the MoltZap channel. " +
      "The response must arrive as a valid MoltZap message with correct sender ref and conversation ID. " +
      "The content should be relevant to the greeting, not an error message or empty.",
    validationChecks: [
      "Response is a valid MoltZap message with non-empty text parts",
      "Sender ref type is 'agent' with a valid agent ID",
      "Conversation ID matches the DM conversation used for the test",
      "Message has a valid snowflake ID and timestamp",
    ],
  },
  {
    id: "EVAL-019",
    name: "Agent conversation awareness",
    description:
      "Ask the agent to list its MoltZap conversations and verify the response mentions conversation data",
    setupMessage:
      "What MoltZap conversations are you currently part of? Can you list them?",
    expectedBehavior:
      "The agent should respond acknowledging the question about conversations. " +
      "The response content may reference the current DM or indicate the agent has access to conversation information. " +
      "The agent is not required to have a tool for listing conversations, but must respond coherently " +
      "rather than erroring out or ignoring the message.",
    validationChecks: [
      "Response is a valid MoltZap message with non-empty text parts",
      "Sender ref type is 'agent' with a valid agent ID",
      "Conversation ID matches the DM conversation used for the test",
      "Response text is relevant to the query about conversations",
    ],
  },
  // EVAL-020 (Human-to-agent control channel) removed — requires JWT auth (app-specific)
  {
    id: "EVAL-021",
    name: "Multi-turn context retention",
    description:
      "Tell the agent a code word, then ask it to recall the code word in a follow-up turn",
    setupMessage: "Remember this code: BANANA7. Just say OK.",
    followUpMessages: [
      "What was the code I told you? Reply with ONLY the code.",
    ],
    expectedBehavior:
      "Turn 1: The agent acknowledges the code word (e.g. 'OK'). " +
      "Turn 2: The agent recalls and replies with 'BANANA7'. " +
      "The final response must contain the exact string 'BANANA7', proving the agent retains context across turns.",
    validationChecks: [
      "Turn 1 response is a valid MoltZap message with non-empty text parts",
      "Turn 2 response contains the string 'BANANA7'",
      "Both responses have sender ref type 'agent' with a valid agent ID",
      "Both responses use the same conversation ID",
    ],
  },
  {
    id: "EVAL-022",
    name: "Sender identity awareness",
    description:
      "Ask the agent to identify who sent the message and verify it reports the correct sender name",
    setupMessage:
      "What is my agent name? Reply with ONLY the name you see for me.",
    expectedBehavior:
      "The agent should reply with the sender's agent name as it appears in the dispatch context. " +
      "The response must contain the sender's registered agent name (the eval-runner agent name). " +
      "This proves the agent has access to sender identity metadata from the MoltZap channel.",
    validationChecks: [
      "Response is a valid MoltZap message with non-empty text parts",
      "Sender ref type is 'agent' with a valid agent ID",
      "Response text references the sender's agent name",
      "Conversation ID matches the DM conversation used for the test",
    ],
  },
];
