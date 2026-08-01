/** @file Scoped principal access to one OpenClaw gateway process. */

import type { ExitCode } from "@effect/platform/CommandExecutor";
import type { AgentName } from "@moltzap/protocol/identity";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
import {
  Deferred,
  Duration,
  Effect,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import type { OpenClawProcessSession } from "./process.js";

const OPENCLAW_GATEWAY_CLIENT_STOP_TIMEOUT_MS = 1_000;
const OPENCLAW_GATEWAY_PAYLOAD_MAX_COUNT = 16;
const OPENCLAW_GATEWAY_TEXT_MAX_LENGTH = 32 * 1_024;
const OPENCLAW_GATEWAY_MEDIA_URL_MAX_LENGTH = 8 * 1_024;
const OPENCLAW_GATEWAY_MEDIA_URL_MAX_COUNT = 16;

const openClawGatewayText = Schema.String.pipe(
  Schema.maxLength(OPENCLAW_GATEWAY_TEXT_MAX_LENGTH),
);
const openClawGatewayMediaUrl = Schema.String.pipe(
  Schema.maxLength(OPENCLAW_GATEWAY_MEDIA_URL_MAX_LENGTH),
);

class OpenClawGatewayPayload extends Schema.Class<OpenClawGatewayPayload>(
  "OpenClawGatewayPayload",
)({
  text: Schema.optional(openClawGatewayText),
  mediaUrl: Schema.optional(Schema.NullOr(openClawGatewayMediaUrl)),
  mediaUrls: Schema.optional(
    Schema.Array(openClawGatewayMediaUrl).pipe(
      Schema.maxItems(OPENCLAW_GATEWAY_MEDIA_URL_MAX_COUNT),
    ),
  ),
  isError: Schema.optional(Schema.Boolean),
  isReasoning: Schema.optional(Schema.Boolean),
}) {}

class OpenClawGatewayResult extends Schema.Class<OpenClawGatewayResult>(
  "OpenClawGatewayResult",
)({
  payloads: Schema.optional(
    Schema.Array(OpenClawGatewayPayload).pipe(
      Schema.maxItems(OPENCLAW_GATEWAY_PAYLOAD_MAX_COUNT),
    ),
  ),
}) {}

/** Principal instruction accepted by OpenClaw's native `agent` RPC. */
export class OpenClawGatewayRequest extends Schema.Class<OpenClawGatewayRequest>(
  "OpenClawGatewayRequest",
)({
  message: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
  sessionKey: Schema.optional(Schema.NonEmptyString),
  thinking: Schema.optional(Schema.NonEmptyString),
  timeout: Schema.optional(Schema.NonNegativeInt),
  label: Schema.optional(Schema.NonEmptyString),
  extraSystemPrompt: Schema.optional(Schema.NonEmptyString),
}) {}

const openClawTimeoutPhase = Schema.Literal(
  "queue",
  "preflight",
  "provider",
  "post_turn",
  "gateway_draining",
);

/**
 * Successful terminal projection returned by OpenClaw's native `agent` RPC.
 */
export class OpenClawGatewaySucceeded extends Schema.Class<OpenClawGatewaySucceeded>(
  "OpenClawGatewaySucceeded",
)({
  runId: Schema.NonEmptyString,
  status: Schema.Literal("ok"),
  summary: Schema.Literal("completed"),
  result: OpenClawGatewayResult,
}) {}

/**
 * Timed-out terminal projection returned by OpenClaw's native `agent` RPC.
 *
 * OpenClaw treats this as a successful RPC payload rather than a transport
 * failure. A run may time out before it has an agent result.
 */
export class OpenClawGatewayTimedOut extends Schema.Class<OpenClawGatewayTimedOut>(
  "OpenClawGatewayTimedOut",
)({
  runId: Schema.NonEmptyString,
  status: Schema.Literal("timeout"),
  summary: Schema.Literal("aborted"),
  stopReason: Schema.optional(Schema.String),
  timeoutPhase: Schema.optional(openClawTimeoutPhase),
  providerStarted: Schema.optional(Schema.Boolean),
  result: Schema.optional(OpenClawGatewayResult),
}) {}

/** Schema for the exact terminal response returned by the native `agent` RPC. */
// eslint-disable-next-line @typescript-eslint/naming-convention, agent-code-guard/no-exported-brand-constructor -- evaluation event schemas compose this closed native response at their publication boundary.
export const OpenClawGatewayResponse = Schema.Union(
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
);

/** Exact terminal response returned by OpenClaw's native `agent` RPC. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- the value is the runtime Schema and the type is its decoded result.
export type OpenClawGatewayResponse = typeof OpenClawGatewayResponse.Type;

/** A native OpenClaw gateway call failed or returned an invalid payload. */
export class OpenClawGatewayRequestFailed extends Schema.TaggedError<OpenClawGatewayRequestFailed>()(
  "OpenClawGatewayRequestFailed",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `OpenClaw gateway request failed: ${this.detail}`;
  }
}

