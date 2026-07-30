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
| `@moltzap/simulator` | Define and run societies, construct runtimes, and provide the default host Layer |
| `@moltzap/simulator/network` | Implement routers, transports, endpoints, and link behavior |
| `@moltzap/simulator/ledger` | Implement storage or inspect completed ledgers offline |

```ts
import {
  Network,
  Simulator,
  effectRuntime,
  simulatorLayer,
} from "@moltzap/simulator";
import { Duration, Effect } from "effect";

const Society = Simulator.define("acme.echo/v1");
const roster = Society.agents({
  echo: effectRuntime({
    onMessage: ({ message }) => Effect.succeed(message.parts),
  }),
});

const experiment = Effect.gen(function* () {
  const agents = yield* roster.Agents;
  const network = yield* Network;
  const probe = yield* network.endpoint("probe");
  const conversation = yield* probe.open(agents.echo);
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

Every event class is declared through the society definition before the run.
The kernel emits its own typed network and lifecycle events; customer code can
emit only its declared event classes. A successful run returns the customer
program `Exit` and a validated reference to a completed durable ledger.

Customer code owns completion policy, domain-specific scenario languages,
parameter sweeps, and grading.
