import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import * as Socket from "@effect/platform/Socket";
import { NodeHttpServer } from "@effect/platform-node";
import {
  Cause,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Match,
  Scope,
} from "effect";

import { logger, LoggerLive } from "../logger.js";
import { NoopTraceCaptureLive } from "../runtime-surface/trace-capture.js";
import type {
  AuthenticatedContext,
  DispatchContext,
  RpcMethodRegistry,
} from "../transport/context.js";
import type { AppTags } from "../transport/layer-tags.js";
import type { ConnIdTag } from "./layers.js";
import type { JsonRpcId, RequestFrame, ResponseFrame } from "@moltzap/protocol";
import {
  JSON_RPC_RESERVED_CODES,
  UnauthorizedError,
  decodeClientInbound,
  encodeErrorResponse,
  makeJsonRpcServer,
} from "@moltzap/protocol";
import { acquireConnectionRpcClient } from "../transport/connection.js";
import { EnvelopeEncryption } from "../crypto/envelope.js";
import {
  CLAIM_NOT_FOUND,
  CLAIM_OWNER_MISMATCH,
  CLAIM_SUCCESS,
} from "../identity/services/auth.service.js";

// Handlers
import { agentsLookupHandlers } from "../identity/handlers/agents-lookup.handlers.js";
import { pingHandlers } from "../network/handlers/ping.handlers.js";
import { connectionId as brandConnectionId } from "../network/agent-endpoint-resolver.js";
import { connectHandlers } from "../task/handlers/connect.handlers.js";
import { conversationHandlers } from "../task/handlers/conversations.handlers.js";
import { messageHandlers } from "../task/handlers/messages.handlers.js";
import { presenceHandlers } from "../task/handlers/presence.handlers.js";
import { contactHandlers } from "../task/handlers/contacts.handlers.js";
import { taskHandlers } from "../task/handlers/tasks.handlers.js";
import { appHandlers } from "./handlers/apps.handlers.js";

import { WebhookClient } from "../adapters/webhook.js";

import type {
  CoreConfig,
  CoreApp,
  ConnectionHook,
  DisconnectionHook,
} from "./types.js";
import {
  AppHostTag,
  ConversationServiceTag,
  DbTag,
  DeliveryWebhookTag,
  EncryptionTag,
  ServicesLive,
  SessionValidatorTag,
  WebhookClientTag,
  resolveServices,
} from "./layers.js";

import { Claim, Connect, Register } from "@moltzap/protocol";

/** Grace period after closing all WebSockets so in-flight sends can flush. */
const SHUTDOWN_DRAIN_MS = 500;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const ERROR_INVALID_JSON = "Invalid JSON";
const ERROR_INVALID_PARAMETERS = "Invalid parameters";
const INVALID_JSON_BODY = Symbol("InvalidJsonBody");

class ServerCloseError extends Data.TaggedError("ServerCloseError")<{
  readonly cause: unknown;
}> {}

const UTF8_DECODER = new TextDecoder("utf-8");

/** Per-connection malformed-frame log rate-limit. Mirrors the client-side
 * pattern so a buggy/hostile peer can't flood the server log. */
const MALFORMED_LOG_EVERY = 50;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Decode the request JSON body and check it against `validator`. On any
 * failure (malformed JSON, schema rejection) returns the appropriate
 * 400 response; on success returns the typed body. Used by the three
 * mounted POST routes (`auth/register`, `auth/claim`,
 * `admin/register-agent`) so they share one pre-flight implementation.
 */
function readValidatedBody<T>(
  request: HttpServerRequest.HttpServerRequest,
  validator: (value: unknown) => value is T,
): Effect.Effect<
  | { readonly _tag: "Body"; readonly body: T }
  | {
      readonly _tag: "Response";
      readonly response: HttpServerResponse.HttpServerResponse;
    }
