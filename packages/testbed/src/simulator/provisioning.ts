/**
 * @file Per-run identity provisioning over the server's HTTP register
 * route (contract 1 internals). Agent registrations, the observer
 * credential, and principal identities are all minted against the run's
 * own fresh server; every minted credential enters the per-attempt
 * `Secrets` before any dependent process starts.
 */
import { Data, Effect, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { Register } from "@moltzap/protocol/identity";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";

const REGISTER_ROUTE = "/api/v1/auth/register";
const REGISTER_NAME_MAX = 32;

/** Internal transport-level failure; callers map it into their own tagged error. */
export class IdentityRegistrationFailed extends Data.TaggedError(
  "IdentityRegistrationFailed",
)<{
  readonly name: string;
  readonly message: string;
}> {}

export type MintedIdentity = {
  readonly agentId: AgentId;
  readonly apiKey: AgentKey;
};

/**
 * Derive the server's HTTP base URL from its WS URL (`ws://h:p/ws` ->
 * `http://h:p`). Both the registration routes and `MoltZapAgentClient`
 * take this form: a `ServerUrl` carries the `/ws` endpoint path the
 * package's adapters use, while the client appends `/ws` to whatever
 * base it is handed, so passing it a `ServerUrl` dials `/ws/ws`.
 */
export function httpBaseFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
}

/**
 * Project an arbitrary identity label onto the register route's name
 * grammar (`^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$`), deterministically.
 */
function registrationName(label: string): string {
  const lowered = label.toLowerCase().replace(/[^a-z0-9_-]/gu, "-");
  const padded = lowered.length >= 3 ? lowered : `${lowered}-id`.slice(0, 3);
  const bounded = padded.slice(0, REGISTER_NAME_MAX);
  return bounded.replace(/^[_-]/u, "0").replace(/[_-]$/u, "0");
}

/** Mint one agent identity against the run's server; the caller registers the key in `Secrets`. */
export function registerIdentity(deps: {
  readonly httpBase: string;
  readonly name: string;
}): Effect.Effect<MintedIdentity, IdentityRegistrationFailed> {
  const failed = (message: string) =>
    new IdentityRegistrationFailed({ name: deps.name, message });
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(
      new URL(REGISTER_ROUTE, deps.httpBase).toString(),
    ).pipe(
      HttpClientRequest.bodyJson({ name: registrationName(deps.name) }),
      Effect.mapError((cause) =>
        failed(`register body could not be encoded: ${String(cause)}`),
      ),
    );
    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError((cause) =>
          failed(
            `register request against ${deps.httpBase} failed: ${cause.message}. Is the run's server container reachable?`,
          ),
        ),
      );
    const body = yield* response.json.pipe(
      Effect.mapError((cause) =>
        failed(`register response was not JSON: ${String(cause)}`),
      ),
    );
    return yield* Schema.decodeUnknown(Register.resultSchema)(body).pipe(
      Effect.mapError((cause) =>
        failed(
          `register response did not match the protocol result schema: ${String(cause)}`,
        ),
      ),
    );
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("registerIdentity"),
  );
}

/** The redaction-relevant string form of a minted key. */
export function agentKeyValue(apiKey: AgentKey): string {
  return Redacted.value(apiKey);
}
