/** @file Autonomous evaluation peers built only on the public HarnessClient. */

import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import {
  AgentName,
  type Content,
  createConversationId,
  type HarnessClient,
  type HarnessTurn,
} from "@moltzap/client";
import {
  type AgentRuntime,
  type Application,
  type ApplicationEndpoint,
  defineContainerRuntime,
  image,
  type Image,
  routableBridgeEndpoint,
  RuntimeAcquisitionError,
  type RuntimeTermination,
  stoppedBeforeAttach,
} from "@moltzap/simulator/agents";
import { Duration, Effect, Mailbox, Schema, type Scope } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { SocialActionObserved } from "./events.js";
import { evaluationCaseId, type EvaluationCaseId } from "./model.js";

const EVALUATION_PEER_RUNTIME_NAME = "evaluation-peer";
const EVALUATION_PEER_APPLICATION_ENTRYPOINT =
  "/opt/moltzap/node_modules/@moltzap/evals/dist/peer-application.js";
const EVALUATION_PEER_PLAN_ENV = "MOLTZAP_EVAL_PEER_PLAN";
const EVALUATION_PEER_AGENT_NAME_ENV = "MOLTZAP_EVAL_AGENT_NAME";
const EVALUATION_PEER_BRIDGE_POLL_INTERVAL = Duration.millis(100);

/** Fixed controller bridge port exposed by every evaluation peer. */
export const EVALUATION_PEER_BRIDGE_PORT = 18_791;
/** Startup line emitted once a peer can accept its controller trigger. */
export const EVALUATION_PEER_READY_MARKER =
  "MoltZap evaluation peer bridge ready";
/** Environment key carrying one exact case-owned peer plan. */
export const EVALUATION_PEER_PLAN_ENVIRONMENT = EVALUATION_PEER_PLAN_ENV;
/** Environment key carrying the roster-owned endpoint name. */
export const EVALUATION_PEER_AGENT_NAME_ENVIRONMENT =
  EVALUATION_PEER_AGENT_NAME_ENV;

const EVALUATION_PEER_RESOURCES = Object.freeze({
  cpuMillis: 100,
  memoryBytes: 128 * 1024 * 1024,
  ephemeralStorageBytes: 128 * 1024 * 1024,
});

const decodeAgentName = Schema.decodeSync(AgentName);

/** Wait for a target-authored action, then reply in that conversation. */
class ReactivePeerPlan extends Schema.TaggedClass<ReactivePeerPlan>()(
  "moltzap.eval-peer-reactive/v2",
  {
    caseId: evaluationCaseId,
    targetName: AgentName,
    messages: Schema.NonEmptyArray(Schema.NonEmptyString),
  },
) {}

/** Start a conversation with the target and wait for its first reply. */
class OpeningPeerPlan extends Schema.TaggedClass<OpeningPeerPlan>()(
  "moltzap.eval-peer-opening/v2",
  {
    caseId: evaluationCaseId,
    targetName: AgentName,
    text: Schema.NonEmptyString,
  },
) {}

/** Join the roster without subscribing or competing for attention. */
class IdlePeerPlan extends Schema.TaggedClass<IdlePeerPlan>()(
  "moltzap.eval-peer-idle/v1",
  { caseId: evaluationCaseId },
) {}

/** Closed policy decoded by the peer application process. */
// eslint-disable-next-line @typescript-eslint/naming-convention, agent-code-guard/no-exported-brand-constructor -- The process boundary and case catalog share this closed schema.
export const EvaluationPeerPlan = Schema.Union(
  ReactivePeerPlan,
  OpeningPeerPlan,
  IdlePeerPlan,
);
/** Decoded case-owned autonomous peer policy. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same name intentionally identifies the schema and its decoded value.
export type EvaluationPeerPlan = typeof EvaluationPeerPlan.Type;

/** Non-secret runtime configuration committed with the RunSpec roster. */
class EvaluationPeerRuntimeConfiguration extends Schema.Class<EvaluationPeerRuntimeConfiguration>(
  "EvaluationPeerRuntimeConfiguration",
)({
  applicationImage: image,
  plan: EvaluationPeerPlan,
}) {}

/** One semantic action observed at the public Client boundary. */
export type EvaluationPeerObservation = SocialActionObserved;

/** One completed autonomous interaction in endpoint-observation order. */
export class PeerExchange extends Schema.Class<PeerExchange>("PeerExchange")({
  observations: Schema.NonEmptyArray(SocialActionObserved),
}) {}