> {
  return Effect.gen(function* () {
    const body = yield* request.json.pipe(
      Effect.catchAll(() => Effect.succeed(INVALID_JSON_BODY)),
    );
    if (body === INVALID_JSON_BODY) {
      return {
        _tag: "Response" as const,
        response: HttpServerResponse.unsafeJson(
          { error: ERROR_INVALID_JSON },
          { status: HTTP_BAD_REQUEST },
        ),
      };
    }
    if (!validator(body)) {
      return {
        _tag: "Response" as const,
        response: HttpServerResponse.unsafeJson(
          { error: ERROR_INVALID_PARAMETERS },
          { status: HTTP_BAD_REQUEST },
        ),
      };
    }
    return { _tag: "Body" as const, body };
  });
}

/**
 * Constant-time `inviteCode === registrationSecret` check. Returns null
 * when authorization passes (open route when `secret` is unset; correct
 * code when set); otherwise returns a 403 response that the caller
 * should short-circuit on.
 */
function checkInviteCode(
  inviteCode: string | undefined,
  secret: string | undefined,
): HttpServerResponse.HttpServerResponse | null {
  if (!secret) return null;
  if (inviteCode && safeEqual(inviteCode, secret)) return null;
  return HttpServerResponse.unsafeJson(
    { error: "Invalid or missing invite code" },
    { status: HTTP_FORBIDDEN },
  );
}

