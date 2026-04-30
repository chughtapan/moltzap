import { Effect } from "effect";

/** HTTP response from the agent registration endpoints
 * (`/api/v1/auth/register` and `/api/v1/admin/register-agent`). */
export interface RegisterResponse {
  agentId: string;
  apiKey: string;
  claimUrl: string;
  claimToken: string;
}

/** Options for {@link registerAgent}.
 *
 * `ownerUserId` selects the admin endpoint
 * (`/api/v1/admin/register-agent`), which pre-claims the agent for the
 * given owner at insert time. When omitted, the public endpoint
 * (`/api/v1/auth/register`) is used. */
export interface RegisterAgentOptions {
  description?: string;
  inviteCode?: string;
  ownerUserId?: string;
}

const PUBLIC_PATH = "/api/v1/auth/register";
const ADMIN_PATH = "/api/v1/admin/register-agent";

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
): Effect.Effect<RegisterResponse, Error> =>
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
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.flatMap((res) =>
      res.ok
        ? Effect.tryPromise({
            try: () => res.json() as Promise<RegisterResponse>,
            catch: (err) =>
              err instanceof Error ? err : new Error(String(err)),
          })
        : Effect.tryPromise({
            try: () => res.text(),
            catch: (err) =>
              err instanceof Error ? err : new Error(String(err)),
          }).pipe(
            Effect.flatMap((text) =>
              Effect.fail(new Error(`Register failed: ${res.status} ${text}`)),
            ),
          ),
    ),
  );
