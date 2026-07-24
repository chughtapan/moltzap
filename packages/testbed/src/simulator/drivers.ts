/**
 * @file Registered driver implementations (contract 4 internals). Run
 * specs reference drivers by name plus JSON config, never by closure;
 * names resolve here at materialization time, so an unregistered name or
 * a config the driver rejects never reaches launch. The v0 registry is
 * the closed built-in set below; consumer-supplied driver processes are
 * a staged-later surface.
 */
import { Effect, Schema } from "effect";
import { MoltZapAgentClient } from "@moltzap/protocol/socket";
import {
  DEFAULT_APP_ID,
  TaskRequest,
  type TaskId,
} from "@moltzap/protocol/task";
import { MessagesSend } from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { DriverRef } from "./run-spec.js";
import type { Principal, TaskDelivery } from "./episode.js";
import type { SimulatorEvent } from "./event-log.js";
import type { Secrets } from "./recording.js";
import {
  DriverConfigRejected,
  TaskInjectionFailed,
  UnknownDriver,
} from "./errors.js";
import {
  agentKeyValue,
  httpBaseFromServerUrl,
  registerIdentity,
  type MintedIdentity,
} from "./provisioning.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const OUT_OF_BAND_PRINCIPAL = "out-of-band";
const SPAN_NAME_DONE_SIGNAL = "span-name";

export type DriverKind = "principal" | "done-signal";

/** Config of the `span-name` done-signal predicate. */
const SpanNameDoneConfig = Schema.Struct({
  name: Schema.NonEmptyString.annotations({
    description: "Span name that signals episode completion",
  }),
  minCount: Schema.optionalWith(
    Schema.Int.pipe(
      Schema.positive(),
      Schema.annotations({
        description: "Number of matching spans required before firing",
      }),
    ),
    { default: () => 1 },
  ),
});

/** Config of the `out-of-band` principal (no knobs in v0). */
const OutOfBandPrincipalConfig = Schema.Struct({});

const REGISTERED_DRIVERS: Readonly<
  Record<
    string,
    { readonly kind: DriverKind; readonly config: Schema.Schema.AnyNoContext }
  >
> = {
  [OUT_OF_BAND_PRINCIPAL]: {
    kind: "principal",
    config: OutOfBandPrincipalConfig,
  },
  [SPAN_NAME_DONE_SIGNAL]: { kind: "done-signal", config: SpanNameDoneConfig },
};

function configRejected(
  ref: DriverRef,
): (cause: { readonly message: string }) => DriverConfigRejected {
  return (cause) =>
    new DriverConfigRejected({
      name: ref.name,
      field: cause.message.split("\n")[0] ?? "config",
      message: `Driver "${ref.name}" rejected its config: ${cause.message}. Fix the driver config fields to match the driver's schema.`,
    });
}