/** Principal gateway exposed by an acquired OpenClaw runtime. */
export interface OpenClawGateway {
  readonly agent: (
    request: OpenClawGatewayRequest,
  ) => Effect.Effect<OpenClawGatewayResponse, OpenClawGatewayRequestFailed>;
}

interface OpenClawAgentRequestParameters {
  readonly message: string;
  readonly idempotencyKey: string;
  readonly deliver: false;
  readonly agentId: AgentName;
  readonly sessionKey?: string;
  readonly thinking?: string;
  readonly timeout?: number;
  readonly label?: string;
  readonly extraSystemPrompt?: string;
}

type GatewayClientOptions = ConstructorParameters<typeof GatewayClient>[0];
type GatewayClientRequestOptions = Parameters<GatewayClient["request"]>[2];

/**
 * Narrow client contract used by lifecycle tests.
 * @internal
 */
export interface OpenClawGatewayClient {
  readonly start: GatewayClient["start"];
  readonly stop: GatewayClient["stop"];
  readonly stopAndWait: GatewayClient["stopAndWait"];
  readonly request: (
    method: string,
    params?: unknown,
    options?: GatewayClientRequestOptions,
  ) => ReturnType<GatewayClient["request"]>;
}

/**
 * Constructor seam for the public OpenClaw gateway client.
 * @internal
 */
export type OpenClawGatewayClientFactory = (
  options: GatewayClientOptions,
) => OpenClawGatewayClient;

const makeNativeGatewayClient: OpenClawGatewayClientFactory = (options) =>
  new GatewayClient(options);

function gatewayConnectionFailure(detail: string): Error {
  return new Error(detail);
}

function processStoppedBeforeHello(
  exitCode: Effect.Effect<ExitCode, unknown>,
): Effect.Effect<never, Error> {
  return exitCode.pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.fail(
          gatewayConnectionFailure(
            "OpenClaw stopped before its principal gateway exposed a hello response",
          ),
        ),
      onSuccess: (code) =>
        Effect.fail(
          gatewayConnectionFailure(
            `OpenClaw exited before its principal gateway exposed a hello response (exitCode=${String(code)})`,
          ),
        ),
    }),
  );
}

function closeGatewayClient(
  client: OpenClawGatewayClient,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () =>
      client.stopAndWait({
        timeoutMs: OPENCLAW_GATEWAY_CLIENT_STOP_TIMEOUT_MS,
      }),
    catch: () => undefined,
  }).pipe(
    Effect.catchAll(() =>
      Effect.try({
        try: () => {
          client.stop();
        },
        catch: () => undefined,
      }).pipe(Effect.ignore),
    ),
  );
}

function startGatewayClient(
  client: OpenClawGatewayClient,
  within: Duration.Duration,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: (signal) =>
      startGatewayClientWhenEventLoopReady(client, {
        timeoutMs: Duration.toMillis(within),
        signal,
      }),
    catch: (cause) =>
      gatewayConnectionFailure(
        `could not start the OpenClaw gateway client: ${String(cause)}`,
      ),
  }).pipe(
    Effect.flatMap((readiness) =>
      Effect.if(readiness.ready, {
        onTrue: () => Effect.void,
        onFalse: () => {
          const detail = readiness.aborted
            ? "OpenClaw gateway client startup was interrupted"
            : "the event loop was not ready to start the OpenClaw gateway client";
          return Effect.fail(gatewayConnectionFailure(detail));
        },
      }),
    ),
  );
}

