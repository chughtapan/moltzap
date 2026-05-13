/**
 * Test fixtures — branded-ID constructors + real-server agent registration.
 *
 * Phase 1B re-architect: merges the pre-reorg pair `testing/branded-ids.ts`
 * + `testing/agent-registration.ts`. Both files exist solely to construct
 * fixture data for conformance properties — `branded-ids` decodes string
 * literals into branded UserId/AgentId/ConversationId/etc.; the
 * registration helper POSTs `/api/v1/auth/register` and returns
 * `{ agentId, apiKey }`. Same role, adjacent shape; one file.
 *
 * Principle 3: registration returns
 * `Effect<TestAgent, AgentRegistrationError>` — no bare throws.
 */
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import type { Static } from "@sinclair/typebox";
import { Data, Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import { UserId, AgentId, ContactId } from "../../../identity/methods.js";
import { ConversationId, MessageId, TaskId } from "../../../task/methods.js";

const UNIQUE_SUFFIX_RADIX = 36;
const UNIQUE_SUFFIX_START = 2;
const UNIQUE_SUFFIX_END = 8;

// --- Branded-ID constructors ---
//
// Production code never validates IDs at the caller —
// `defineRpc(...).validateParams` is the single validation site. Tests +
// eval harnesses use these to construct branded values from UUID string
// literals.

export const userId = (value: string): Static<typeof UserId> =>
  Value.Decode(UserId, value);
export const agentId = (value: string): Static<typeof AgentId> =>
  Value.Decode(AgentId, value);
export const contactId = (value: string): Static<typeof ContactId> =>
  Value.Decode(ContactId, value);
export const conversationId = (value: string): Static<typeof ConversationId> =>
  Value.Decode(ConversationId, value);
export const messageId = (value: string): Static<typeof MessageId> =>
  Value.Decode(MessageId, value);
export const taskId = (value: string): Static<typeof TaskId> =>
  Value.Decode(TaskId, value);

// --- Real-server agent registration ---
//
// The protocol package owns this helper (not the consumer) because every
// implementation that wants to run the suite needs it, the HTTP shape is
// part of the protocol contract, and doing it here keeps the consumer-side
// wrapper thin.

export interface TestAgent {
  readonly agentId: Static<typeof AgentId>;
  readonly apiKey: string;
  readonly name: string;
  readonly claimUrl?: string;
  readonly claimToken?: string;
}

/** HTTP registration failed (network, non-2xx, malformed response). */
export class AgentRegistrationError extends Data.TaggedError(
  "TestingAgentRegistrationError",
)<{
  readonly baseUrl: string;
  readonly agentName: string;
  readonly status: number;
  readonly body: string;
}> {}

/**
 * Register an agent against the real server's HTTP endpoint. The
 * returned `apiKey` is the `agentKey` TestClient sends in `network/connect`.
 *
 * Every call uses a unique suffix so replays don't collide on the
 * server's "duplicate name" check; seeded replays pass a stable
 * `uniqueSuffix` to make the name deterministic.
 */
export function registerTestAgent(opts: {
  readonly baseUrl: string;
  readonly name: string;
  readonly description?: string;
  readonly inviteCode?: string;
  readonly uniqueSuffix?: string | false;
}): Effect.Effect<TestAgent, AgentRegistrationError> {
  const suffix =
    opts.uniqueSuffix === false
      ? ""
      : (opts.uniqueSuffix ??
        `${Date.now().toString(UNIQUE_SUFFIX_RADIX)}-${Math.random().toString(UNIQUE_SUFFIX_RADIX).slice(UNIQUE_SUFFIX_START, UNIQUE_SUFFIX_END)}`);
  const name = suffix === "" ? opts.name : `${opts.name}-${suffix}`;
  const requestBody: Record<string, string> = { name };
  if (opts.description !== undefined) {
    requestBody["description"] = opts.description;
  }
  if (opts.inviteCode !== undefined) {
    requestBody["inviteCode"] = opts.inviteCode;
  }
  const toRegistrationError = (cause: unknown): AgentRegistrationError => {
    if (cause instanceof AgentRegistrationError) return cause;
    return new AgentRegistrationError({
      baseUrl: opts.baseUrl,
      agentName: name,
      status: 0,
      body: cause instanceof Error ? cause.message : String(cause),
    });
  };
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(
      `${opts.baseUrl}/api/v1/auth/register`,
    ).pipe(
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.bodyUnsafeJson(requestBody),
    );
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toRegistrationError));
    const body = yield* response.text.pipe(
      Effect.mapError(toRegistrationError),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new AgentRegistrationError({
          baseUrl: opts.baseUrl,
          agentName: name,
          status: response.status,
          body,
        }),
      );
    }
    const parsed = yield* Effect.try({
      try: () =>
        JSON.parse(body) as {
          agentId: string;
          apiKey: string;
          claimUrl?: string;
          claimToken?: string;
        },
      catch: toRegistrationError,
    });
    return {
      agentId: agentId(parsed.agentId),
      apiKey: parsed.apiKey,
      claimUrl: parsed.claimUrl,
      claimToken: parsed.claimToken,
      name,
    } satisfies TestAgent;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("registerTestAgent"),
  );
}
