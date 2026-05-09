/**
 * Test fixtures — branded-ID constructors + real-server agent registration.
 *
 * Phase 1B re-architect (arch-1b-r2): merges the pre-reorg pair
 * `testing/branded-ids.ts` (~22 LOC, 1 outside consumer) +
 * `testing/agent-registration.ts` (~120 LOC, 0 outside consumers).
 *
 * Both files exist solely to construct fixture data for conformance
 * properties — `branded-ids` decodes string literals into branded
 * UserId/AgentId/ConversationId/etc.; `agent-registration` POSTs
 * `/api/v1/auth/register` and returns `{ agentId, apiKey }`. Same role,
 * adjacent shape; one file.
 *
 * Branded-ids decision (per arch-1b-r2 §1): MOVE here. The single outside
 * consumer (`packages/protocol/src/network/actor-model.test.ts`) is itself
 * a `.test.ts` file; the redirect rewrites its import to the
 * `@moltzap/protocol/testing` barrel (or relative `../testing/index.js`)
 * and surfaces no shape change.
 *
 * Architect stub — implementer concatenates the two source modules
 * verbatim and rewrites their relative imports to the new
 * conformance/_shared/ paths.
 */

import { type Data, type Effect } from "effect";

// Public exports (union of `testing/branded-ids.ts` + `testing/agent-registration.ts`;
// the barrel at `testing/index.ts` re-exports these names unchanged).

// --- branded-ids.ts surface ---
export function userId(): never {
  throw new Error("test-fixtures.userId: stub");
}
export function agentId(): never {
  throw new Error("test-fixtures.agentId: stub");
}
export function contactId(): never {
  throw new Error("test-fixtures.contactId: stub");
}
export function conversationId(): never {
  throw new Error("test-fixtures.conversationId: stub");
}
export function messageId(): never {
  throw new Error("test-fixtures.messageId: stub");
}
export function taskId(): never {
  throw new Error("test-fixtures.taskId: stub");
}

// --- agent-registration.ts surface ---
export interface TestAgent {
  readonly agentId: never;
  readonly apiKey: string;
  readonly name: string;
  readonly claimUrl?: string;
  readonly claimToken?: string;
}

export declare class AgentRegistrationError extends (class {} as new (
  args: never,
) => Data.Case) {
  readonly _tag: "TestingAgentRegistrationError";
  readonly baseUrl: string;
  readonly agentName: string;
  readonly status: number;
  readonly body: string;
}

export function registerTestAgent(): Effect.Effect<
  TestAgent,
  AgentRegistrationError
> {
  throw new Error("test-fixtures.registerTestAgent: stub");
}
