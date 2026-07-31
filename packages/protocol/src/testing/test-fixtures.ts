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
import { Data, Effect, Either, FastCheck, Schema } from "effect";
import {
  agentId as agentIdSchema,
  type AgentKey,
  agentKey,
  appId as appIdSchema,
  type AppKey,
  appKey,
  userId as userIdSchema,
} from "#identity";
import { connectionId as decodeConnectionId } from "#socket";
import type { AppManifest } from "#identity/apps";
import {
  conversationId as conversationIdSchema,
  messageId as messageIdSchema,
} from "#conversation";
import { leaseId as leaseIdSchema } from "#message/dispatch";
import { taskId as taskIdSchema } from "#task";

const UNIQUE_SUFFIX_RADIX = 36;
const UNIQUE_SUFFIX_START = 2;
const UNIQUE_SUFFIX_END = 8;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX_EXCLUSIVE = 300;
const AGENT_KEY_PREFIX = "moltzap_agent_";
const KEY_ID_HEX_CHARS = 16;
const SECRET_HEX_CHARS = 48;
const FALLBACK_AGENT_KEY_STRING = `${AGENT_KEY_PREFIX}${"0".repeat(
  KEY_ID_HEX_CHARS,
)}_${"0".repeat(SECRET_HEX_CHARS)}`;
const HEX_DIGITS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
] as const;

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

/**
 * Validates and decodes user id values.
 * @param value Value to process.
 * @returns The user id result.
 */
export const userId = (
  value: string,
): Schema.Schema.Type<typeof userIdSchema> =>
  Schema.decodeUnknownSync(userIdSchema)(value);
/**
 * Validates and decodes agent id values.
 * @param value Value to process.
 * @returns The agent id result.
 */
export const agentId = (
  value: string,
): Schema.Schema.Type<typeof agentIdSchema> =>
  Schema.decodeUnknownSync(agentIdSchema)(value);
/**
 * Validates and decodes conversation id values.
 * @param value Value to process.
 * @returns The conversation id result.
 */
export const conversationId = (
  value: string,
): Schema.Schema.Type<typeof conversationIdSchema> =>
  Schema.decodeUnknownSync(conversationIdSchema)(value);
/**
 * Validates and decodes message id values.
 * @param value Value to process.
 * @returns The message id result.
 */
export const messageId = (
  value: string,
): Schema.Schema.Type<typeof messageIdSchema> =>
  Schema.decodeUnknownSync(messageIdSchema)(value);
/**
 * Validates and decodes task id values.
 * @param value Value to process.
 * @returns The task id result.
 */
export const taskId = (
  value: string,
): Schema.Schema.Type<typeof taskIdSchema> =>
  Schema.decodeUnknownSync(taskIdSchema)(value);
/**
 * Validates and decodes lease id values.
 * @param value Value to process.
 * @returns The lease id result.
 */
export const leaseId = (
  value: string,
): Schema.Schema.Type<typeof leaseIdSchema> =>
  Schema.decodeUnknownSync(leaseIdSchema)(value);
/**
 * Validates and decodes app id values.
 * @param value Value to process.
 * @returns The app id result.
 */
export const appId = (value: string): Schema.Schema.Type<typeof appIdSchema> =>
  Schema.decodeUnknownSync(appIdSchema)(value);
/**
 * Validates and decodes redacted agent key values.
 * @param value Value to process.
 * @returns The redacted agent key result.
 */
export const redactedAgentKey = (value: string): AgentKey =>
  Schema.decodeUnknownSync(agentKey)(value);
/**
 * Validates and decodes redacted app key values.
 * @param value Value to process.
 * @returns The redacted app key result.
 */
export const redactedAppKey = (value: string): AppKey =>
  Schema.decodeUnknownSync(appKey)(value);
const hexStringArbitrary = (length: number): FastCheck.Arbitrary<string> =>
  FastCheck.array(FastCheck.constantFrom(...HEX_DIGITS), {
    minLength: length,
    maxLength: length,
  }).map((chars) => chars.join(""));
/** Provides the agent key string arbitrary runtime value. */
export const agentKeyStringArbitrary: FastCheck.Arbitrary<string> =
  FastCheck.tuple(
    hexStringArbitrary(KEY_ID_HEX_CHARS),
    hexStringArbitrary(SECRET_HEX_CHARS),
  ).map(([keyId, secret]) => `${AGENT_KEY_PREFIX}${keyId}_${secret}`);
/** Provides the agent key arbitrary runtime value. */
export const agentKeyArbitrary: FastCheck.Arbitrary<AgentKey> =
  agentKeyStringArbitrary.map(redactedAgentKey);
/**
 * Provides the agent key string runtime value.
 * @param seed Value supplied to the operation.
 * @returns The agent key string result.
 */
