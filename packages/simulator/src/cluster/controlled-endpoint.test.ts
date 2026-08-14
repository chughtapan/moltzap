/** @file Deterministic process-lifecycle coverage for controlled endpoints. */

import type * as MoltzapClientModule from "@moltzap/client";
import type * as ChildProcessModule from "node:child_process";
import type * as NetModule from "node:net";
import { assert, it } from "@effect/vitest";
import { ConnectError } from "@moltzap/client";
import { AgentId } from "@moltzap/identity";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Schema,
  Scope,
  Stream,
  TestClock,
} from "effect";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, vi } from "vitest";
import { NetworkError } from "../network/failure.js";
import { makeControlledEndpointRuntime } from "./controlled-endpoint.js";
import { generateSocietyNetworkAuthority } from "./society-network.js";

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn() }));
const networkBoundary = vi.hoisted(() => ({
  createConnection: vi.fn(),
  createServer: vi.fn(),
}));
const clientBoundary = vi.hoisted(() => ({ acquire: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: processBoundary.spawn,
}));

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof NetModule>()),
  createConnection: networkBoundary.createConnection,
  createServer: networkBoundary.createServer,
}));

vi.mock("@moltzap/client", async (importOriginal) => ({
  ...(await importOriginal<typeof MoltzapClientModule>()),
  acquireHarnessClient: clientBoundary.acquire,
}));

const DAEMON_ENTRYPOINT =
  "/srv/moltzap/node_modules/@moltzap/client/bin/moltzapd";
const REGISTRAR_ENTRYPOINT = "/opt/moltzap/register-daemon.mjs";
const AGENT_ID = Schema.decodeSync(AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAA");
const ROUTER_ORIGIN = new URL("http://fault-proxy.example.test:43120");

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  finishOnSignal?: NodeJS.Signals;
  refuseSignals = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    const finishOnSignal = this.finishOnSignal;
    if (finishOnSignal !== undefined && finishOnSignal === signal) {
      this.finish(null, signal);
      return false;
    }
    if (this.refuseSignals) {
      return false;
    }
    this.finish(null, signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", this.exitCode, this.signalCode);
  }
}

class FakeReservationServer extends EventEmitter {
  listening = false;
  private readonly port: number;
  private readonly scheduleReady: (ready: () => void) => void;

  constructor(port: number, scheduleReady?: (ready: () => void) => void) {
    super();
    this.port = port;
    this.scheduleReady =
      scheduleReady ??
      ((ready) => {
        ready();
      });
  }

  listen(...parameters: [number, string, () => void]): this {
    const ready = parameters[2];
    this.listening = true;
    this.scheduleReady(ready);
    return this;
  }

  address(): NetModule.AddressInfo {
    return { address: "127.0.0.1", family: "IPv4", port: this.port };
  }

  close(callback?: (error?: Error) => void): this {
    this.listening = false;
    callback?.();
    return this;
  }
}

class FakeSocket extends EventEmitter {
  destroy(): this {
    return this;
  }
}

const harnessClient: MoltzapClientModule.HarnessClient = Object.freeze({
  start: () => Effect.void,
  turns: Stream.never,
});

let daemonProcesses: FakeChildProcess[];
let registrarProcesses: FakeChildProcess[];
let registrarExitCode: number;
let nextPort: number;
let onDaemonSpawn: (() => void) | undefined;

