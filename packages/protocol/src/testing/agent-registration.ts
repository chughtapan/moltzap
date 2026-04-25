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
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const name = suffix === "" ? opts.name : `${opts.name}-${suffix}`;
  return Effect.tryPromise({
    // #ignore-sloppy-code-next-line[async-keyword]: HTTP POST is Promise-native; Effect.tryPromise captures the rejection path
    try: async () => {
      const requestBody: Record<string, string> = { name };
      if (opts.description !== undefined) {
        requestBody["description"] = opts.description;
      }
      if (opts.inviteCode !== undefined) {
        requestBody["inviteCode"] = opts.inviteCode;
      }
      const res = await fetch(`${opts.baseUrl}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const body = await res.text();
      if (!res.ok) {
        throw new AgentRegistrationError({
          baseUrl: opts.baseUrl,
          agentName: name,
          status: res.status,
          body,
        });
      }
      const parsed = JSON.parse(body) as {
        agentId: string;
        apiKey: string;
        claimUrl?: string;
        claimToken?: string;
      };
      return {
        agentId: parsed.agentId,
        apiKey: parsed.apiKey,
        claimUrl: parsed.claimUrl,
        claimToken: parsed.claimToken,
        name,
      } satisfies TestAgent;
    },
    catch: (cause) => {
      if (cause instanceof AgentRegistrationError) return cause;
      return new AgentRegistrationError({
        baseUrl: opts.baseUrl,
        agentName: name,
        status: 0,
        body: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });
}