export const agentKeyString = (seed: number): string => {
  const [value] = FastCheck.sample(agentKeyStringArbitrary, {
    seed,
    numRuns: 1,
  });
  return value ?? FALLBACK_AGENT_KEY_STRING;
};
/** Provides the connection id runtime value. */
export const connectionId = decodeConnectionId;

// --- Real-server agent registration ---
//
// The protocol package owns this helper (not the consumer) because every
// implementation that wants to run the suite needs it, the HTTP shape is
// part of the protocol contract, and doing it here keeps the consumer-side
// wrapper thin.

/** Describes test agent. */
export interface TestAgent {
  readonly agentId: Schema.Schema.Type<typeof agentIdSchema>;
  readonly apiKey: AgentKey;
  readonly name: string;
}

interface RegisterTestAgentOptions {
  readonly baseUrl: string;
  readonly name: string;
  readonly description?: string;
  readonly inviteCode?: string;
  readonly uniqueSuffix?: string | false;
}

const registrationResponseSchema = Schema.Struct({
  agentId: agentIdSchema,
  apiKey: agentKey,
});
type RegistrationResponse = Schema.Schema.Type<
  typeof registrationResponseSchema
>;
const registrationResponseText = Schema.parseJson(registrationResponseSchema);

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
 * returned `apiKey` is the `agentKey` TestClient sends in `agent/network/connect`.
 *
 * Every call uses a unique suffix so replays don't collide on the
 * server's "duplicate name" check; seeded replays pass a stable
 * `uniqueSuffix` to make the name deterministic.
 * @param opts Value supplied to the operation.
 * @returns The registration name result.
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
    requestBody.description = opts.description;
  }
  if (opts.inviteCode !== undefined) {
    requestBody.inviteCode = opts.inviteCode;
  }
  return requestBody;
}

const registrationErrorMapper =
  (opts: RegisterTestAgentOptions, agentName: string) =>
  (cause: unknown): AgentRegistrationError => {
    if (cause instanceof AgentRegistrationError) {
      return cause;
    }
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
  Schema.decodeUnknown(registrationResponseText)(body).pipe(
    Effect.mapError(toRegistrationError),
  );

// --- Real-server app credential minting ---
//
// App principals register via the `/api/v1/apps/register` HTTP endpoint
// (server-minted `{ appId, appKey }`), then `appKey`-Connect to bind an
// `AppConnection`. The protocol package owns this helper for the same
// reason it owns `registerTestAgent`: the HTTP shape is part of the
// protocol contract and every implementation running the suite needs it.

/** Server-minted app principal credentials. */
export interface TestAppCredential {
  readonly appId: Schema.Schema.Type<typeof appIdSchema>;
  readonly appKey: AppKey;
}

interface RegisterTestAppOptions {
  readonly baseUrl: string;
  readonly manifest: AppManifest;
  /** Required when the server boots with a `registrationSecret`. */
  readonly inviteCode?: string;
}

const appRegistrationResponseSchema = Schema.Struct({
  appId: appIdSchema,
  appKey: appKey,
});
type AppRegistrationResponse = Schema.Schema.Type<
  typeof appRegistrationResponseSchema
>;
const appRegistrationResponseText = Schema.parseJson(
  appRegistrationResponseSchema,
);

/** HTTP app registration failed (network, non-2xx, malformed response). */
export class TestAppHttpRegistrationError extends Data.TaggedError(
  "TestingAppHttpRegistrationError",
)<{
  readonly baseUrl: string;
  readonly status: number;
  readonly body: string;
}> {}

const appRegistrationBody = (
  opts: RegisterTestAppOptions,
): Record<string, unknown> =>
  opts.inviteCode === undefined
    ? { manifest: opts.manifest }
    : { manifest: opts.manifest, inviteCode: opts.inviteCode };

const appRegistrationError =
  (opts: RegisterTestAppOptions) =>
  (cause: unknown): TestAppHttpRegistrationError => {
    if (cause instanceof TestAppHttpRegistrationError) {
      return cause;
    }
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
 * `appKey` Connect arm binds an `AppConnection` through the implicit
 * moderator-endpoint registration path.
 * @param opts Value supplied to the operation.
 * @returns The mint test app credential result.
 */
export function mintTestAppCredential(
  opts: RegisterTestAppOptions,
): Effect.Effect<TestAppCredential, TestAppHttpRegistrationError> {
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
    return parsed;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("mintTestAppCredential"),
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
  return Schema.decodeUnknown(appRegistrationResponseText)(body).pipe(
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: fail,
        onRight: Effect.succeed,
      }),
    ),
  );
}

/**
 * Registers test agent.
 * @param opts Value supplied to the operation.
 * @returns The register test agent result.
 */
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
    return { ...parsed, name } satisfies TestAgent;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("registerTestAgent"),
  );
}