function agentRequestParameters(
  request: OpenClawGatewayRequest,
  agentName: AgentName,
): OpenClawAgentRequestParameters {
  return {
    message: request.message,
    idempotencyKey: request.idempotencyKey,
    deliver: false,
    agentId: agentName,
    ...(request.sessionKey === undefined
      ? {}
      : { sessionKey: request.sessionKey }),
    ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
    ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.extraSystemPrompt === undefined
      ? {}
      : { extraSystemPrompt: request.extraSystemPrompt }),
  };
}

function makeOpenClawGateway(
  client: OpenClawGatewayClient,
  agentName: AgentName,
): OpenClawGateway {
  return Object.freeze({
    agent: (request: OpenClawGatewayRequest) =>
      Effect.tryPromise({
        try: (signal) =>
          client.request("agent", agentRequestParameters(request, agentName), {
            expectFinal: true,
            timeoutMs: null,
            signal,
          }),
        catch: (cause) =>
          OpenClawGatewayRequestFailed.make({
            detail: String(cause),
          }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknown(OpenClawGatewayResponse)),
        Effect.mapError((cause) =>
          cause instanceof OpenClawGatewayRequestFailed
            ? cause
            : OpenClawGatewayRequestFailed.make({
                detail: `invalid terminal agent response: ${String(cause)}`,
              }),
        ),
        Effect.withSpan("OpenClawGateway.agent"),
      ),
  });
}

/**
 * Connect a persistent OpenClaw client, await its protocol hello, and retain
 * it in the process Scope.
 * @param session Running OpenClaw process and private gateway credentials.
 * @param within Runtime-owned startup deadline.
 * @param makeClient Constructor seam used by focused lifecycle tests.
 * @returns The runtime-native principal gateway.
 * @internal
 */
export function acquireOpenClawGatewayWith(
  session: OpenClawProcessSession,
  within: Duration.Duration,
  makeClient: OpenClawGatewayClientFactory,
): Effect.Effect<OpenClawGateway, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const hello = yield* Deferred.make<undefined>();
    // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned Effect requires Scope, so its caller owns this finalizer.
    const client = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          makeClient({
            url: session.gatewayUrl,
            token: Redacted.value(session.gatewayToken),
            clientName: "gateway-client",
            clientDisplayName: "MoltZap simulator",
            mode: "backend",
            role: "operator",
            scopes: ["operator.write"],
            deviceIdentity: null,
            onHelloOk: () => {
              Effect.runSync(Deferred.succeed(hello, undefined));
            },
          }),
        catch: (cause) =>
          gatewayConnectionFailure(
            `could not construct the OpenClaw gateway client: ${String(cause)}`,
          ),
      }),
      closeGatewayClient,
    );
    const ready = startGatewayClient(client, within).pipe(
      Effect.zipRight(Deferred.await(hello)),
      Effect.raceFirst(processStoppedBeforeHello(session.exitCode)),
      Effect.timeoutFail({
        duration: within,
        onTimeout: () =>
          gatewayConnectionFailure(
            `OpenClaw principal gateway did not expose a hello response within ${Duration.format(within)}`,
          ),
      }),
    );
    yield* ready;
    return makeOpenClawGateway(client, session.agentName);
  }).pipe(Effect.withSpan("OpenClawGateway.acquire"));
}

/**
 * Acquire the production OpenClaw principal gateway.
 * @param session Running OpenClaw process and private gateway credentials.
 * @param within Runtime-owned startup deadline.
 * @returns The scoped native principal gateway.
 */
export function acquireOpenClawGateway(
  session: OpenClawProcessSession,
  within: Duration.Duration,
): Effect.Effect<OpenClawGateway, Error, Scope.Scope> {
  return acquireOpenClawGatewayWith(session, within, makeNativeGatewayClient);
}
