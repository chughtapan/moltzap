/**
 * TestApp — protocol-level app fixture for conformance tests.
 *
 * A TestApp is a registered app manifest plus scripted handlers for
 * server-initiated app callbacks. It deliberately stays above
 * `TestClient` and below app-domain scenario drivers: it knows how to
 * register `apps/register` and how to answer `dispatch/authorize` /
 * `messages/authorize`, but it does not know about tasks, leases, or
 * conversations beyond manifest defaults.
 */
import { Data, Duration, Effect, Ref } from "effect";
import {
  AppsRegister,
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
  type AppManifest,
} from "../../../app/index.js";
import type {
  ServerRpcDefinition,
  ServerRpcParams,
  ServerRpcResult,
  TestClient,
} from "./driver/test-client.js";
import type { FrameSchemaError } from "./frame-mutator.js";
import type {
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "./errors.js";

const UNIQUE_SUFFIX_START = 2;
const UNIQUE_SUFFIX_END = 8;

const DEFAULT_CONVERSATIONS: NonNullable<AppManifest["conversations"]> = [
  { key: "main", name: "Main", participantFilter: "all" },
];

export class TestAppRegistrationError extends Data.TaggedError(
  "TestingAppRegistrationError",
)<{
  readonly appId: string;
  readonly actualAppId: string;
  readonly message: string;
}> {}

export type TestAppRegistrationFailure =
  | TestAppRegistrationError
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError
  | FrameSchemaError;

export interface TestAppManifestOptions {
  readonly appId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly conversations?: AppManifest["conversations"];
  readonly dispatchAuthorizeTimeoutMs?: number;
  readonly messagesAuthorizeTimeoutMs?: number;
}

export interface RegisterTestAppOptions extends TestAppManifestOptions {
  readonly client: TestClient;
  readonly manifest?: AppManifest;
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
  readonly appId: string;
  readonly manifest: AppManifest;
  readonly client: TestClient;
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
    ...(hooks === undefined ? {} : { hooks }),
  };
}

export function registerTestApp(
  options: RegisterTestAppOptions,
): Effect.Effect<TestApp, TestAppRegistrationFailure> {
  const manifest = options.manifest ?? makeTestAppManifest(options);
  return Effect.gen(function* () {
    const registered = yield* options.client.sendRpc(AppsRegister, {
      manifest,
    });
    yield* assertRegisteredAppId(manifest, registered.appId);
    const dispatchAuthorize = yield* makeCallbackScript(
      options.client,
      DispatchAuthorize,
    );
    const messagesAuthorize = yield* makeCallbackScript(
      options.client,
      MessagesAuthorize,
    );
    // task/request fires a task/create TM callback before the task
    // leaves `waiting`. Dispatch-admission properties don't gate task
    // creation, so the test app auto-accepts; the dispatch lifecycle
    // is what they exercise.
    yield* options.client.onAppCallback(TaskCreate, () =>
      Effect.succeed({ verdict: { decision: "accept" as const } }),
    );
    return {
      appId: manifest.appId,
      manifest,
      client: options.client,
      dispatchAuthorize,
      messagesAuthorize,
    } satisfies TestApp;
  }).pipe(Effect.withSpan("registerTestApp"));
}

function makeManifestHooks(
  options: TestAppManifestOptions,
): AppManifest["hooks"] {
  const hooks: NonNullable<AppManifest["hooks"]> = {};
  if (options.dispatchAuthorizeTimeoutMs !== undefined) {
    hooks.dispatch_authorize = {
      timeout_ms: options.dispatchAuthorizeTimeoutMs,
    };
  }
  if (options.messagesAuthorizeTimeoutMs !== undefined) {
    hooks.message_authorize = {
      timeout_ms: options.messagesAuthorizeTimeoutMs,
    };
  }
  return Object.keys(hooks).length === 0 ? undefined : hooks;
}

function makeCallbackScript<D extends ServerRpcDefinition>(
  client: TestClient,
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

function assertRegisteredAppId(
  manifest: AppManifest,
  registeredAppId: string,
): Effect.Effect<void, TestAppRegistrationError> {
  if (registeredAppId === manifest.appId) return Effect.void;
  return Effect.fail(
    new TestAppRegistrationError({
      appId: manifest.appId,
      actualAppId: registeredAppId,
      message: `apps/register returned ${registeredAppId}; expected ${manifest.appId}`,
    }),
  );
}

function uniqueSuffixFragment(): string {
  return globalThis.crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(UNIQUE_SUFFIX_START, UNIQUE_SUFFIX_END);
}