beforeEach(() => {
  daemonProcesses = [];
  registrarProcesses = [];
  registrarExitCode = 0;
  nextPort = 45_100;
  onDaemonSpawn = undefined;
  processBoundary.spawn.mockReset();
  networkBoundary.createConnection.mockReset();
  networkBoundary.createServer.mockReset();
  clientBoundary.acquire.mockReset();

  processBoundary.spawn.mockImplementation(
    (
      ...parameters: [string, readonly string[]]
    ): ChildProcessModule.ChildProcess => {
      const processArguments = parameters[1];
      const child = new FakeChildProcess();
      if (processArguments[0] === DAEMON_ENTRYPOINT) {
        daemonProcesses.push(child);
        onDaemonSpawn?.();
      } else if (processArguments[0] === REGISTRAR_ENTRYPOINT) {
        registrarProcesses.push(child);
        queueMicrotask(() => {
          child.finish(registrarExitCode, null);
        });
      } else {
        throw new Error(`unexpected process: ${String(processArguments[0])}`);
      }
      // eslint-disable-next-line agent-code-guard/as-unknown-as, agent-code-guard/require-assertion-rationale -- This test double implements the process events, stdio, exit state, and kill behavior read by the controlled-endpoint boundary.
      return child as unknown as ChildProcessModule.ChildProcess; // #ignore-sloppy-code[as-unknown-as]: This test double implements every process member observed by the controlled-endpoint boundary.
    },
  );
  networkBoundary.createServer.mockImplementation(() => {
    const server = new FakeReservationServer(nextPort);
    nextPort += 1;
    return server;
  });
  networkBoundary.createConnection.mockImplementation(() => {
    const socket = new FakeSocket();
    queueMicrotask(() => {
      socket.emit("connect");
    });
    return socket;
  });
  clientBoundary.acquire.mockImplementation(() =>
    Effect.succeed(harnessClient),
  );
});

function acquireEndpoint() {
  const runtime = makeControlledEndpointRuntime({
    authority: generateSocietyNetworkAuthority("controlled-endpoint-test"),
    resolveAgentId: () => Effect.succeed(AGENT_ID),
  });
  return runtime.acquire({ name: "observer", routerOrigin: ROUTER_ORIGIN });
}

function acquiredClientUrl(callIndex: number): URL {
  const candidate: unknown = clientBoundary.acquire.mock.calls[callIndex]?.[0];
  assert.instanceOf(candidate, URL);
  return candidate;
}

it.scopedLive(
  "fails the receive stream when a ready daemon exits normally",
  () =>
    Effect.gen(function* () {
      const endpoint = yield* acquireEndpoint();
      const daemon = daemonProcesses[0];
      assert.isDefined(daemon);
      daemon.finish(0, null);

      const failure = yield* Stream.runDrain(endpoint.transport.received).pipe(
        Effect.flip,
      );
      assert.instanceOf(failure, NetworkError);
      assert.strictEqual(failure.operation, "receive");
      assert.include(failure.detail, "exited with code 0");
    }),
);

it.scopedLive(
  "fails the receive stream with the terminating daemon signal",
  () =>
    Effect.gen(function* () {
      const endpoint = yield* acquireEndpoint();
      const daemon = daemonProcesses[0];
      assert.isDefined(daemon);
      daemon.finish(null, "SIGABRT");

      const failure = yield* Stream.runDrain(endpoint.transport.received).pipe(
        Effect.flip,
      );
      assert.instanceOf(failure, NetworkError);
      assert.strictEqual(failure.operation, "receive");
      assert.include(failure.detail, "exited after signal SIGABRT");
    }),
);

it.scopedLive(
  "retries a failed verified listener handoff before registration",
  () =>
    Effect.gen(function* () {
      clientBoundary.acquire
        .mockImplementationOnce(() => Effect.fail(new ConnectError()))
        .mockImplementation(() => Effect.succeed(harnessClient));

      yield* acquireEndpoint();

      assert.lengthOf(daemonProcesses, 2);
      assert.lengthOf(registrarProcesses, 1);
      assert.strictEqual(daemonProcesses[0]?.signalCode, "SIGTERM");
      assert.strictEqual(clientBoundary.acquire.mock.calls.length, 3);
      assert.strictEqual(
        acquiredClientUrl(0).href,
        "http://127.0.0.1:45100/mcp",
      );
      assert.strictEqual(
        acquiredClientUrl(1).href,
        "http://127.0.0.1:45101/mcp",
      );
      assert.strictEqual(
        acquiredClientUrl(2).href,
        "http://127.0.0.1:45101/mcp",
      );
    }),
);

