/**
 * Test fixtures — branded-ID constructors + real-server agent registration.
 *
 * Both halves exist solely to construct fixture data for conformance
 * properties: the branded-ID constructors decode string literals into
 * branded UserId/AgentId/ConversationId/etc.; the registration helper
 * POSTs `/api/v1/auth/register` and returns `{ agentId, apiKey }`.
 *
 * Registration returns `Effect&lt;TestAgent, AgentRegistrationError>` —
 * no bare throws.
 */
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { Data, Effect, Schema } from "effect";
import { UserId, AgentId, ContactId } from "../../../identity/index.js";
import type { ConnectionId } from "../../../network/index.js";
import { AppId } from "../../../task/index.js";
import type { AppManifest } from "../../../app/index.js";
import {
  ConversationId,
  LeaseId,
  MessageId,
  TaskId,
} from "../../../task/index.js";

const UNIQUE_SUFFIX_RADIX = 36;
const UNIQUE_SUFFIX_START = 2;
const UNIQUE_SUFFIX_END = 8;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX_EXCLUSIVE = 300;

function uniqueSuffixFragment(): string {
  return globalThis.crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(UNIQUE_SUFFIX_START, UNIQUE_SUFFIX_END);
}

// --- Branded-ID constructors ---
//
// Production code never validates IDs at the caller —
// `defineRpc(...).validateParams` is the single validation site. Tests +
// eval harnesses use these to construct branded values from UUID string
// literals.

export const userId = (value: string): Schema.Schema.Type<typeof UserId> =>
  Schema.decodeUnknownSync(UserId)(value);
export const agentId = (value: string): Schema.Schema.Type<typeof AgentId> =>
  Schema.decodeUnknownSync(AgentId)(value);
export const contactId = (
  value: string,
): Schema.Schema.Type<typeof ContactId> =>
  Schema.decodeUnknownSync(ContactId)(value);
export const conversationId = (
  value: string,
): Schema.Schema.Type<typeof ConversationId> =>
  Schema.decodeUnknownSync(ConversationId)(value);
export const messageId = (
  value: string,
): Schema.Schema.Type<typeof MessageId> =>
  Schema.decodeUnknownSync(MessageId)(value);
export const taskId = (value: string): Schema.Schema.Type<typeof TaskId> =>
  Schema.decodeUnknownSync(TaskId)(value);
export const leaseId = (value: string): Schema.Schema.Type<typeof LeaseId> =>
  Schema.decodeUnknownSync(LeaseId)(value);
export const appId = (value: string): Schema.Schema.Type<typeof AppId> =>
  Schema.decodeUnknownSync(AppId)(value);
// `ConnectionId` is a `brandedString` (no UUID format predicate); skip
// `Value.Decode` and brand the raw string directly. Test fixtures use
// synthetic non-UUID values like "owner-conn-1".
export const connectionId = (value: string): ConnectionId =>
  value as ConnectionId;

// --- Real-server agent registration ---
//
// The protocol package owns this helper (not the consumer) because every
// implementation that wants to run the suite needs it, the HTTP shape is
// part of the protocol contract, and doing it here keeps the consumer-side
// wrapper thin.

export interface TestAgent {
  readonly agentId: Schema.Schema.Type<typeof AgentId>;
  readonly apiKey: string;
  readonly name: string;
  readonly claimUrl?: string;
  readonly claimToken?: string;
}

interface RegisterTestAgentOptions {
  readonly baseUrl: string;
  readonly name: string;
  readonly description?: string;
  readonly inviteCode?: string;
  readonly uniqueSuffix?: string | false;
}

