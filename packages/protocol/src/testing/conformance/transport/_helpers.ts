/**
 * Transport-layer helpers shared by adversity properties (latency,
 * slicer, reset-peer, timeout, slow-close).
 *
 * Carved from `conformance/adversity.ts@961a5c8`. Body verbatim; only
 * import paths shift to the new layer location.
 */
import type { Static } from "@sinclair/typebox";
import { Effect, type Scope } from "effect";
import type { ToxiproxyProxy } from "../../toxics/client.js";
import type { ToxicProfile } from "../../toxics/profile.js";
import {
  makeTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "../_shared/registry.js";
import { ConversationsCreate, ConversationId } from "@moltzap/protocol/task";
import { conversationId } from "../_shared/test-fixtures.js";

export const ADVERSITY_CATEGORY = "adversity" as const;
export const DEFAULT_CAPTURE_CAPACITY = 128;
const RANDOM_SUFFIX_LENGTH = 6;
const PROPERTY_BUDGET_MS = 15_000;

type ConversationIdValue = Static<typeof ConversationId>;

export function adversityViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation {
  return new PropertyInvariantViolation({
    category: ADVERSITY_CATEGORY,
    name,
    reason,
  });
}

function randomIdSuffix(): string {
  return globalThis.crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, RANDOM_SUFFIX_LENGTH);
}

export function proxyName(prefix: string, seed: number): string {
  return `${prefix}-${seed}-${randomIdSuffix()}`;
}

function hostPortFromWebSocketUrl(wsUrl: string): string {
  return new URL(wsUrl).host;
}

/** Acquire a TestClient that routes through the Toxiproxy proxy. */
export function acquireProxiedClient(
  ctx: ConformanceRunContext,
  proxy: ToxiproxyProxy,
  name: string,
  defaultTimeoutMs: number,
  unavailable: (reason: string) => PropertyUnavailable,
): Effect.Effect<
  { agent: TestAgent; client: TestClient },
  PropertyUnavailable,
  Scope.Scope
> {
  // Preserve the upstream path (e.g., `/ws`) when building the
  // proxy-facing URL: Toxiproxy is a raw TCP forwarder, so the client's
  // upgrade path must match what the server's HTTP router expects.
  const upstreamPath = new URL(ctx.realServer.wsUrl).pathname;
  const proxiedUrl = `${proxy.listenUrl}${upstreamPath}`;
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name,
    }).pipe(Effect.mapError((e) => unavailable(`register: ${e.body}`)));
    const client = yield* makeTestClient({
      serverUrl: proxiedUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) => unavailable(`makeTestClient: ${String(e)}`)),
    );
    return { agent, client };
  }).pipe(Effect.withSpan("acquireProxiedClient"));
}

/**
 * Body params — `attachToxic` attaches the toxic inside the caller's
 * scope. Nesting matters: the caller typically does
 *
 *   Effect.scoped(gen(function* () {
 *     const client = yield* acquireProxiedClient(...)  // outer
 *     yield* Effect.scoped(gen(function* () {
 *       yield* attachToxic                             // inner
 *       yield* assertion(client)
 *     }))                                              // toxic removed
 *   }))                                                // client close OK
 *
 * so the toxic is removed BEFORE TestClient's socket close. Under
 * disruptive toxics (timeout, reset_peer), this lets the WS close
 * handshake flow cleanly instead of hanging on a black-holed channel.
 */
export type ToxicBodyParams = {
  readonly proxy: ToxiproxyProxy;
  readonly unavailable: (reason: string) => PropertyUnavailable;
  readonly attachToxic: Effect.Effect<void, PropertyUnavailable, Scope.Scope>;
};

/**
 * Factory — wire a Toxiproxy proxy + attach the toxic; hand a body the
 * proxy. Hard-deadlines each property body so a hanging toxic can't
 * block the suite indefinitely; if the deadline fires, the property
 * reports `PropertyUnavailable` (not a pass, not a crash).
 */
export function withToxicProxy(opts: {
  readonly ctx: ConformanceRunContext;
  readonly propertyName: string;
  readonly description: string;
  readonly proxyName: string;
  readonly profile: ToxicProfile;
  readonly body: (
    params: ToxicBodyParams,
  ) => Effect.Effect<
    void,
    PropertyUnavailable | PropertyInvariantViolation,
    Scope.Scope
  >;
}): void {
  const { ctx, propertyName, description, proxyName, profile, body } = opts;
  const toxiproxy = ctx.toxiproxy;
  const run: Effect.Effect<
    void,
    PropertyUnavailable | PropertyInvariantViolation
  > =
    toxiproxy === null
      ? Effect.fail(
          new PropertyUnavailable({
            category: ADVERSITY_CATEGORY,
            name: propertyName,
            reason: "Toxiproxy client not provisioned for this run",
          }),
        )
      : (() => {
          const upstreamHostPort = hostPortFromWebSocketUrl(
            ctx.realServer.wsUrl,
          );
          const unavailable = (reason: string): PropertyUnavailable =>
            new PropertyUnavailable({
              category: ADVERSITY_CATEGORY,
              name: propertyName,
              reason,
            });
          return Effect.scoped(
            Effect.gen(function* () {
              const proxy = yield* toxiproxy
                .proxy({ name: proxyName, upstream: upstreamHostPort })
                .pipe(Effect.mapError((e) => unavailable(`proxy: ${e.body}`)));
              const attachToxic: ToxicBodyParams["attachToxic"] = proxy
                .withToxic(profile)
                .pipe(
                  Effect.mapError((e) => unavailable(`toxic: ${e.body}`)),
                  Effect.asVoid,
                );
              yield* body({ proxy, unavailable, attachToxic });
            }),
          ).pipe(
            Effect.timeoutFail({
              duration: `${PROPERTY_BUDGET_MS} millis`,
              onTimeout: () =>
                unavailable(
                  `property exceeded ${PROPERTY_BUDGET_MS}ms budget under toxic`,
                ),
            }),
          );
        })();
  registerProperty(
    ctx,
    ADVERSITY_CATEGORY,
    propertyName,
    description,
    run.pipe(Effect.withSpan("withToxicProxy")),
  );
}

export function createOneOnOneConversation(
  owner: { agent: TestAgent; client: TestClient },
  participant: { agent: TestAgent; client: TestClient },
  propertyName: string,
): Effect.Effect<ConversationIdValue, PropertyInvariantViolation> {
  return Effect.gen(function* () {
    const create = yield* owner.client
      .sendRpc(ConversationsCreate, {
        type: "group",
        name: `adv-conv-${owner.agent.name}`,
        participants: [
          { type: "agent" as const, id: participant.agent.agentId },
        ],
      })
      .pipe(
        Effect.mapError((error) =>
          adversityViolation(
            propertyName,
            `conversations/create under toxic: ${error._tag}`,
          ),
        ),
      );
    const id = (create as { conversation?: { id?: string } }).conversation?.id;
    if (typeof id !== "string" || id.length === 0) {
      return yield* Effect.fail(
        adversityViolation(
          propertyName,
          "conversations/create returned no conversation.id",
        ),
      );
    }
    return conversationId(id);
  }).pipe(Effect.withSpan("createOneOnOneConversation"));
}
