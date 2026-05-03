import { Data, Effect } from "effect";

/** HTTP response from the agent registration endpoints
 * (`/api/v1/auth/register` and `/api/v1/admin/register-agent`). */
export interface RegisterResponse {
  agentId: string;
  apiKey: string;
  claimUrl: string;
  claimToken: string;
}

/** Options for {@link registerAgent}. */
export interface RegisterAgentOptions {
  description?: string;
  inviteCode?: string;
  /** When set, registers via the secret-gated admin endpoint and pre-claims
   * the agent for this user. See {@link registerAgent}. */
  ownerUserId?: string;
}

const PUBLIC_PATH = "/api/v1/auth/register";
const ADMIN_PATH = "/api/v1/admin/register-agent";

export class RegisterAgentError extends Data.TaggedError("RegisterAgentError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const registerAgentError = (
  message: string,
  cause?: unknown,
): RegisterAgentError => new RegisterAgentError({ message, cause });

/** Register a new agent via HTTP. Thin wrapper around the agent-registration
 * endpoints — the WebSocket dance is `MoltZapWsClient`'s job; this just
 * returns the credentials the caller feeds it as `agentKey` at construction.
 *
 * Routes to `/api/v1/admin/register-agent` when `ownerUserId` is provided
 * (admin path pre-claims the agent for the given owner); otherwise routes
 * to the public `/api/v1/auth/register` endpoint. */
export const registerAgent = (
  baseUrl: string,
  name: string,
  opts?: RegisterAgentOptions,
): Effect.Effect<RegisterResponse, RegisterAgentError> =>
  Effect.tryPromise({
    try: () => {
      const body: Record<string, string> = { name };
      if (opts?.description) body.description = opts.description;
      if (opts?.inviteCode) body.inviteCode = opts.inviteCode;
      if (opts?.ownerUserId) body.ownerUserId = opts.ownerUserId;
      const path = opts?.ownerUserId ? ADMIN_PATH : PUBLIC_PATH;
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    catch: (err) => registerAgentError("Register request failed", err),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.tryPromise({
            try: () => res.json() as Promise<RegisterResponse>,
            catch: (err) =>
              registerAgentError("Register response decode failed", err),
          })
        : Effect.tryPromise({
            try: () => res.text(),
            catch: (err) =>
              registerAgentError("Register error response read failed", err),
          }).pipe(
            Effect.flatMap((text) =>
              Effect.fail(
                registerAgentError(`Register failed: ${res.status} ${text}`),
              ),
            ),
          ),
    ),
  );