interface RegistrationResponse {
  readonly agentId: string;
  readonly apiKey: string;
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
function registrationName(opts: RegisterTestAgentOptions): string {
  const suffix =
    opts.uniqueSuffix === false
      ? ""
      : (opts.uniqueSuffix ??
        `${Date.now().toString(UNIQUE_SUFFIX_RADIX)}-${uniqueSuffixFragment()}`);
  return suffix === "" ? opts.name : `${opts.name}-${suffix}`;
}

function registrationRequestBody(
  opts: RegisterTestAgentOptions,
  name: string,
): Record<string, string> {
  const requestBody: Record<string, string> = { name };
  if (opts.description !== undefined) {
    requestBody["description"] = opts.description;
  }
  if (opts.inviteCode !== undefined) {
    requestBody["inviteCode"] = opts.inviteCode;
  }
  return requestBody;
}

const registrationErrorMapper =
  (opts: RegisterTestAgentOptions, agentName: string) =>
  (cause: unknown): AgentRegistrationError => {
    if (cause instanceof AgentRegistrationError) return cause;
    return new AgentRegistrationError({
      baseUrl: opts.baseUrl,
      agentName,
      status: 0,
      body: cause instanceof Error ? cause.message : String(cause),
    });
  };

function ensureRegistrationSuccess(
  opts: RegisterTestAgentOptions,
  agentName: string,
  status: number,
  body: string,
): Effect.Effect<void, AgentRegistrationError> {
  if (status >= HTTP_SUCCESS_MIN && status < HTTP_SUCCESS_MAX_EXCLUSIVE) {
    return Effect.void;
  }
  return Effect.fail(
    new AgentRegistrationError({
      baseUrl: opts.baseUrl,
      agentName,
      status,
      body,
    }),
  );
}

const parseRegistrationResponse = (
  body: string,
  toRegistrationError: (cause: unknown) => AgentRegistrationError,
): Effect.Effect<RegistrationResponse, AgentRegistrationError> =>
  Effect.try({
    try: () => JSON.parse(body) as RegistrationResponse,
    catch: toRegistrationError,
  });

// --- Real-server app registration ---
//
// App principals register via the `/api/v1/apps/register` HTTP endpoint
// (server-minted `{ appId, appKey }`), then `appKey`-Connect to bind an
// `AppConnection`. The protocol package owns this helper for the same
// reason it owns `registerTestAgent`: the HTTP shape is part of the
// protocol contract and every implementation running the suite needs it.

/** A registered app: the server-minted `appId` + the once-returned `appKey`. */
export interface RegisteredTestApp {
  readonly appId: Schema.Schema.Type<typeof AppId>;
  readonly appKey: string;
  readonly manifest: AppManifest;
}

interface RegisterTestAppOptions {
  readonly baseUrl: string;
  readonly manifest: AppManifest;
  /** Required when the server boots with a `registrationSecret`. */
  readonly inviteCode?: string;
}

interface AppRegistrationResponse {
  readonly appId: string;
  readonly appKey: string;
}

/** HTTP app registration failed (network, non-2xx, malformed response). */
export class TestAppHttpRegistrationError extends Data.TaggedError(
  "TestingAppHttpRegistrationError",
)<{
  readonly baseUrl: string;
  readonly status: number;
  readonly body: string;
}> {}

const hasStringField = (value: object, key: string): boolean =>
  key in value && typeof Reflect.get(value, key) === "string";

const isAppRegistrationResponse = (
  value: unknown,
): value is AppRegistrationResponse =>
  typeof value === "object" &&
  value !== null &&
  hasStringField(value, "appId") &&
  hasStringField(value, "appKey");

const appRegistrationBody = (
  opts: RegisterTestAppOptions,
): Record<string, unknown> =>
  opts.inviteCode === undefined
    ? { manifest: opts.manifest }
    : { manifest: opts.manifest, inviteCode: opts.inviteCode };

const appRegistrationError =
  (opts: RegisterTestAppOptions) =>
  (cause: unknown): TestAppHttpRegistrationError => {
    if (cause instanceof TestAppHttpRegistrationError) return cause;
    return new TestAppHttpRegistrationError({
      baseUrl: opts.baseUrl,
      status: 0,
      body: cause instanceof Error ? cause.message : String(cause),
    });
  };

/**
 * Register an app manifest against the real server's HTTP endpoint and
 * return the server-minted `{ appId, appKey }` (the `appId` is
 * `gen_random_uuid()`, NOT `manifest.appId`). The App-principal sibling of
 * {@link registerTestAgent}; the `appKey` is handed to a `TestClient` whose
 * `appKey` Connect arm binds an `AppConnection` (implicit moderator-endpoint
 * registration) — there is no cross-principal WS `apps/register` RPC.
 */
export function registerTestAppHttp(
  opts: RegisterTestAppOptions,
): Effect.Effect<RegisteredTestApp, TestAppHttpRegistrationError> {
  const toError = appRegistrationError(opts);
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(
      `${opts.baseUrl}/api/v1/apps/register`,
    ).pipe(
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.bodyUnsafeJson(appRegistrationBody(opts)),
    );
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toError));
    const body = yield* response.text.pipe(Effect.mapError(toError));
    const parsed = yield* parseAppRegistration(opts, response.status, body);
    return {
      appId: appId(parsed.appId),
      appKey: parsed.appKey,
      manifest: opts.manifest,
    } satisfies RegisteredTestApp;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("registerTestAppHttp"),
  );
}

function parseAppRegistration(
  opts: RegisterTestAppOptions,
  status: number,
  body: string,
): Effect.Effect<AppRegistrationResponse, TestAppHttpRegistrationError> {
  const fail = (): Effect.Effect<never, TestAppHttpRegistrationError> =>
    Effect.fail(
      new TestAppHttpRegistrationError({ baseUrl: opts.baseUrl, status, body }),
    );
  if (status < HTTP_SUCCESS_MIN || status >= HTTP_SUCCESS_MAX_EXCLUSIVE) {
    return fail();
  }
  return Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: appRegistrationError(opts),
  }).pipe(
    Effect.flatMap((parsed) =>
      isAppRegistrationResponse(parsed) ? Effect.succeed(parsed) : fail(),
    ),
  );
}

export function registerTestAgent(
  opts: RegisterTestAgentOptions,
): Effect.Effect<TestAgent, AgentRegistrationError> {
  const name = registrationName(opts);
  const requestBody = registrationRequestBody(opts, name);
  const toRegistrationError = registrationErrorMapper(opts, name);
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
    yield* ensureRegistrationSuccess(opts, name, response.status, body);
    const parsed = yield* parseRegistrationResponse(body, toRegistrationError);
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