/** RFC 4122 canonical-string check (any version, any variant). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_HOOK_TIMEOUT_MS = 2_000;

function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runUserHook<TArgs>(
  hook: (args: TArgs) => void | PromiseLike<void>,
  args: TArgs,
  label: string,
  logCtx: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => Promise.resolve(hook(args)),
    catch: (err) => err,
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(USER_HOOK_TIMEOUT_MS),
      onTimeout: () => new Error(`${label} timed out`),
    }),
    Effect.catchAll((err) =>
      Effect.sync(() => {
        logger.error({ err, ...logCtx }, `${label} error`);
      }),
    ),
  );
}

export function createCoreApp(config: CoreConfig): CoreApp {
  const db = config.db;

  // ── Service construction via Effect Layers ──────────────────────────
  // Declarative replacement for the previous `new XxxService(db, logger)`
  // chain. Dependency order is encoded in each Layer's `yield*` — not
  // hand-written here — so adding a new service only requires a new Tag
  // + Layer in layers.ts, no edits to this function.
  const envelope = config.encryptionMasterSecret
    ? new EnvelopeEncryption(config.encryptionMasterSecret)
    : null;

  // A single shared WebhookClient instance handles all outbound HTTP from
  // the core: MessageService.deliveryWebhook plus any contact/user-service
  // adapters layered on top via `setContactService` etc. One semaphore
  // means one place to tune concurrency.
  const webhookClient = config.webhookClient ?? new WebhookClient();

  const BaseLive = Layer.mergeAll(
    Layer.succeed(DbTag, db),
    Layer.succeed(EncryptionTag, envelope),
    Layer.succeed(SessionValidatorTag, config.sessionValidator ?? null),
    Layer.succeed(WebhookClientTag, webhookClient),
    Layer.succeed(DeliveryWebhookTag, config.deliveryWebhook ?? null),
    config.traceCaptureLayer ?? NoopTraceCaptureLive,
    // Provides LoggerTag (pino built from Effect.Config) and replaces the
    // default Effect logger so `Effect.log*` routes through the same stream.
    LoggerLive,
  );

  // provideMerge (vs provide): BaseLive satisfies ServicesLive's Db/Logger/
  // Encryption requirements AND exposes them downstream, so resolveServices
  // can also pull db/logger/encryption from Context without a separate Layer.
  const ServicesWithBase = Layer.provideMerge(ServicesLive, BaseLive);

  // Post-construction wiring: #529 reshape additive wired
  // ConversationService into AppHost so the forked moderator round-trip's
  // deny arm can call `removeParticipant` (architect §3 + epic decision #8).
  // The dependency direction is inverted vs Layer order (ConversationService
  // depends on AppHost), so a post-construction setter is required.
  //
  // `Layer.effectDiscard` sequences the setter call inside the same effectful
  // layer composition as service construction — both AppHost and
  // ConversationService are already built by `ServicesWithBase` when this
  // Layer's Effect runs.
  const WireConvIntoAppHost = Layer.effectDiscard(
    Effect.gen(function* () {
      const appHost = yield* AppHostTag;
      const conversation = yield* ConversationServiceTag;
      appHost.setConversationService(conversation);
    }),
  );

  // FullLive is the composition root: services + the post-construction
  // wiring step. `provideMerge` (vs `provide`): `ServicesWithBase`
  // satisfies `WireConvIntoAppHost`'s `AppHostTag | ConversationServiceTag`
  // inputs AND keeps every service Tag exposed downstream, so the dispatch
  // runtime resolves R for handler-body `yield* XServiceTag` reads.
  const FullLive = Layer.provideMerge(WireConvIntoAppHost, ServicesWithBase);

  // Single `ManagedRuntime` carrying every service Tag. Dispatch fibers
  // (RPC handlers, HTTP routes, WS finalizers) resolve their R-channel
  // structurally via this runtime — no per-frame `Effect.provide`.
  //
  // Service references are extracted once via `resolveServices` for the
  // non-Effect call sites (HTTP routes' synchronous code, the close()
  // teardown sequence, `coreApp.networkSendService` export). Pulling from
  // the runtime guarantees a single instance of each service across the
  // dispatch path and the non-RPC paths.
  const dispatchRuntime = ManagedRuntime.make(
    Layer.mergeAll(NodeHttpServer.layerContext, FullLive),
  );
  const services = dispatchRuntime.runSync(resolveServices);

  const {
    connections,
    agentEndpointResolver,
    networkSendService,
    authService,
    presenceService,
    messageService,
    appHost,
    leaseRegistry,
    traceCapture,
  } = services;

  // Connection hooks
  const connectionHooks: ConnectionHook[] = [];
  const disconnectionHooks: DisconnectionHook[] = [];

  // Descriptor-backed RPC method registry — core handlers + extension methods.
  // Each registry is a top-level const whose `defineXMethod` bindings pull
  // their service Tags from Context at request time.
  const methods: RpcMethodRegistry = [
    ...connectHandlers,
    ...agentsLookupHandlers,
    ...conversationHandlers,
    ...messageHandlers,
    ...presenceHandlers,
    ...appHandlers,
    ...contactHandlers,
    ...taskHandlers,
    ...pingHandlers,
  ];

  const jsonRpcServer = makeJsonRpcServer<
    DispatchContext,
    Exclude<AppTags, ConnIdTag>
  >(methods, logger);

  // ── HTTP routes via @effect/platform HttpRouter ──────────────────────

  const healthRoute = HttpRouter.get(
    "/health",
    Effect.sync(() =>
      HttpServerResponse.unsafeJson({
        status: "ok",
        connections: connections.size,
      }),
    ),
  );

  const registerRoute = HttpRouter.post(
    "/api/v1/auth/register",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const decoded = yield* readValidatedBody(
        request,
        Register.validateParams,
      );
      if (decoded._tag === "Response") return decoded.response;
      const body = decoded.body;

      const denial = checkInviteCode(
        body.inviteCode,
        config.registrationSecret,
      );
      if (denial) return denial;

      const exit = yield* Effect.exit(
        authService.registerAgent(body, config.devModeUserId),
      );
      if (Exit.isSuccess(exit)) {
        // Wire shape matches the protocol's `Register.result`. claimUrl
        // is derived from the request so we don't introduce a new config
        // field for the public base URL.
        const { agentId, apiKey, claimToken } = exit.value;
        const host = request.headers["host"] ?? "localhost";
        const proto =
          request.headers["x-forwarded-proto"]?.split(",")[0]?.trim() ?? "http";
        return HttpServerResponse.unsafeJson(
          {
            agentId,
            apiKey,
            claimToken,
            claimUrl: `${proto}://${host}/api/v1/auth/claim`,
          },
          { status: HTTP_CREATED },
        );
      }
      // registerAgent's error channel is `never`; failures are defects.
      logger.error({ cause: Cause.pretty(exit.cause) }, "Registration failed");
      return HttpServerResponse.unsafeJson(
        { error: "Registration failed" },
        { status: HTTP_INTERNAL_SERVER_ERROR },
      );
    }),
  );

  // Programmatic claim path (sub-issue #486). The protocol-layer
  // `Claim` schema (packages/protocol/src/identity/methods.ts)
  // documents the wire contract — semantics, idempotency, and the
  // `claimToken`-as-credential model. This route is the HTTP surface;
  // the secret-holder model and admin-vs-claim trade-off live in the
  // issue body.
  const claimRoute = HttpRouter.post(
    "/api/v1/auth/claim",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const decoded = yield* readValidatedBody(request, Claim.validateParams);
      if (decoded._tag === "Response") return decoded.response;
      const body = decoded.body;

      const denial = checkInviteCode(
        body.inviteCode,
        config.registrationSecret,
      );
      if (denial) return denial;

      const exit = yield* Effect.exit(
        authService.claimAgent({
          claimToken: body.claimToken,
          ownerUserId: body.ownerUserId,
        }),
      );
      if (Exit.isFailure(exit)) {
        // claimAgent's error channel is `never`; failures are defects.
        logger.error({ cause: Cause.pretty(exit.cause) }, "Claim failed");
        return HttpServerResponse.unsafeJson(
          { error: "Claim failed" },
          { status: HTTP_INTERNAL_SERVER_ERROR },
        );
      }

      const result = exit.value;
      switch (result._tag) {
        case CLAIM_SUCCESS:
          // Refresh `conn.auth.ownerUserId` on every live connection of
          // the just-claimed agent so subsequent owner-gated RPCs on
          // the existing socket no longer see the stale `null` snapshot
          // captured at `network/connect` time (#495). Per-request
          // dispatch reads `conn.auth` fresh (server.ts handleRequestFrame
          // ~L663), so replacing the whole snapshot is sufficient — no
          // restart, no reconnect.
          //
          // Idempotent re-claim (same owner) intentionally still writes:
          // refreshing to the same value is a no-op, and the unconditional
          // write defends against any future code path that could leave a
          // connection stale. AgentId is the natural key — the resolver
          // uses the same one.
          for (const conn of connections.getByAgent(result.agentId)) {
            if (conn.auth === null) continue;
            conn.auth = {
              ...conn.auth,
              ownerUserId:
                result.ownerUserId as AuthenticatedContext["ownerUserId"],
            };
          }
          // 201 = first claim, 200 = idempotent re-claim by same owner.
          return HttpServerResponse.unsafeJson(
            { agentId: result.agentId, ownerUserId: result.ownerUserId },
            { status: result.alreadyClaimed ? HTTP_OK : HTTP_CREATED },
          );
        case CLAIM_NOT_FOUND:
          return HttpServerResponse.unsafeJson(
            { error: "Invalid claim token", code: CLAIM_NOT_FOUND },
            { status: HTTP_UNAUTHORIZED },
          );
        case CLAIM_OWNER_MISMATCH:
          return HttpServerResponse.unsafeJson(
            {
              error: "Agent already claimed by a different owner",
              code: CLAIM_OWNER_MISMATCH,
            },
            { status: HTTP_FORBIDDEN },
          );
        default: {
          // Exhaustiveness gate: a future tag added to ClaimAgentResult
          // forces an update here at compile time (principle 4).
          const _absurd: never = result;
          return _absurd;
        }
      }
    }),
  );

  // Secret-gated admin registration. Accepts `ownerUserId` so the caller
  // can pre-claim the agent at insert time, skipping the post-register
  // `UPDATE agents SET owner_user_id = ...` two-step. The route is mounted
  // only when `config.registrationSecret` is set (see the `httpApp` pipe
  // below) — there's no anonymous admin flow.
  const registrationSecret = config.registrationSecret;
  const adminRegisterAgentRoute = HttpRouter.post(
    "/api/v1/admin/register-agent",
    Effect.gen(function* () {
      // Defense-in-depth: the route is conditionally mounted, but if a
      // future caller wires this route without the secret, fail closed.
      if (!registrationSecret) {
        return HttpServerResponse.unsafeJson(
          { error: "Admin registration unavailable" },
          { status: 404 },
        );
      }

      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(
        Effect.catchAll(() => Effect.succeed(INVALID_JSON_BODY)),
      );
      if (body === INVALID_JSON_BODY) {
        return HttpServerResponse.unsafeJson(
          { error: ERROR_INVALID_JSON },
          { status: HTTP_BAD_REQUEST },
        );
      }

      if (!isStringKeyedRecord(body)) {
        return HttpServerResponse.unsafeJson(
          { error: ERROR_INVALID_PARAMETERS },
          { status: HTTP_BAD_REQUEST },
        );
      }

      // `Register.validateParams` is built from the protocol Register
      // schema with `additionalProperties: false`. Strip ownerUserId
      // before validating the rest of the body against that strict schema.
      const fullBody = body;
      const ownerUserIdRaw = fullBody["ownerUserId"];
      const { ownerUserId, ...registerBody } = fullBody;
      void ownerUserId;

      if (!Register.validateParams(registerBody)) {
        return HttpServerResponse.unsafeJson(
          { error: ERROR_INVALID_PARAMETERS },
          { status: HTTP_BAD_REQUEST },
        );
      }

      const inviteCode = (registerBody as { inviteCode?: string }).inviteCode;
      if (!inviteCode || !safeEqual(inviteCode, registrationSecret)) {
        return HttpServerResponse.unsafeJson(
          { error: "Invalid or missing invite code" },
          { status: 403 },
        );
      }

      let resolvedOwnerUserId: string | undefined;
      if (ownerUserIdRaw !== undefined) {
        if (
          typeof ownerUserIdRaw !== "string" ||
          !UUID_RE.test(ownerUserIdRaw)
        ) {
          return HttpServerResponse.unsafeJson(
            { error: "ownerUserId must be a UUID" },
            { status: HTTP_BAD_REQUEST },
          );
        }
        resolvedOwnerUserId = ownerUserIdRaw;
      }

      const exit = yield* Effect.exit(
        authService.upsertAgent(
          registerBody as Parameters<typeof authService.upsertAgent>[0],
          // Explicit body owner wins; dev-mode auto-owner is the fallback.
          resolvedOwnerUserId ?? config.devModeUserId,
        ),
      );
      if (Exit.isFailure(exit)) {
        logger.error(
          { cause: Cause.pretty(exit.cause) },
          "Admin upsert failed",
        );
        return HttpServerResponse.unsafeJson(
          { error: "Registration failed" },
          { status: 500 },
        );
      }
      const result = exit.value;
      if ("_tag" in result) {
        return HttpServerResponse.unsafeJson(
          { error: "Registration conflict", code: "REGISTRATION_CONFLICT" },
          { status: 409 },
        );
      }
      // 200 = rotated existing row, 201 = newly inserted. The status code
      // is the on-the-wire `rotated` signal; body shape stays unchanged.
      return HttpServerResponse.unsafeJson(
        { agentId: result.agentId, apiKey: result.apiKey },
        { status: result.rotated ? HTTP_OK : HTTP_CREATED },
      );
    }),
  );

  const allowedOriginsPredicate = (origin: string): boolean => {
    if (config.corsOrigins.includes("*")) return true;
    if (config.corsOrigins.includes(origin)) return true;
    logger.warn({ origin }, "CORS origin rejected");
    return false;
  };

  /** Handle a freshly-upgraded socket: network/connect → RPC dispatch → close.
   * Lives inside the per-request fiber; returning exits the connection. */
  const handleSocket = (
    socket: Socket.Socket,
  ): Effect.Effect<void, Socket.SocketError, Exclude<AppTags, ConnIdTag>> =>
    Effect.scoped(
      Effect.gen(function* () {
        const connId = crypto.randomUUID();
        const writer = yield* socket.writer;
        const closeRequested = yield* Deferred.make<void>();

        let malformedFrameCount = 0;

        const write = (raw: string) => writer(raw);
        const sendFrame = (obj: unknown) =>
          write(JSON.stringify(obj)).pipe(
            Effect.catchAll((err) =>
              Effect.sync(() =>
                logger.warn({ err, connId }, "socket write failed"),
              ),
            ),
          );

        // Allocate this connection's `JsonRpcClient` (originator side of
        // the server→client appCallback channel). Scope-bound: the
        // finalizer fails every still-pending Deferred with
        // `NotConnectedError` when the socket closes.
        const jsonRpcClient = yield* acquireConnectionRpcClient(connId, write);

        connections.add({
          id: connId,
          write,
          shutdown: Deferred.succeed(closeRequested, undefined).pipe(
            Effect.asVoid,
          ),
          auth: null,
          lastPong: Date.now(),
          conversationIds: new Set(),
          mutedConversations: new Set(),
          jsonRpcClient,
        });
        logger.info({ connId }, "WebSocket connected");

        const sendInvalidRequest = (id: JsonRpcId | null) =>
          sendFrame(
            encodeErrorResponse(id, {
              code: JSON_RPC_RESERVED_CODES.InvalidRequest,
              message: "Invalid request frame",
            }),
          );

        const handleParseFailure = (err: unknown) => {
          const n = ++malformedFrameCount;
          if (n === 1 || n % MALFORMED_LOG_EVERY === 0) {
            logger.warn(
              { err, connId, count: n },
              "Failed to parse WebSocket frame",
            );
          }
          return sendFrame(
            encodeErrorResponse(null, {
              code: JSON_RPC_RESERVED_CODES.ParseError,
              message: ERROR_INVALID_JSON,
            }),
          );
        };

        const handleResponseFrame = (frame: ResponseFrame) =>
          Effect.gen(function* () {
            const conn = connections.get(connId);
            if (!conn) return;
            const matched = yield* conn.jsonRpcClient.resolve(frame);
            if (!matched) {
              logger.warn(
                { connId, id: frame.id },
                "no pending appCallback request matched inbound response",
              );
            }
          });

        const fireConnectionHooks = Effect.gen(function* () {
          const authCtx = connections.get(connId)?.auth;
          if (!authCtx) return;
          const { agentId, ownerUserId } = authCtx;
          const agentRow = yield* Effect.tryPromise(() =>
            db
              .selectFrom("agents")
              .select("name")
              .where("id", "=", agentId)
              .executeTakeFirst(),
          ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
          const agentName = agentRow?.name ?? agentId;
          for (const hook of connectionHooks) {
            yield* runUserHook(
              hook,
              { agentId, agentName, ownerUserId, connId },
              "Connection hook",
              { agentId, connId },
            );
          }
        });

        const handleRequestFrame = (frame: RequestFrame) =>
          Effect.gen(function* () {
            const conn = connections.get(connId);
            if (!conn) return;
            const isConnect = frame.method === Connect.name;
            if (!isConnect && !conn.auth) {
              yield* sendFrame(
                encodeErrorResponse(frame.id, {
                  code: UnauthorizedError.code,
                  message: "Not authenticated. Send network/connect first.",
                }),
              );
              return;
            }
            const auth = conn.auth ?? ({} as AuthenticatedContext);
            // Phase 2A r2 §3: dispatcher's `handle` carries
            // `Exclude<AppTags, ConnIdTag>` in its R-channel (handlers
            // may yield service Tags after the DI migration). The
            // dispatch fiber's runtime (built below from `FullLive`)
            // resolves R structurally; no per-frame `Effect.provide`.
            const response = yield* jsonRpcServer.handle(frame, {
              auth,
              connId,
            });
            yield* sendFrame(response);
            if (isConnect) yield* fireConnectionHooks;
          });

        const handleFrame = (raw: string) =>
          Effect.gen(function* () {
            if (!connections.get(connId)) return;

            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch (err) {
              yield* handleParseFailure(err);
              return;
            }

            yield* decodeClientInbound(parsed).pipe(
              Effect.flatMap((decoded) =>
                Match.value(decoded).pipe(
                  Match.tag("ResponseSuccess", ({ id, result }) =>
                    handleResponseFrame({
                      jsonrpc: "2.0",
                      id,
                      result,
                    } as ResponseFrame),
                  ),
                  Match.tag("ResponseError", ({ id, error }) =>
                    handleResponseFrame({
                      jsonrpc: "2.0",
                      id,
                      error,
                    } as ResponseFrame),
                  ),
                  Match.tag("Notification", () => sendInvalidRequest(null)),
                  Match.tag("ClientRequest", ({ definition, params, id }) =>
                    handleRequestFrame(
                      definition.encodeRequest(id, params) as RequestFrame,
                    ),
                  ),
                  Match.exhaustive,
                ),
              ),
              Effect.catchTag("MalformedFrameError", () =>
                sendInvalidRequest(null),
              ),
            );
          });

        const reader = socket.runRaw((data) =>
          handleFrame(
            typeof data === "string" ? data : UTF8_DECODER.decode(data),
          ),
        );

        // `raceFirst` so an abnormal close (reader fails before anyone calls
        // `conn.shutdown`) doesn't hang on the still-pending `closeRequested`.
        // With `race`, onExit never fires on abrupt disconnects and the
        // connection leaks in the manager.
        yield* Effect.raceFirst(reader, Deferred.await(closeRequested)).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const conn = connections.get(connId);
              const authCtx = conn?.auth ?? null;
              if (authCtx) presenceService.setOffline(authCtx.agentId);
              // Run sequentially so an earlier hook's cleanup (e.g.
              // `last_seen_at`) completes before the next hook observes
              // the post-close state.
              if (authCtx) {
                const { agentId, ownerUserId } = authCtx;
                for (const hook of disconnectionHooks) {
                  yield* runUserHook(
                    hook,
                    { agentId, ownerUserId, connId },
                    "Disconnection hook",
                    { agentId, connId },
                  );
                }
              }
              // Slice G1 (plan §2.11): remove the connection's endpoint
              // address from the resolver. Skipped for never-authed
              // connections — `network/connect` is the single registration
              // site, so an unauthed disconnect has nothing to clean up
              // and would not have an `agentId` to address the entry by.
              if (authCtx) {
                yield* agentEndpointResolver.remove(
                  authCtx.agentId,
                  brandConnectionId(connId),
                );
              }
              // #529 reshape: drain leases bound to this recipient
              // connection. PENDING → ABANDONED + GRANTED/HOLD →
              // EXPIRED-on-disconnect; CLAIMED is a load-bearing no-op
              // (rule 2 — in-flight `messages/send` owns the lease via
              // acquireUseRelease). Errors are absorbed inside `abandon`.
              yield* leaseRegistry.abandon(connId);
              presenceService.removeConnection(connId);
              connections.remove(connId);
              if (Exit.isFailure(exit)) {
                logger.warn(
                  { connId, cause: Cause.pretty(exit.cause) },
                  "WebSocket error",
                );
              }
              logger.info({ connId }, "WebSocket disconnected");
            }),
          ),
        );
      }),
    );

  const wsRoute = HttpRouter.get(
    "/ws",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* req.upgrade;
      yield* handleSocket(socket);
      return HttpServerResponse.empty();
    }).pipe(
      Effect.catchAll((err) => {
        logger.warn({ err }, "WS upgrade failed");
        return HttpServerResponse.empty({ status: HTTP_BAD_REQUEST });
      }),
    ),
  );

  // `skipDefaultRegisterRoute` lets apps opt out of core's default register
  // handler so they can mount their own invite-gated / rate-limited flow.
  // The admin route is mounted only when (a) the default register flow
  // is in use AND (b) a `registrationSecret` is configured. Without the
  // secret there's no admin credential, so the route is absent — turning
  // "no secret = no admin route" into a router-level invariant.
  // The claim route (#486) is mounted alongside register; its own
  // `registrationSecret` gate is evaluated per-request.
  const adminRouteEnabled =
    !config.skipDefaultRegisterRoute && config.registrationSecret !== undefined;
  const httpApp = (
    config.skipDefaultRegisterRoute
      ? HttpRouter.empty.pipe(healthRoute, wsRoute)
      : adminRouteEnabled
        ? HttpRouter.empty.pipe(
            healthRoute,
            registerRoute,
            claimRoute,
            adminRegisterAgentRoute,
            wsRoute,
          )
        : HttpRouter.empty.pipe(healthRoute, registerRoute, claimRoute, wsRoute)
  ).pipe(
    HttpMiddleware.cors({
      allowedOrigins: allowedOriginsPredicate,
    }),
  );

  // Server lifecycle: `NodeHttpServer.make` acquires an http.Server inside a
  // Scope we own (`appScope`); closing the scope on shutdown tears down the
  // listener, the wired upgrade handler, and any per-connection fibers.
  //
  // Phase 2A r2 §3: the dispatch fibers run with `FullLive` in scope so
  // RPC handler bodies that `yield* XServiceTag` resolve via the
  // managed runtime rather than via per-frame `Effect.provide`. The
  // `BaseLive`-wired services (Db, Encryption, SessionValidator,
  // WebhookClient, DeliveryWebhook, TraceCapture, Logger) come along
  // for free since `FullLive` composes `ServicesLive` over `BaseLive`.
  const appScope = Effect.runSync(Scope.make());

  let actualPort = config.port;
  const startup = Effect.gen(function* () {
    const serverSvc = yield* NodeHttpServer.make(() => http.createServer(), {
      port: config.port,
      host: "0.0.0.0",
    });
    yield* serverSvc.serve(httpApp);
    const addr = serverSvc.address;
    actualPort = addr._tag === "TcpAddress" ? addr.port : config.port;
    logger.info({ port: actualPort }, "MoltZap core server listening");
  }).pipe(Scope.extend(appScope));

  dispatchRuntime.runPromise(startup).catch((err) => {
    logger.error({ err }, "Server startup failed");
  });

  return {
    get port() {
      return actualPort;
    },
    registerRpcMethod(method) {
      methods.push(method);
    },
    onConnection(hook: ConnectionHook) {
      connectionHooks.push(hook);
    },
    onDisconnection(hook: DisconnectionHook) {
      disconnectionHooks.push(hook);
    },
    networkSendService,
    traceCapture,
    connections,
    leaseRegistry,
    registerApp(manifest) {
      appHost.registerApp(manifest);
    },
    registerRemoteApp(manifest, connectionId) {
      appHost.registerRemoteApp(manifest, connectionId);
    },
    unregisterRemoteApp(appId) {
      appHost.unregisterRemoteApp(appId);
    },
    setContactService(checker) {
      appHost.setContactService(checker);
    },
    onTaskAuthorizeDispatch(appId, handler) {
      appHost.onTaskAuthorizeDispatch(appId, handler);
    },
    close() {
      return Effect.runPromise(
        Effect.gen(function* () {
          // Interrupt in-flight delivery-webhook retries before scope close so
          // pending POSTs don't race the HTTP server teardown.
          yield* messageService.close();
          // `appHost.destroy()` runs before connections close, so any RPC
          // in-flight may observe cleared manifests. The drain sleep below is
          // the only mitigation today — tracked in /review output 2026-04-16.
          appHost.destroy();
          for (const conn of connections.all()) {
            yield* conn.shutdown;
          }
          yield* Effect.sleep(Duration.millis(SHUTDOWN_DRAIN_MS));
          // Closing appScope tears down the http.Server + upgrade wiring.
          yield* Scope.close(appScope, Exit.void);
          yield* Effect.tryPromise({
            try: () => dispatchRuntime.dispose(),
            catch: (cause) => new ServerCloseError({ cause }),
          });
          const dbCleanup = config.dbCleanup;
          if (dbCleanup) {
            yield* Effect.tryPromise({
              try: () => dbCleanup(),
              catch: (cause) => new ServerCloseError({ cause }),
            });
          }
        }),
      );
    },
  };
}
