/**
 * Test-agent registration helper — POSTs `/api/v1/auth/register` against
 * the real server's HTTP control plane and returns `{ agentId, apiKey }`.
 *
 * Used by conformance properties that need a real authenticated agent to
 * drive `TestClient`. The protocol package owns this helper (not the
 * consumer) because every implementation that wants to run the suite
 * needs it, the HTTP shape is part of the protocol contract, and doing
 * it here keeps the consumer-side wrapper thin.
 *
 * Principle 3: returns `Effect<TestAgent, AgentRegistrationError>` — no
 * bare throws.
 */
import { Data, Effect } from "effect";

const UNIQUE_SUFFIX_RADIX = 36;
const UNIQUE_SUFFIX_START = 2;
const UNIQUE_SUFFIX_END = 8;

export interface TestAgent {
  readonly agentId: string;
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
 * returned `apiKey` is the `agentKey` TestClient sends in `auth/connect`.
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
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`${opts.baseUrl}/api/v1/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }),
      catch: toRegistrationError,
    });
    const body = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: toRegistrationError,
    });
    if (!res.ok) {
      return yield* Effect.fail(
        new AgentRegistrationError({
          baseUrl: opts.baseUrl,
          agentName: name,
          status: res.status,
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
      agentId: parsed.agentId,
      apiKey: parsed.apiKey,
      claimUrl: parsed.claimUrl,
      claimToken: parsed.claimToken,
      name,
    } satisfies TestAgent;
  });
}
