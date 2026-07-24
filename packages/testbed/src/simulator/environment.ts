/**
 * @file Environment (contract 2): wiring per-agent MCP servers and
 * skills into each runtime at spawn time. Every mounted MCP server is
 * wrapped in the logging proxy; the proxy is interface-transparent (tool
 * results byte-identical with and without it) and taps every call and
 * result into the event log. Environment semantics (what the tools do)
 * live entirely with the consumer; the simulator only mounts them.
 */
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Schema, type Scope } from "effect";
import type { Socket } from "@effect/platform";
import { NodeSocketServer } from "@effect/platform-node";
import { CorrelationId, WallTimeMs } from "./ids.js";
import { JsonValue, type Agent } from "./run-spec.js";
import type { EventLog } from "./event-log.js";
import type { Secrets } from "./recording.js";
import { LoggingProxyFailed, type MountFailed } from "./errors.js";

/**
 * Adapter-facing mount material for one agent. Each runtime adapter
 * consumes the plan its own way: OpenClaw via plugin/CLI config,
 * Nanoclaw via container mounts; an agent without MCP servers yields an empty
 * plan and the no-mount launch path is unchanged.
 */
export type MountPlan = {
  readonly agent: Agent["name"];

  /**
   * Proxied MCP server endpoints, one per declared MCP server, in
   * spec order. Each endpoint fronts the consumer's MCP server through
   * the logging proxy.
   */
  readonly proxiedServers: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  }>;
};

/** A prepared mount: the adapter-facing plan plus the proxy health channel. */
export type MountHandle = {
  readonly plan: MountPlan;
  /** Resolves only if a proxy or mounted server fails after launch; `run` races it. */
  awaitFailure(): Effect.Effect<never, LoggingProxyFailed, never>;
};

/**
 * Environment contract. `prepare` spawns the consumer's MCP servers
 * behind logging proxies and returns the plan the runtime adapter wires
 * in at spawn time; proxies and servers are released at scope close.
 * Mount env values that are credential material are registered in
 * `secrets` before any proxy starts.
 */
export interface Environment {
  prepare(
    agent: Agent,
    log: EventLog,
    secrets: Secrets,
  ): Effect.Effect<MountHandle, MountFailed | LoggingProxyFailed, Scope.Scope>;
}

/** Create the v0 environment mount (stdio MCP servers behind the logging proxy). */
export function makeEnvironment(): Environment {
  return { prepare };
}

const PROXY_MAIN_PATH = fileURLToPath(
  new URL("../../simulator-assets/mcp-logging-proxy.mjs", import.meta.url),
);

/** One NDJSON report per intercepted frame, sent by the proxy over the tap socket. */
const TapReport = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("call"),
    mount: Schema.String,
    id: Schema.Union(Schema.String, Schema.Number),
    tool: Schema.String,
    args: JsonValue,
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    mount: Schema.String,
    id: Schema.Union(Schema.String, Schema.Number),
    tool: Schema.String,
    result: JsonValue,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("fatal"),
    mount: Schema.String,
    message: Schema.String,
  }),
).annotations({ description: "MCP logging-proxy tap report" });

const decodeTapReport = Schema.decodeUnknownOption(Schema.parseJson(TapReport));

type TapContext = {
  readonly agent: Agent;
  readonly log: EventLog;
  readonly failure: Deferred.Deferred<never, LoggingProxyFailed>;
  readonly closing: { value: boolean };
};

function prepare(
  agent: Agent,
  log: EventLog,
  secrets: Secrets,
): Effect.Effect<MountHandle, MountFailed | LoggingProxyFailed, Scope.Scope> {
  return Effect.gen(function* () {
    registerMountSecrets(agent, secrets);
    const failure = yield* Deferred.make<never, LoggingProxyFailed>();
    if (agent.mcpServers.length === 0) {
      return {
        plan: { agent: agent.name, proxiedServers: [] },
        awaitFailure: () => Deferred.await(failure),
      };
    }
    const ctx: TapContext = {
      agent,
      log,
      failure,
      closing: { value: false },
    };
    const tapPort = yield* startTapServer(ctx);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ctx.closing.value = true;
      }),
    );
    return {
      plan: {
        agent: agent.name,
        proxiedServers: agent.mcpServers.map((server) => ({
          name: server.name,
          command: process.execPath,
          args: [
            PROXY_MAIN_PATH,
            "--tap",
            String(tapPort),
            "--mount",
            server.name,
            "--",
            server.command,
            ...server.args,
          ],
          env: server.env,
        })),
      },
      awaitFailure: () => Deferred.await(failure),
    };
  }).pipe(Effect.withSpan("Environment.prepare"));
}

