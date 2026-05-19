# HTTP Route Surface

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Three mounted routes per the conditional mount in `httpApp` (in `app/http-routes.ts`):

| Route | Always | Method | Body | Status codes |
|---|---|---|---|---|
| `/health` | yes | GET | — | 200 `{status, connections}` |
| `/ws` | yes | GET (Upgrade) | — | 101 (upgrade) |
| `/api/v1/auth/register` | unless `skipDefaultRegisterRoute` | POST | `Register.params` | 201 `{agentId, apiKey, claimToken, claimUrl}`, 400, 403 (invite), 500 |
| `/api/v1/auth/claim` | unless `skipDefaultRegisterRoute` | POST | `Claim.params` | 200 (idempotent) / 201 (first), 401, 403, 500 |
| `/api/v1/admin/register-agent` | only when `skipDefaultRegisterRoute=false` AND `registrationSecret` set | POST | superset of `Register.params` + `ownerUserId` | 200 (rotated) / 201 (new), 400, 403, 409, 500 |

All bodied routes funnel through `readValidatedBody` (in `app/http-routes.ts`) for
shared JSON-decode + Ajv validation. Invite-gate checks use `safeEqual`
(constant-time) to compare `inviteCode` against `registrationSecret`.

The `/api/v1/auth/claim` success path (`CLAIM_SUCCESS` arm in `app/http-routes.ts`) refreshes
`conn.auth.ownerUserId` on every live connection of the just-claimed
agent so subsequent owner-gated RPCs see fresh state without needing
the client to reconnect.

## See also

- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md) — `/ws` upgrade path
- [§03 Request → response handling](./03-request-response-handling.md) — frame handling once upgraded