it.scopedLive(
  "an interruption pending when spawn returns cannot orphan the daemon",
  () =>
    Effect.gen(function* () {
      const reservationWaiting = yield* Deferred.make<undefined>();
      let releaseReservation: (() => void) | undefined;
      networkBoundary.createServer.mockImplementationOnce(() => {
        const server = new FakeReservationServer(nextPort, (ready) => {
          releaseReservation = ready;
          Effect.runSync(Deferred.succeed(reservationWaiting, undefined));
        });
        nextPort += 1;
        return server;
      });
      // eslint-disable-next-line prefer-const -- The callback must be installed before the acquisition fiber exists, then bound exactly once to that fiber.
      let interruptAcquiring: (() => void) | undefined;
      onDaemonSpawn = () => {
        interruptAcquiring?.();
      };
      const acquiring = yield* Effect.scoped(acquireEndpoint()).pipe(
        Effect.fork,
      );
      interruptAcquiring = () => {
        Effect.runSync(Fiber.interruptFork(acquiring));
      };

      yield* Deferred.await(reservationWaiting);
      yield* Effect.sync(() => {
        releaseReservation?.();
      });
      const acquisition = yield* Fiber.await(acquiring);

      assert.isTrue(Exit.isInterrupted(acquisition));
      assert.strictEqual(daemonProcesses[0]?.signalCode, "SIGTERM");
    }),
);

it.scopedLive("never retries after registration begins", () =>
  Effect.gen(function* () {
    registrarExitCode = 1;

    const failure = yield* acquireEndpoint().pipe(Effect.flip);

    assert.instanceOf(failure, NetworkError);
    assert.strictEqual(failure.operation, "attach-endpoint");
    assert.lengthOf(daemonProcesses, 1);
    assert.lengthOf(registrarProcesses, 1);
    assert.strictEqual(clientBoundary.acquire.mock.calls.length, 1);
  }),
);

it.scoped("bounds teardown when a child rejects both termination signals", () =>
  Effect.gen(function* () {
    const endpointScope = yield* Scope.make();
    yield* acquireEndpoint().pipe(Scope.extend(endpointScope));
    const daemon = daemonProcesses[0];
    assert.isDefined(daemon);
    daemon.refuseSignals = true;

    const closing = yield* Scope.close(endpointScope, Exit.void).pipe(
      Effect.fork,
    );
    yield* Effect.yieldNow();
    yield* TestClock.adjust(Duration.seconds(11));
    yield* Fiber.join(closing);

    assert.deepStrictEqual(daemon.signals, ["SIGTERM", "SIGKILL"]);
  }),
);

it.scoped("observes a synchronous exit at the TERM-to-KILL boundary", () =>
  Effect.gen(function* () {
    const endpointScope = yield* Scope.make();
    yield* acquireEndpoint().pipe(Scope.extend(endpointScope));
    const daemon = daemonProcesses[0];
    assert.isDefined(daemon);
    daemon.refuseSignals = true;
    daemon.finishOnSignal = "SIGKILL";

    const closing = yield* Scope.close(endpointScope, Exit.void).pipe(
      Effect.fork,
    );
    yield* Effect.yieldNow();
    yield* TestClock.adjust(Duration.seconds(6));
    yield* Fiber.join(closing);

    assert.deepStrictEqual(daemon.signals, ["SIGTERM", "SIGKILL"]);
    assert.strictEqual(daemon.signalCode, "SIGKILL");
  }),
);

it.scopedLive("does not signal a process that already exited", () =>
  Effect.gen(function* () {
    const endpointScope = yield* Scope.make();
    yield* acquireEndpoint().pipe(Scope.extend(endpointScope));
    const daemon = daemonProcesses[0];
    assert.isDefined(daemon);
    daemon.finish(0, null);

    yield* Scope.close(endpointScope, Exit.void);

    assert.deepStrictEqual(daemon.signals, []);
  }),
);
