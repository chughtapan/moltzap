/**
 * Transport-layer helpers shared by lifecycle adversity properties
 * (latency, reset-peer, timeout, slow-close).
 */
import { Effect, type Scope } from "effect";
import type { ToxiproxyProxy } from "../../toxics/client.js";
import type { ToxicProfile } from "../../toxics/profile.js";
import {
  makeAgentTestClient,
  type AgentTestClient,
} from "../_shared/driver/test-client.js";
import {
  registerTestAgent,
  type TestAgent,
  conversationId,
} from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "../_shared/registry.js";
import {
  agentConversationCreate,
  type ConversationId,
} from "@moltzap/protocol/conversation";

/** Provides the adversity category runtime value. */
export const ADVERSITY_CATEGORY = "adversity";
const RANDOM_SUFFIX_LENGTH = 6;
const PROPERTY_BUDGET_MS = 15_000;

type ToxicPropertyError = PropertyUnavailable | PropertyInvariantViolation;

/**
 * Executes the adversity violation operation.
 * @param name Name of the operation.
 * @param reason Value supplied to the operation.
 * @returns The adversity violation result.
 */
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

/**
 * Executes the proxy name operation.
 * @param prefix Value supplied to the operation.
 * @param seed Value supplied to the operation.
 * @returns The proxy name result.
 */
export function proxyName(prefix: string, seed: number): string {
  return `${prefix}-${seed}-${randomIdSuffix()}`;
}

function hostPortFromWebSocketUrl(wsUrl: string): string {
  return new URL(wsUrl).host;
}

/**
 * Acquire an agent client that routes through the Toxiproxy proxy.
 * @param opts Value supplied to the operation.
 * @param opts.ctx Value supplied to the operation.
 * @param opts.proxy Value supplied to the operation.
 * @param opts.name Value supplied to the operation.
 * @param opts.defaultTimeoutMs Value supplied to the operation.
 * @param opts.unavailable Value supplied to the operation.
 * @returns The acquire proxied client result.
 */
export function acquireProxiedClient(opts: {
  readonly ctx: ConformanceRunContext;
  readonly proxy: ToxiproxyProxy;
  readonly name: string;
  readonly defaultTimeoutMs: number;
  readonly unavailable: (reason: string) => PropertyUnavailable;
}): Effect.Effect<
  { agent: TestAgent; client: AgentTestClient },
  PropertyUnavailable,
  Scope.Scope
> {
  const { ctx, proxy, name, defaultTimeoutMs, unavailable } = opts;
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
    const client = yield* makeAgentTestClient({
      serverUrl: proxiedUrl,
      agentKey: agent.apiKey,
      defaultTimeoutMs,
    }).pipe(
      Effect.mapError((e) => unavailable(`makeAgentTestClient: ${String(e)}`)),
    );
    return { agent, client };
  }).pipe(Effect.withSpan("acquireProxiedClient"));
}

/**
 * Body params — `attachToxic` attaches the toxic inside the caller's
 * scope. Nesting matters: the caller typically does.
 *
 * ```ts
 * Effect.scoped(gen(function* () {
 *   const client = yield* acquireProxiedClient(...)  // outer
 *   yield* Effect.scoped(gen(function* () {
 *     yield* attachToxic                             // inner
 *     yield* assertion(client)
 *   }))                                              // toxic removed
 * }))                                                // client close OK
 * ```
 *
 * So the toxic is removed BEFORE the agent client's socket close. Under
 * disruptive toxics (timeout, reset_peer), this lets the WS close
 * handshake flow cleanly instead of hanging on a black-holed channel.
 */
export interface ToxicBodyParams {
  readonly proxy: ToxiproxyProxy;
  readonly unavailable: (reason: string) => PropertyUnavailable;
  readonly attachToxic: Effect.Effect<void, PropertyUnavailable, Scope.Scope>;
}

/**
 * Factory — wire a Toxiproxy proxy + attach the toxic; hand a body the
 * proxy. Hard-deadlines each property body so a hanging toxic can't
 * block the suite indefinitely; if the deadline fires, the property
 * reports `PropertyUnavailable` (not a pass, not a crash).
 * @param opts Value supplied to the operation.
 * @param opts.ctx Value supplied to the operation.
 * @param opts.propertyName Value supplied to the operation.
 * @param opts.description Value supplied to the operation.
 * @param opts.proxyName Value supplied to the operation.
 * @param opts.profile Value supplied to the operation.
 * @param opts.body Value supplied to the operation.
 */
