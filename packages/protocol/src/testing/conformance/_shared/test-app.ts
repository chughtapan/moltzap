/**
 * TestApp — protocol-level app fixture for conformance tests.
 *
 * A TestApp is a registered app manifest plus scripted handlers for
 * server-initiated app callbacks. It deliberately stays above
 * `AppTestClient` and below app-domain scenario drivers: it knows how to
 * HTTP-register the app manifest and answer `app/dispatch/authorize` /
 * `app/message/authorize`, but it does not know about tasks, leases, or
 * conversations beyond manifest defaults.
 */
import { Duration, Effect, Ref, type Scope, Schema } from "effect";
import type { AppManifest } from "#identity/apps";
import { MessagesAuthorize } from "#message";
import { AppId, TaskCreate } from "#task";
import { DispatchAuthorize } from "#message/dispatch";
import {
  makeAppTestClient,
  type AppTestClient,
  type ServerRpcDefinition,
  type ServerRpcParams,
  type ServerRpcResult,
} from "./driver/test-client.js";
import {
  mintTestAppCredential,
  type TestAppHttpRegistrationError,
} from "./test-fixtures.js";
import type {
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "./errors.js";

const APP_CLIENT_DEFAULT_TIMEOUT_MS = 5_000;

const UNIQUE_SUFFIX_START = 2;
const UNIQUE_SUFFIX_END = 8;

const DEFAULT_CONVERSATIONS: NonNullable<AppManifest["conversations"]> = [
  { key: "main", name: "Main", participantFilter: "all" },
];

export type TestAppRegistrationFailure =
  | TestAppHttpRegistrationError
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError;

export interface TestAppManifestOptions {
  readonly appId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly conversations?: AppManifest["conversations"];
  readonly dispatchAuthorizeTimeoutMs?: number;
  readonly messagesAuthorizeTimeoutMs?: number;
  readonly taskCreateTimeoutMs?: number;
}

/**
 * `registerTestApp` mints a SEPARATE app principal: it HTTP-registers
 * the manifest (`/api/v1/apps/register` → server-minted
 * `{ appId, appKey }`) and opens an `appKey`-Connect `AppTestClient` whose
 * implicit registration binds it as the app's moderator endpoint. The
 * callers supply the real server's `baseUrl` (HTTP register) + `wsUrl`
 * (Connect), NOT a pre-built agent client.
 */
export interface RegisterTestAppOptions extends TestAppManifestOptions {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly manifest?: AppManifest;
  /** Required when the server boots with a `registrationSecret`. */
  readonly inviteCode?: string;
}

export interface TestAppCallbackHandler<D extends ServerRpcDefinition> {
  readonly respondWith: ServerRpcResult<D>;
  readonly predicate?: (params: ServerRpcParams<D>) => boolean;
  readonly holdResponseFor?: number;
}

export interface TestAppCallbackScript<D extends ServerRpcDefinition> {
  readonly handle: (handler: TestAppCallbackHandler<D>) => Effect.Effect<void>;
  readonly silence: Effect.Effect<void>;
}

export interface TestApp {
  /** Server-minted appId (the principal `agent/task/request` targets). */
  readonly appId: Schema.Schema.Type<typeof AppId>;
  readonly manifest: AppManifest;
  /** The app-principal `AppConnection` hosting the moderator callbacks. */
  readonly client: AppTestClient;
  readonly dispatchAuthorize: TestAppCallbackScript<typeof DispatchAuthorize>;
  readonly messagesAuthorize: TestAppCallbackScript<typeof MessagesAuthorize>;
}

interface CallbackState<D extends ServerRpcDefinition> {
  readonly handlers: ReadonlyArray<TestAppCallbackHandler<D>>;
  readonly silenced: boolean;
}

export function makeTestAppManifest(
  options: TestAppManifestOptions = {},
): AppManifest {
  const appId = options.appId ?? `test-app-${uniqueSuffixFragment()}`;
  const hooks = makeManifestHooks(options);
  return {
    appId,
    name: options.name ?? `Test App ${appId}`,
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    conversations: options.conversations ?? DEFAULT_CONVERSATIONS,
    hooks,
  };
}

export function registerTestApp(
  options: RegisterTestAppOptions,
): Effect.Effect<TestApp, TestAppRegistrationFailure, Scope.Scope> {
  const manifest = options.manifest ?? makeTestAppManifest(options);
  return Effect.gen(function* () {
    // HTTP register → server-minted `{ appId, appKey }`; the `appKey`
    // Connect arm binds the live `AppConnection` as the moderator endpoint.
    const credential = yield* mintTestAppCredential({
      baseUrl: options.baseUrl,
      manifest,
      ...(options.inviteCode !== undefined
        ? { inviteCode: options.inviteCode }
        : {}),
    });
    const client = yield* makeAppTestClient({
      serverUrl: options.wsUrl,
      appKey: credential.appKey,
      defaultTimeoutMs: APP_CLIENT_DEFAULT_TIMEOUT_MS,
    });
    const dispatchAuthorize = yield* makeCallbackScript(
      client,
      DispatchAuthorize,
    );
    const messagesAuthorize = yield* makeCallbackScript(
      client,
      MessagesAuthorize,
    );
    // agent/task/request fires app/task/create before the task
    // leaves `waiting`. Dispatch-admission properties don't gate task
    // creation, so the test app auto-accepts; the dispatch lifecycle
    // is what they exercise.
    yield* client.onAppCallback(TaskCreate, () =>
      Effect.succeed({ verdict: { decision: "accept" as const } }),
    );
    return {
      appId: credential.appId,
      manifest,
      client,
      dispatchAuthorize,
      messagesAuthorize,
    } satisfies TestApp;
  }).pipe(Effect.withSpan("registerTestApp"));
}

/**
 * Build the three required hook policies. A slot with a `*TimeoutMs`
 * option becomes a `{ kind: "hook", timeoutMs }` policy that round-trips
 * to the test app's scripted handler; a slot without one takes its open
 * static policy (`grant` / `forwardAllExceptSender` / `accept`), which
 * the server resolves in-process to the same verdict the app's open
 * handler would return.
 */
function makeManifestHooks(
  options: TestAppManifestOptions,
): AppManifest["hooks"] {
  return {
    dispatch_authorize:
      options.dispatchAuthorizeTimeoutMs === undefined
        ? { kind: "grant" }
        : { kind: "hook", timeoutMs: options.dispatchAuthorizeTimeoutMs },
    message_authorize:
      options.messagesAuthorizeTimeoutMs === undefined
        ? { kind: "forwardAllExceptSender" }
        : { kind: "hook", timeoutMs: options.messagesAuthorizeTimeoutMs },
    task_create:
      options.taskCreateTimeoutMs === undefined
        ? { kind: "accept" }
        : { kind: "hook", timeoutMs: options.taskCreateTimeoutMs },
  };
}

function makeCallbackScript<D extends ServerRpcDefinition>(
  client: AppTestClient,
  definition: D,
): Effect.Effect<TestAppCallbackScript<D>> {
  return Effect.gen(function* () {
    const state = yield* Ref.make<CallbackState<D>>({
      handlers: [],
      silenced: false,
    });
    yield* client.onAppCallback(definition, (params) =>
      runScriptedCallback(state, params),
    );
    return {
      handle: (handler) =>
        Ref.update(state, (current) => ({
          handlers: [...current.handlers, handler],
          silenced: false,
        })),
      silence: Ref.set(state, { handlers: [], silenced: true }),
    } satisfies TestAppCallbackScript<D>;
  });
}

function runScriptedCallback<D extends ServerRpcDefinition>(
  state: Ref.Ref<CallbackState<D>>,
  params: ServerRpcParams<D>,
): Effect.Effect<ServerRpcResult<D>, RpcResponseError> {
  return Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (current.silenced) return yield* Effect.never;
    const handler = current.handlers.find((candidate) =>
      matchesHandler(candidate, params),
    );
    if (handler === undefined) return yield* Effect.never;
    const response = Effect.succeed(handler.respondWith);
    return yield* delayResponse(handler, response);
  });
}

function matchesHandler<D extends ServerRpcDefinition>(
  handler: TestAppCallbackHandler<D>,
  params: ServerRpcParams<D>,
): boolean {
  return handler.predicate === undefined || handler.predicate(params);
}

function delayResponse<D extends ServerRpcDefinition>(
  handler: TestAppCallbackHandler<D>,
  response: Effect.Effect<ServerRpcResult<D>>,
): Effect.Effect<ServerRpcResult<D>> {
  if (handler.holdResponseFor === undefined || handler.holdResponseFor <= 0) {
    return response;
  }
  return Effect.sleep(Duration.millis(handler.holdResponseFor)).pipe(
    Effect.zipRight(response),
  );
}

function uniqueSuffixFragment(): string {
  return globalThis.crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(UNIQUE_SUFFIX_START, UNIQUE_SUFFIX_END);
}