/** A peer could not complete its public Client policy. */
export class EvaluationPeerFailed extends Schema.TaggedError<EvaluationPeerFailed>()(
  "EvaluationPeerFailed",
  {
    operation: Schema.Literal(
      "configuration",
      "connect",
      "listen",
      "start",
      "reply",
      "bridge",
    ),
    detail: Schema.NonEmptyString,
  },
) {}

/** The peer application completed its autonomous policy. */
export class EvaluationPeerBridgeCompleted extends Schema.TaggedClass<EvaluationPeerBridgeCompleted>()(
  "moltzap.eval-peer-bridge-completed/v2",
  { exchange: PeerExchange },
) {}

/** The peer application terminated its policy with a typed failure. */
export class EvaluationPeerBridgeFailed extends Schema.TaggedClass<EvaluationPeerBridgeFailed>()(
  "moltzap.eval-peer-bridge-failed/v2",
  { failure: EvaluationPeerFailed },
) {}

/** Closed result carried by the peer application bridge. */
// eslint-disable-next-line @typescript-eslint/naming-convention, agent-code-guard/no-exported-brand-constructor -- The controller and process share this exact schema.
export const EvaluationPeerBridgeResult = Schema.Union(
  EvaluationPeerBridgeCompleted,
  EvaluationPeerBridgeFailed,
);
/** Decoded application bridge result. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same name intentionally identifies the schema and its decoded value.
export type EvaluationPeerBridgeResult = typeof EvaluationPeerBridgeResult.Type;

/** Observation-only gateway exposed by one autonomous peer. */
export interface EvaluationPeerGateway {
  readonly exchange: Effect.Effect<PeerExchange, EvaluationPeerFailed>;
}

/** Image-independent peer definition materialized by one evaluation cell. */
export interface EvaluationPeerDefinition {
  readonly plan: EvaluationPeerPlan;
  readonly runtime: (applicationImage: Image) => EvaluationPeerRuntime;
}

/** Runtime inputs used inside the peer application process. */
export interface EvaluationPeerApplicationContext {
  readonly agentName: typeof AgentName.Type;
  readonly client: HarnessClient;
}

type TurnInbox = Mailbox.ReadonlyMailbox<HarnessTurn, unknown>;
type EvaluationPeerRuntime = AgentRuntime<
  EvaluationPeerGateway,
  RuntimeAcquisitionError,
  typeof EvaluationPeerRuntimeConfiguration
>;

function failure(
  operation: EvaluationPeerFailed["operation"],
  cause: unknown,
): EvaluationPeerFailed {
  const rendered = cause instanceof Error ? cause.message : String(cause);
  return EvaluationPeerFailed.make({
    operation,
    detail:
      rendered.trim().length > 0
        ? rendered.trim()
        : "operation failed without a diagnostic",
  });
}

function textContent(text: string): Content {
  return [{ type: "text", text }];
}

function observed(input: {
  readonly caseId: EvaluationCaseId;
  readonly endpointName: typeof AgentName.Type;
  readonly turn: HarnessTurn;
}): SocialActionObserved {
  return SocialActionObserved.make({
    caseId: input.caseId,
    endpointName: input.endpointName,
    conversationId: input.turn.conversationId,
    authorName: input.turn.author.agentName,
    direction: "input",
    content: input.turn.content,
  });
}

function sent(input: {
  readonly caseId: EvaluationCaseId;
  readonly endpointName: typeof AgentName.Type;
  readonly conversationId: HarnessTurn["conversationId"];
  readonly content: Content;
}): SocialActionObserved {
  return SocialActionObserved.make({
    caseId: input.caseId,
    endpointName: input.endpointName,
    conversationId: input.conversationId,
    authorName: input.endpointName,
    direction: "output",
    content: input.content,
  });
}

function matchingTurn(
  inbox: TurnInbox,
  targetName: typeof AgentName.Type,
  conversationId?: HarnessTurn["conversationId"],
): Effect.Effect<HarnessTurn, EvaluationPeerFailed> {
  return Effect.gen(function* () {
    while (true) {
      const turn = yield* inbox.take.pipe(
        Effect.mapError((cause) => failure("listen", cause)),
      );
      if (
        turn.author.agentName === targetName &&
        (conversationId === undefined || turn.conversationId === conversationId)
      ) {
        return turn;
      }
    }
  });
}