export function withToxicProxy(opts: {
  readonly ctx: ConformanceRunContext;
  readonly propertyName: string;
  readonly description: string;
  readonly proxyName: string;
  readonly profile: ToxicProfile;
  readonly body: (
    params: ToxicBodyParams,
  ) => Effect.Effect<void, ToxicPropertyError, Scope.Scope>;
}): void {
  const { ctx, propertyName, description, proxyName, profile, body } = opts;
  const run = buildToxicProxyRun({
    ctx,
    propertyName,
    proxyName,
    profile,
    body,
  });
  registerProperty(
    ctx,
    ADVERSITY_CATEGORY,
    propertyName,
    description,
    run.pipe(Effect.withSpan("withToxicProxy")),
  );
}

function buildToxicProxyRun(opts: {
  readonly ctx: ConformanceRunContext;
  readonly propertyName: string;
  readonly proxyName: string;
  readonly profile: ToxicProfile;
  readonly body: (
    params: ToxicBodyParams,
  ) => Effect.Effect<void, ToxicPropertyError, Scope.Scope>;
}): Effect.Effect<void, ToxicPropertyError> {
  const toxiproxy = opts.ctx.toxiproxy;
  const unavailable = makeUnavailable(opts.propertyName);
  if (toxiproxy === null) {
    return Effect.fail(
      unavailable("Toxiproxy client not provisioned for this run"),
    );
  }
  return runWithToxiproxy({
    ...opts,
    toxiproxy,
    unavailable,
  });
}

function makeUnavailable(propertyName: string) {
  return (reason: string): PropertyUnavailable =>
    new PropertyUnavailable({
      category: ADVERSITY_CATEGORY,
      name: propertyName,
      reason,
    });
}

function runWithToxiproxy(opts: {
  readonly ctx: ConformanceRunContext;
  readonly proxyName: string;
  readonly profile: ToxicProfile;
  readonly toxiproxy: NonNullable<ConformanceRunContext["toxiproxy"]>;
  readonly unavailable: (reason: string) => PropertyUnavailable;
  readonly body: (
    params: ToxicBodyParams,
  ) => Effect.Effect<void, ToxicPropertyError, Scope.Scope>;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* opts.toxiproxy
        .proxy({
          name: opts.proxyName,
          upstream: hostPortFromWebSocketUrl(opts.ctx.realServer.wsUrl),
        })
        .pipe(Effect.mapError((e) => opts.unavailable(`proxy: ${e.body}`)));
      const attachToxic: ToxicBodyParams["attachToxic"] = proxy
        .withToxic(opts.profile)
        .pipe(
          Effect.mapError((e) => opts.unavailable(`toxic: ${e.body}`)),
          Effect.asVoid,
        );
      yield* opts.body({ proxy, unavailable: opts.unavailable, attachToxic });
    }),
  ).pipe(
    Effect.timeoutFail({
      duration: `${PROPERTY_BUDGET_MS} millis`,
      onTimeout: () =>
        opts.unavailable(
          `property exceeded ${PROPERTY_BUDGET_MS}ms budget under toxic`,
        ),
    }),
  );
}

/**
 * Creates one on one conversation.
 * @param owner Value supplied to the operation.
 * @param owner.agent Value supplied to the operation.
 * @param owner.client Value supplied to the operation.
 * @param participant Value supplied to the operation.
 * @param participant.agent Value supplied to the operation.
 * @param participant.client Value supplied to the operation.
 * @param propertyName Value supplied to the operation.
 * @returns The created one on one conversation.
 */
export function createOneOnOneConversation(
  owner: { agent: TestAgent; client: AgentTestClient },
  participant: { agent: TestAgent; client: AgentTestClient },
  propertyName: string,
): Effect.Effect<
  { conversationId: ConversationId },
  PropertyInvariantViolation
> {
  return Effect.gen(function* () {
    const create = yield* owner.client
      .sendRpc(agentConversationCreate, {
        name: `adv-conv-${owner.agent.name}`,
        participants: [participant.agent.agentId],
      })
      .pipe(
        Effect.mapError((error) =>
          adversityViolation(
            propertyName,
            `agent/conversation/create under toxic: ${error._tag}`,
          ),
        ),
      );
    return { conversationId: conversationId(create.conversation.id) };
  }).pipe(Effect.withSpan("createOneOnOneConversation"));
}
