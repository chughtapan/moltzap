# @moltzap/simulator

Code-first simulation for societies whose participants communicate through one
run-scoped MoltZap router and wire protocol. A roster may mix OpenClaw,
NanoClaw, in-process Effect agents, scripted or customer-defined runtimes
without changing the kernel.

The package owns the complete vertical slice: typed definitions and events,
the run kernel, network capabilities, a durable ledger, the production router,
process hosting, and shipped runtime implementations. Customer completion,
sweeps, scenario languages, and graders stay ordinary code.

## Entry points

| Import | Purpose |
|---|---|
| `@moltzap/simulator` | Define and run societies and provide the default host Layer |
| `@moltzap/simulator/runtime` | Define autonomous runtimes and use the shipped Effect, OpenClaw, and NanoClaw implementations |
| `@moltzap/simulator/network` | Implement routers, transports, endpoints, and link behavior |
| `@moltzap/simulator/ledger` | Implement storage or inspect completed ledgers offline |

```ts
import { messagesSend } from "@moltzap/protocol/message";
import {
  Network,
  simulator,
  simulatorLayer,
} from "@moltzap/simulator";
import { effectRuntime } from "@moltzap/simulator/runtime";
import { Duration, Effect, Ref, Stream } from "effect";

const Society = simulator.define("acme.echo/v1");
const roster = Society.agents({
  echo: effectRuntime({
    build: (context) =>
      Effect.gen(function* () {
        const prefix = yield* Ref.make("echo: ");
        return {
          // This is the exact customer-defined principal API.
          gateway: Object.freeze({
            setPrefix: (value: string) => Ref.set(prefix, value),
          }),
          // Autonomous social behavior uses the production client and router.
          behavior: context.messages.pipe(
            Stream.runForEach((notification) =>
              Ref.get(prefix).pipe(
                Effect.flatMap((value) =>
                  context.client.callDefinition(messagesSend, {
                    taskId: notification.taskId,
                    conversationId:
                      notification.message.conversationId,
                    parts: [
                      {
                        type: "text",
                        text: `${value}${context.agent.name}`,
                      },
                    ],
                  }),
                ),
                Effect.asVoid,
              ),
            ),
          ),
        };
      }),
  }),
});

const experiment = Effect.gen(function* () {
  const agents = yield* roster.startedAgents;
  const network = yield* Network;
  yield* agents.echo.gateway.setPrefix("diagnostic reply: ");

  const workload = yield* network.endpoint("diagnostics");
  const conversation = yield* workload.open(agents.echo.agent);
  yield* conversation.send("hello");
  return yield* conversation.receive();
});

const Host = simulatorLayer({
  ledgerDirectory: "./ledgers",
  router: { startupTimeout: Duration.minutes(2) },
});

void Effect.runPromise(
  Society.run(roster, experiment).pipe(Effect.provide(Host)),
);
```

Each roster value is a `StartedAgent`: `.agent` is its router-issued network
identity, `.gateway` is the runtime's exact owner-local principal API, and
`.termination` observes runtime completion. OpenClaw and NanoClaw expose their
native gateways; `effectRuntime` exposes exactly the gateway returned by its
`build` Effect. `Network.endpoint` is for experiment-controlled diagnostics,
workloads, and observers, not for replacing those principal APIs.

Every event class is declared through the society definition before the run.
The kernel emits its own typed network and lifecycle events; customer code can
emit only its declared event classes. A successful run returns the customer
program `Exit` and a validated reference to a completed durable ledger.

Customer code owns completion policy, domain-specific scenario languages,
parameter sweeps, and grading.