function reactiveExchange(
  context: EvaluationPeerApplicationContext,
  plan: ReactivePeerPlan,
): Effect.Effect<PeerExchange, EvaluationPeerFailed, Scope.Scope> {
  return Effect.gen(function* () {
    const inbox = yield* Mailbox.fromStream(context.client.turns);
    let turn = yield* matchingTurn(inbox, plan.targetName);
    const observations: [
      EvaluationPeerObservation,
      ...EvaluationPeerObservation[],
    ] = [
      observed({ caseId: plan.caseId, endpointName: context.agentName, turn }),
    ];
    for (const message of plan.messages) {
      const reply = textContent(message);
      yield* turn
        .reply(reply)
        .pipe(Effect.mapError((cause) => failure("reply", cause)));
      observations.push(
        sent({
          caseId: plan.caseId,
          endpointName: context.agentName,
          conversationId: turn.conversationId,
          content: reply,
        }),
      );
      turn = yield* matchingTurn(inbox, plan.targetName, turn.conversationId);
      observations.push(
        observed({
          caseId: plan.caseId,
          endpointName: context.agentName,
          turn,
        }),
      );
    }
    return PeerExchange.make({ observations });
  });
}

function openingExchange(
  context: EvaluationPeerApplicationContext,
  plan: OpeningPeerPlan,
): Effect.Effect<PeerExchange, EvaluationPeerFailed, Scope.Scope> {
  return Effect.gen(function* () {
    const inbox = yield* Mailbox.fromStream(context.client.turns);
    const conversationId = yield* createConversationId().pipe(
      Effect.mapError((cause) => failure("start", cause)),
    );
    const initial = textContent(plan.text);
    yield* context.client
      .start({
        conversationId,
        peers: [plan.targetName],
        content: initial,
      })
      .pipe(Effect.mapError((cause) => failure("start", cause)));
    const turn = yield* matchingTurn(inbox, plan.targetName, conversationId);
    return PeerExchange.make({
      observations: [
        SocialActionObserved.make({
          caseId: plan.caseId,
          endpointName: context.agentName,
          conversationId,
          authorName: context.agentName,
          direction: "output",
          content: initial,
        }),
        observed({
          caseId: plan.caseId,
          endpointName: context.agentName,
          turn,
        }),
      ],
    });
  });
}

/** Run one triggered peer policy using only its scoped public Client. */
export function runEvaluationPeerApplication(
  context: EvaluationPeerApplicationContext,
  plan: EvaluationPeerPlan,
): Effect.Effect<PeerExchange, EvaluationPeerFailed, Scope.Scope> {
  if (plan instanceof ReactivePeerPlan) {
    return reactiveExchange(context, plan);
  }
  if (plan instanceof OpeningPeerPlan) {
    return openingExchange(context, plan);
  }
  return Effect.fail(
    failure("configuration", "an idle roster member has no exchange"),
  );
}

function acquisitionFailure(
  agent: string,
  operation: string,
  cause: unknown,
): RuntimeAcquisitionError {
  return RuntimeAcquisitionError.make({
    runtime: EVALUATION_PEER_RUNTIME_NAME,
    agent,
    detail: `${operation}: ${String(cause)}`,
  });
}

function bridgeUrl(endpoint: ApplicationEndpoint, path: string): URL {
  const routed = routableBridgeEndpoint(endpoint);
  return new URL(path, `http://${routed.host}:${String(routed.port)}/`);
}

function executeBridgeRequest(
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<
  Readonly<{ status: number; body: unknown }>,
  EvaluationPeerFailed,
  HttpClient.HttpClient
> {
  return HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.execute(request)),
    Effect.mapError((cause) => failure("bridge", cause)),
    Effect.flatMap((response) =>
      response.status === 204 || response.status === 202
        ? Effect.succeed({ status: response.status, body: undefined })
        : response.json.pipe(
            Effect.mapError((cause) => failure("bridge", cause)),
            Effect.map((body) => ({ status: response.status, body })),
          ),
    ),
  );
}

function triggerBridge(
  url: URL,
): Effect.Effect<void, EvaluationPeerFailed, HttpClient.HttpClient> {
  return executeBridgeRequest(HttpClientRequest.post(url)).pipe(
    Effect.flatMap(({ status }) =>
      status === 200 || status === 202
        ? Effect.void
        : Effect.fail(failure("bridge", `peer bridge returned HTTP ${status}`)),
    ),
  );
}

function awaitBridgeResult(
  url: URL,
): Effect.Effect<
  EvaluationPeerBridgeResult,
  EvaluationPeerFailed,
  HttpClient.HttpClient
> {
  const poll: Effect.Effect<
    EvaluationPeerBridgeResult,
    EvaluationPeerFailed,
    HttpClient.HttpClient
  > = Effect.suspend(() =>
    executeBridgeRequest(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(({ body, status }) => {
        if (status === 204) {
          return Effect.sleep(EVALUATION_PEER_BRIDGE_POLL_INTERVAL).pipe(
            Effect.zipRight(poll),
          );
        }
        if (status !== 200) {
          return Effect.fail(
            failure("bridge", `peer bridge returned HTTP ${status}`),
          );
        }
        return Schema.decodeUnknown(EvaluationPeerBridgeResult)(body, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError((cause) => failure("bridge", cause)));
      }),
    ),
  );
  return poll;
}