/** Mount env values are credential material until proven otherwise; they register before any proxy starts. */
function registerMountSecrets(agent: Agent, secrets: Secrets): void {
  for (const server of agent.mcpServers) {
    for (const value of Object.values(server.env)) {
      secrets.register(value);
    }
  }
}

function proxyFailed(agent: Agent, detail: string): LoggingProxyFailed {
  return new LoggingProxyFailed({
    slot: agent.name,
    mount: "*",
    message: `The MCP logging proxy for agent "${agent.name}" failed: ${detail}. Capture is total, so the run seals with reason logging-proxy-failed.`,
  });
}

function startTapServer(
  ctx: TapContext,
): Effect.Effect<number, LoggingProxyFailed, Scope.Scope> {
  return Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({
      host: "127.0.0.1",
      port: 0,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(proxyFailed(ctx.agent, `tap bind failed: ${String(cause)}`)),
      ),
    );
    yield* Effect.forkScoped(
      server.run((connection) => serveTapConnection(ctx, connection)),
    );
    return server.address._tag === "TcpAddress" ? server.address.port : 0;
  });
}

/**
 * One tap connection per proxy process. The connection closing while the
 * mount is still live means the proxy died; capture is total, so that is
 * a logging-proxy failure, not a silent gap.
 */
function serveTapConnection(
  ctx: TapContext,
  connection: Socket.Socket,
): Effect.Effect<void, never, never> {
  const buffer = { value: "" };
  return connection
    .runRaw((chunk) => consumeTapChunk(ctx, buffer, chunk))
    .pipe(
      Effect.catchAll(() => Effect.void),
      Effect.zipRight(
        ctx.closing.value
          ? Effect.void
          : Deferred.fail(
              ctx.failure,
              proxyFailed(ctx.agent, "the proxy process disconnected mid-run"),
            ).pipe(Effect.asVoid),
      ),
    );
}

function consumeTapChunk(
  ctx: TapContext,
  buffer: { value: string },
  chunk: string | Uint8Array,
): Effect.Effect<void, never, never> {
  buffer.value +=
    typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  const lines = buffer.value.split("\n");
  buffer.value = lines.pop() ?? "";
  return Effect.forEach(
    lines.filter((line) => line.trim().length > 0),
    (line) => handleTapLine(ctx, line),
    { concurrency: 1, discard: true },
  );
}

function handleTapLine(
  ctx: TapContext,
  line: string,
): Effect.Effect<void, never, never> {
  const decoded = decodeTapReport(line);
  if (decoded._tag === "None") return Effect.void;
  const report = decoded.value;
  switch (report.type) {
    case "fatal":
      return Deferred.fail(
        ctx.failure,
        proxyFailed(ctx.agent, report.message),
      ).pipe(Effect.asVoid);
    case "call":
      return enqueueProxyEvent(ctx, {
        _tag: "proxy.tool-call",
        correlationId: correlationFor(ctx, report.mount, report.id),
        agent: ctx.agent.name,
        mount: report.mount,
        tool: report.tool,
        args: report.args,
      });
    case "result":
      return enqueueProxyEvent(ctx, {
        _tag: "proxy.tool-result",
        correlationId: correlationFor(ctx, report.mount, report.id),
        agent: ctx.agent.name,
        mount: report.mount,
        tool: report.tool,
        result: report.result,
        isError: report.isError,
      });
    default: {
      const exhaustive: never = report;
      return Effect.dieMessage(
        `unreachable tap report ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Call/result pairing key: one correlation per (mount, JSON-RPC id) exchange. */
function correlationFor(
  ctx: TapContext,
  mount: string,
  id: string | number,
): CorrelationId {
  return Schema.decodeSync(CorrelationId)(
    `${ctx.agent.name}/${mount}/tool-call/${String(id)}`,
  );
}

function enqueueProxyEvent(
  ctx: TapContext,
  fields:
    | {
        readonly _tag: "proxy.tool-call";
        readonly correlationId: CorrelationId;
        readonly agent: Agent["name"];
        readonly mount: string;
        readonly tool: string;
        readonly args: JsonValue;
      }
    | {
        readonly _tag: "proxy.tool-result";
        readonly correlationId: CorrelationId;
        readonly agent: Agent["name"];
        readonly mount: string;
        readonly tool: string;
        readonly result: JsonValue;
        readonly isError: boolean;
      },
): Effect.Effect<void, never, never> {
  return ctx.log
    .enqueue({
      ...fields,
      source: "proxy",
      wallTime: Schema.decodeSync(WallTimeMs)(Date.now()),
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("EventLogSealed", () => Effect.void),
    );
}
