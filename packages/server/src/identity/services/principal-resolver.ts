import { Effect, Schema } from "effect";
import { UnauthorizedError } from "@moltzap/protocol";
import type { AppManifest } from "@moltzap/protocol/app";
import {
  AgentContext,
  type AgentStatus,
  AppContext,
} from "../../transport/context.js";
import type { AuthService } from "./auth.service.js";
import type { AppAuthService } from "./app-auth.service.js";

/**
 * Prefix discriminators for credential dispatch. The agent prefix is the
 * one stamped by `generateApiKey`; the app prefix is stamped by
 * `generateAppKey` (`agent-auth.ts`). Re-declared here as resolver-local
 * dispatch keys rather than imported because the resolver matches on the
 * leading substring, not on a parsed key — `parseApiKey`/`parseAppKey`
 * each own their own prefix internally.
 */
const AGENT_KEY_PREFIX = "moltzap_agent_";
const APP_KEY_PREFIX = "moltzap_app_";

const AgentStatusSchema = Schema.Literal(
  "active",
  "pending_claim",
  "suspended",
);

// The literal set MUST stay identical to the canonical `AgentStatus` union;
// this type-level equality breaks `tsc` if either side drifts (a 4th status
// added to `AgentStatus` would otherwise let the decoder silently reject
// valid rows and route them to a defect). `assertAgentStatusExhaustive`
// resolves to `(x: true) => void` only when the sets match; on drift the
// parameter type becomes `never` and the `true` argument fails to compile.
type _Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;
const assertAgentStatusExhaustive = (
  _ok: _Equal<
    Schema.Schema.Type<typeof AgentStatusSchema>,
    AgentStatus
  > extends true
    ? true
    : never,
): void => undefined;
assertAgentStatusExhaustive(true);

/**
 * Decoder narrowing the DB-widened `status: string` (from
 * {@link AuthService.authenticateAgent}) back to the closed
 * {@link AgentStatus} union before it enters an {@link AgentContext}. The
 * `agents.status agent_status` enum constrains the column structurally, so
 * a decode failure here is a storage-invariant violation, not an auth
 * failure — it routes to a defect, NOT the `UnauthorizedError` channel.
 */
const decodeAgentStatus = Schema.decodeUnknown(AgentStatusSchema);

/**
 * Discriminated principal-resolution result (D #705 §2.4). Agents need
 * only the bare context; apps additionally carry the manifest, decoded
 * atomically with the principal during authentication so no downstream
 * `getManifest` call is needed on the Connect path.
 */
export type ResolvedPrincipal =
  | { readonly _tag: "Agent"; readonly auth: AgentContext }
  | {
      readonly _tag: "App";
      readonly auth: AppContext;
      readonly manifest: AppManifest;
    };

/**
 * Resolves a raw connection credential to its principal by dispatching on
 * the key prefix. The agent path goes through {@link AuthService}; the app
 * path through {@link AppAuthService}. The wire never reveals which path
 * matched: a `null` result (unknown prefix, or a hash MISS on either path)
 * is surfaced as a uniform `UnauthorizedError` by the caller. The only
 * typed domain failure is the `manifest_corrupted` `UnauthorizedError`
 * from a hash-matching app row whose persisted manifest fails to decode
 * (environmental/storage failure the operator fixes by re-registering).
 */
export class PrincipalResolver {
  constructor(
    private readonly authService: AuthService,
    private readonly appAuthService: AppAuthService,
  ) {}

  resolve(
    credential: string,
  ): Effect.Effect<ResolvedPrincipal | null, UnauthorizedError> {
    if (credential.startsWith(AGENT_KEY_PREFIX)) {
      return this.resolveAgent(credential);
    }
    if (credential.startsWith(APP_KEY_PREFIX)) {
      return this.resolveApp(credential);
    }
    return Effect.succeed(null);
  }

  private resolveAgent(
    credential: string,
  ): Effect.Effect<ResolvedPrincipal | null, UnauthorizedError> {
    return Effect.gen(this, function* () {
      const agent = yield* this.authService.authenticateAgent(credential);
      if (agent === null) return null;

      const agentStatus: AgentStatus = yield* decodeAgentStatus(
        agent.status,
      ).pipe(
        Effect.catchTag("ParseError", (cause) =>
          Effect.die(
            new Error(
              `PrincipalResolver: agent ${agent.agentId} has un-decodable status "${agent.status}"`,
              { cause },
            ),
          ),
        ),
      );

      const auth = new AgentContext({
        agentId: agent.agentId,
        agentStatus,
        ownerUserId: agent.ownerUserId,
      });
      return { _tag: "Agent", auth } as const;
    });
  }

  private resolveApp(
    credential: string,
  ): Effect.Effect<ResolvedPrincipal | null, UnauthorizedError> {
    return Effect.gen(this, function* () {
      const result = yield* this.appAuthService.authenticateApp(credential);
      if (result === null) return null;
      return {
        _tag: "App",
        auth: result.auth,
        manifest: result.manifest,
      } as const;
    });
  }
}