function bridgeExchange(
  endpoint: ApplicationEndpoint,
): Effect.Effect<PeerExchange, EvaluationPeerFailed> {
  return Effect.gen(function* () {
    yield* triggerBridge(bridgeUrl(endpoint, "/run"));
    const result = yield* awaitBridgeResult(bridgeUrl(endpoint, "/result"));
    return result instanceof EvaluationPeerBridgeCompleted
      ? result.exchange
      : yield* Effect.fail(result.failure);
  }).pipe(Effect.provide(NodeHttpClient.layerUndici));
}

function attachEvaluationPeer(
  agent: string,
  endpoint: ApplicationEndpoint,
  stopped: Effect.Effect<RuntimeTermination>,
): Effect.Effect<EvaluationPeerGateway, RuntimeAcquisitionError, Scope.Scope> {
  return Effect.try({
    try: () => bridgeUrl(endpoint, "/result"),
    catch: (cause) => acquisitionFailure(agent, "resolve peer bridge", cause),
  }).pipe(
    Effect.map(() =>
      Object.freeze({
        exchange: bridgeExchange(endpoint).pipe(
          Effect.raceFirst(
            stoppedBeforeAttach(stopped, (detail) =>
              failure(
                "bridge",
                `peer application stopped before publishing its result: ${detail}`,
              ),
            ),
          ),
        ),
      }),
    ),
  );
}

function peerApplication(
  plan: EvaluationPeerPlan,
  agentName: typeof AgentName.Type,
): Application<EvaluationPeerGateway, RuntimeAcquisitionError> {
  const encodedPlan = Schema.encodeSync(Schema.parseJson(EvaluationPeerPlan))(
    plan,
  );
  return Object.freeze({
    entrypoint: Object.freeze([
      "node",
      EVALUATION_PEER_APPLICATION_ENTRYPOINT,
    ] as const),
    environment: Object.freeze({
      NODE_ENV: "production",
      [EVALUATION_PEER_PLAN_ENV]: encodedPlan,
      [EVALUATION_PEER_AGENT_NAME_ENV]: agentName,
    }),
    port: EVALUATION_PEER_BRIDGE_PORT,
    files: Object.freeze([]),
    attach: (
      endpoint: ApplicationEndpoint,
      stopped: Effect.Effect<RuntimeTermination>,
    ) => attachEvaluationPeer(agentName, endpoint, stopped),
  });
}

function peerRuntime(
  plan: EvaluationPeerPlan,
  applicationImage: Image,
): EvaluationPeerRuntime {
  return defineContainerRuntime({
    name: EVALUATION_PEER_RUNTIME_NAME,
    configuration: {
      schema: EvaluationPeerRuntimeConfiguration,
      value: new EvaluationPeerRuntimeConfiguration({
        applicationImage,
        plan,
      }),
    },
    image: applicationImage,
    resources: EVALUATION_PEER_RESOURCES,
    render: (input) =>
      Effect.try({
        try: () => peerApplication(plan, input.agentName),
        catch: (cause) =>
          acquisitionFailure(input.agentName, "render peer application", cause),
      }),
  });
}

function peerDefinition(plan: EvaluationPeerPlan): EvaluationPeerDefinition {
  return Object.freeze({
    plan: Object.freeze(plan),
    runtime: (applicationImage: Image) => peerRuntime(plan, applicationImage),
  });
}

/** Build a peer that replies after the target authors an action. */
export function reactivePeer(
  caseId: EvaluationCaseId,
  targetName: string,
  messages: NonEmptyReadonlyArray<string>,
): EvaluationPeerDefinition {
  return peerDefinition(
    new ReactivePeerPlan({
      caseId,
      targetName: decodeAgentName(targetName),
      messages: Object.freeze([...messages]),
    }),
  );
}

/** Build a peer that starts the conversation before the principal prompt. */
export function openingPeer(
  caseId: EvaluationCaseId,
  targetName: string,
  text: string,
): EvaluationPeerDefinition {
  return peerDefinition(
    new OpeningPeerPlan({
      caseId,
      targetName: decodeAgentName(targetName),
      text,
    }),
  );
}

/** Build a roster-only member that never opens a Client subscription. */
export function idlePeer(caseId: EvaluationCaseId): EvaluationPeerDefinition {
  return peerDefinition(new IdlePeerPlan({ caseId }));
}