function decodeDriverConfig<A, I>(
  ref: DriverRef,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, DriverConfigRejected> {
  return Schema.decodeUnknown(schema)(ref.config).pipe(
    Effect.mapError(configRejected(ref)),
  );
}

/**
 * Resolve one driver reference against the registry: unknown names and
 * rejected configs fail here, at config time, never at launch.
 */
export function checkDriverRef(
  ref: DriverRef,
  expectedKind: DriverKind,
): Effect.Effect<void, UnknownDriver | DriverConfigRejected> {
  const registered = REGISTERED_DRIVERS[ref.name];
  if (registered === undefined || registered.kind !== expectedKind) {
    return Effect.fail(
      new UnknownDriver({
        name: ref.name,
        message: `No registered ${expectedKind} driver is named "${ref.name}". Registered ${expectedKind} drivers: ${registeredNames(expectedKind).join(", ")}.`,
      }),
    );
  }
  return decodeDriverConfig(ref, registered.config).pipe(Effect.asVoid);
}

function registeredNames(kind: DriverKind): ReadonlyArray<string> {
  return Object.entries(REGISTERED_DRIVERS)
    .filter(([, entry]) => entry.kind === kind)
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Done-signal predicates
// ---------------------------------------------------------------------------

/** A stateful completion predicate; `observe` reports whether this event completes the episode. */
export type DonePredicate = {
  readonly driverName: string;
  observe(event: SimulatorEvent): boolean;
};

/** Instantiate the done-signal predicate for one episode; the ref is already materialization-checked. */
export function makeDonePredicate(
  ref: DriverRef,
): Effect.Effect<DonePredicate, UnknownDriver | DriverConfigRejected> {
  return checkDriverRef(ref, "done-signal").pipe(
    Effect.zipRight(decodeDriverConfig(ref, SpanNameDoneConfig)),
    Effect.map((config) => {
      let seen = 0;
      return {
        driverName: ref.name,
        observe: (event: SimulatorEvent): boolean => {
          if (event._tag !== "span.accepted") return false;
          if (event.spanName !== config.name) return false;
          seen += 1;
          return seen >= config.minCount;
        },
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

function taskInjectionFailed(
  delivery: TaskDelivery,
  detail: string,
): TaskInjectionFailed {
  return new TaskInjectionFailed({
    principal: delivery.task.principal,
    to: delivery.task.to,
    message: `Principal "${delivery.task.principal}" could not deliver the seed task to "${delivery.task.to}": ${detail}`,
  });
}

function targetAgentId(
  delivery: TaskDelivery,
): Effect.Effect<AgentId, TaskInjectionFailed> {
  const target = delivery.world.agents.find(
    (agent) => agent.slot === delivery.task.to,
  );
  return target === undefined
    ? Effect.fail(
        taskInjectionFailed(
          delivery,
          `no launched agent is named "${delivery.task.to}"`,
        ),
      )
    : Effect.succeed(target.agentId);
}

function mintPrincipalIdentity(
  delivery: TaskDelivery,
  secrets: Secrets,
): Effect.Effect<MintedIdentity, TaskInjectionFailed> {
  return registerIdentity({
    httpBase: httpBaseFromServerUrl(delivery.world.server.serverUrl),
    name: delivery.task.principal,
  }).pipe(
    Effect.catchTag("IdentityRegistrationFailed", (cause) =>
      Effect.fail(taskInjectionFailed(delivery, cause.message)),
    ),
    Effect.tap((minted) =>
      Effect.sync(() => {
        secrets.register(agentKeyValue(minted.apiKey));
      }),
    ),
  );
}

/** Open a task + conversation with the target and speak the task content as the connected principal. */
function speakTask(
  client: MoltZapAgentClient,
  delivery: TaskDelivery,
  target: AgentId,
): Effect.Effect<void, TaskInjectionFailed> {
  return client
    .callDefinition(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [target],
      initialConversation: { participants: [target] },
    })
    .pipe(
      Effect.catchAll(deliveryFailure(delivery, "task request failed")),
      Effect.flatMap((created) =>
        created.conversation === null
          ? Effect.fail(
              taskInjectionFailed(
                delivery,
                "task request returned no initial conversation",
              ),
            )
          : sendTaskMessage(client, delivery, {
              taskId: created.task.id,
              conversationId: created.conversation.id,
            }),
      ),
    );
}

function sendTaskMessage(
  client: MoltZapAgentClient,
  delivery: TaskDelivery,
  scope: {
    readonly taskId: TaskId;
    readonly conversationId: ConversationId;
  },
): Effect.Effect<void, TaskInjectionFailed> {
  return client
    .callDefinition(MessagesSend, {
      taskId: scope.taskId,
      conversationId: scope.conversationId,
      parts: [{ type: "text", text: delivery.task.content }],
    })
    .pipe(
      Effect.catchAll(deliveryFailure(delivery, "message send failed")),
      Effect.asVoid,
    );
}

function deliveryFailure(
  delivery: TaskDelivery,
  detail: string,
): (cause: unknown) => Effect.Effect<never, TaskInjectionFailed> {
  return (cause) =>
    Effect.fail(taskInjectionFailed(delivery, `${detail}: ${String(cause)}`));
}

/**
 * The v0 out-of-band principal: registers the principal's own agent
 * identity against the run's server, opens a task + conversation with
 * the target, and speaks the task content as that identity — so the
 * seed task is attributed to a principal identity in the conversation
 * flow, never a system sender. The minted key is registered in the
 * per-attempt `Secrets` before any protocol traffic carries it.
 */
function makeOutOfBandPrincipal(context: {
  readonly secrets: Secrets;
}): Principal {
  return {
    deliverTask: (delivery: TaskDelivery) =>
      Effect.gen(function* () {
        const target = yield* targetAgentId(delivery);
        const minted = yield* mintPrincipalIdentity(delivery, context.secrets);
        const client = new MoltZapAgentClient({
          serverUrl: delivery.world.server.serverUrl,
          agentKey: minted.apiKey,
        });
        yield* client
          .connect()
          .pipe(
            Effect.catchAll(
              deliveryFailure(delivery, "principal connect failed"),
            ),
          );
        yield* speakTask(client, delivery, target).pipe(
          Effect.ensuring(client.close()),
        );
      }).pipe(Effect.withSpan("Principal.deliverTask")),
  };
}

/** Instantiate the principal for one episode; absent ref means the default out-of-band principal. */
export function makePrincipal(
  ref: DriverRef | undefined,
  context: { readonly secrets: Secrets },
): Effect.Effect<Principal, UnknownDriver | DriverConfigRejected> {
  if (ref === undefined) {
    return Effect.succeed(makeOutOfBandPrincipal(context));
  }
  return checkDriverRef(ref, "principal").pipe(
    Effect.as(makeOutOfBandPrincipal(context)),
  );
}
