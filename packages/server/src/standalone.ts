/** Standalone server — loads YAML config, boots PGlite, and starts the server. */
// safer-arch-ignore no-cross-domain-sibling-import: This executable is the server composition root and assembles the protocol socket adapter with every runtime domain.
// safer-arch-ignore no-fat-orchestrator: The executable owns the complete protocol requirement Layer catalog used by each socket runtime.

import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Context,
  Data,
  Effect,
  Layer,
  ManagedRuntime,
  Scope,
  unsafeCoerce,
} from "effect";
import { FileSystem } from "@effect/platform";
import type { Socket as EffectSocket } from "@effect/platform/Socket";
import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import type { RpcMiddleware } from "@effect/rpc";
import {
  ConversationSendAccess,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import {
  ActiveAgent,
  AuthenticatedAgent,
  type AgentId,
  type PrincipalRequirement,
} from "@moltzap/protocol/identity";
import {
  MoltZapServer,
  type ConnectionId,
  type MoltZapServerSession,
} from "@moltzap/protocol/socket";
import type { ServerHandlers } from "@moltzap/protocol/socket/catalog";
import { resolveServices, servicesLive, type ResolvedServices } from "#core";
import {
  loadStandaloneConfig,
  type ConfigLoadError,
  type StandaloneBootPlan,
} from "#config";
import { sql, makeEffectKysely, type Database, type Db, DbTag } from "#db";
import { makeCoreHttpApp } from "#http";
import { ConversationServiceTag } from "#conversation";
import { agentConversationCreate } from "#conversation/handlers";
import { obtainConversationSendAccess } from "#conversation/requirements";
import { agentsList } from "#identity/agents";
import { MessageServiceTag } from "#message";
import { messagesSend } from "#message/handlers";
import { connectAgent } from "#network";
import { ConnectionManagerTag, ConnectionTag } from "#socket";
import { narrowByPolicy, peekLiveArm } from "./moltzap/principal-gate.js";

const dirnameValue = dirname(fileURLToPath(import.meta.url));

/** Implements standalone operation failed. */
export class StandaloneOperationFailed extends Data.TaggedError(
  "StandaloneOperationFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
}> {}

/** Implements schema file not found. */
export class SchemaFileNotFound extends Data.TaggedError("SchemaFileNotFound")<{
  readonly message: string;
}> {}

type StandaloneServerError =
  | ConfigLoadError
  | StandaloneOperationFailed
  | SchemaFileNotFound;

const operationFailed = (
  operation: string,
  cause: unknown,
): StandaloneOperationFailed =>
  new StandaloneOperationFailed({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });

// ── Database factory ────────────────────────────────────────────────

interface DbHandle {
  db: Db;
  runMigrationSql: (
    sql: string,
  ) => Effect.Effect<void, StandaloneOperationFailed>;
}

interface PgLiteClientHandle {
  readonly exec: (sql: string) => PromiseLike<unknown>;
}

function createPgLiteDb(
  dataDir?: string,
): Effect.Effect<DbHandle, StandaloneOperationFailed> {
  return Effect.gen(function* () {
    const { KyselyPGlite } = yield* Effect.tryPromise({
      try: () => import("kysely-pglite"),
      catch: (cause) => operationFailed("load kysely-pglite", cause),
    });

    const kpg = yield* Effect.tryPromise({
      try: () =>
        dataDir ? KyselyPGlite.create(dataDir) : KyselyPGlite.create(),
      catch: (cause) => operationFailed("create pglite database", cause),
    });

    // Effect-patched Kysely: builder chains can be used as `Effect`s inside
    // services while the promise API (`.execute()`, `.transaction()`) still
    // works for migration/seed code.
    const db = makeEffectKysely<Database>({
      dialect: kpg.dialect,
    });

    return {
      db,
      runMigrationSql: (sqlText: string) =>
        runPgLiteMigrationSql(kpg.client, sqlText),
    };
  });
}

function runPgLiteMigrationSql(
  client: PgLiteClientHandle,
  sqlText: string,
): Effect.Effect<void, StandaloneOperationFailed> {
  return Effect.tryPromise({
    try: () => client.exec(sqlText),
    catch: (cause) => operationFailed("run pglite migration sql", cause),
  }).pipe(Effect.asVoid);
}

// ── Migration ───────────────────────────────────────────────────────

function findSchemaFile(): Effect.Effect<string, SchemaFileNotFound> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = (candidate: string) =>
      fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

    // Dev (tsx): running from src/, schema in src/db/
    const devPath = join(dirnameValue, "db", "core-schema.sql");
    if (yield* exists(devPath)) {
      return devPath;
    }
    // Compiled (node dist/): schema in ../src/db/
    const distPath = join(dirnameValue, "..", "src", "db", "core-schema.sql");
    if (yield* exists(distPath)) {
      return distPath;
    }
    return yield* new SchemaFileNotFound({
      message:
        "Cannot find core-schema.sql. Ensure it exists at the package root or in src/db/.",
    });
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

/**
 * A database whose `agents` table exists but whose `messages` table lacks
 * either plaintext parts or database-owned ordering predates the current
 * schema generation (or was partially migrated by hand). Booting against it
 * would pass the has-schema gate and then fail on every send at runtime, so
 * the mismatch is a boot error, not a skip: there is no in-place migration
 * path. The check asserts the required current shape in the connection's own
 * schema rather than probing for retired artifacts, so unrelated tables in
 * other schemas cannot trip it.
 * @param handle Value supplied to the operation.
 * @returns Failure when the schema predates the current generation.
 */
function rejectIncompatibleSchema(
  handle: DbHandle,
): Effect.Effect<void, StandaloneOperationFailed> {
  return Effect.gen(function* () {
    const shape = yield* Effect.tryPromise({
      try: () =>
        sql<{ has_current_shape: boolean }>`
          SELECT
            EXISTS (
              SELECT FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'messages'
                AND column_name = 'parts'
            )
            AND EXISTS (
              SELECT FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'messages'
                AND column_name = 'seq'
                AND data_type = 'bigint'
                AND is_identity = 'YES'
                AND identity_generation = 'ALWAYS'
            ) AS has_current_shape
        `.execute(handle.db),
      catch: (cause) => operationFailed("check schema generation", cause),
    });
    if (shape.rows[0]?.has_current_shape !== true) {
      return yield* Effect.fail(
        operationFailed(
          "verify schema generation",
          new Error(
            "database schema lacks the current messages.parts or database-owned messages.seq shape and has no in-place migration; recreate the database from db/core-schema.sql",
          ),
        ),
      );
    }
  });
}

/**
 * Apply the current schema to an empty database or verify that an existing
 * database already has the required generation. Raw DDL stays behind the
 * handle because Kysely cannot query tables before they exist.
 * @param handle Value supplied to the operation.
 * @returns The auto-migrate effect result.
 */
function autoMigrateEffect(
  handle: DbHandle,
): Effect.Effect<
  void,
  SchemaFileNotFound | StandaloneOperationFailed,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        sql<{ has_schema: boolean }>`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name = 'agents'
          ) AS has_schema
        `.execute(handle.db),
      catch: (cause) => operationFailed("check database schema", cause),
    });

    if (result.rows[0]?.has_schema) {
      yield* rejectIncompatibleSchema(handle);
      yield* Effect.logInfo(
        "Database schema already exists, skipping migration",
      );
      return;
    }

    yield* Effect.logInfo("Applying database schema...");

    const fs = yield* FileSystem.FileSystem;
    const schemaPath = yield* findSchemaFile();
    const schema = yield* fs
      .readFileString(schemaPath, "utf-8")
      .pipe(Effect.mapError((cause) => operationFailed("read schema", cause)));

    yield* handle.runMigrationSql(schema);

    yield* Effect.logInfo("Database schema applied successfully");
  });
}

// ── Main ────────────────────────────────────────────────────────────

/**
 * Executes the start server operation.
 * @param configPath Value supplied to the operation.
 * @returns The start server result.
 */
export function startServer(configPath?: string) {
  if (configPath === undefined) {
    return Effect.runPromise(startServerEffect());
  }
  return Effect.runPromise(startServerEffect(configPath));
}

interface StandaloneServerHandle {
  readonly app: StandaloneApp;
  readonly bootPlan: StandaloneBootPlan;
}

interface StandaloneApp {
  readonly port: number;
}

function startServerEffect(
  configPath?: string,
): Effect.Effect<StandaloneServerHandle, StandaloneServerError> {
  return Effect.gen(function* () {
    const bootPlan = yield* loadStandaloneConfig({ configPath });
    const database = yield* createPgLiteDb(bootPlan.pgliteDataDir);
    yield* migrateStandaloneDatabase(database);
    yield* Effect.logWarning("Boot admin user configured").pipe(
      Effect.annotateLogs({ adminUserId: bootPlan.adminUserId }),
    );
    const app = startStandaloneApp(bootPlan, database.db);
    yield* logStandaloneStarted(app);
    return { app, bootPlan };
  }).pipe(Effect.withSpan("startServerEffect"));
}

function migrateStandaloneDatabase(handle: DbHandle) {
  return autoMigrateEffect(handle).pipe(Effect.provide(NodeFileSystem.layer));
}

function makeStandaloneRuntime(db: Db) {
  const baseLive = Layer.succeed(DbTag, db);
  const fullLive = Layer.provideMerge(servicesLive, baseLive);
  const dispatchRuntime = ManagedRuntime.make(
    Layer.mergeAll(NodeHttpServer.layerContext, fullLive),
  );
  const services = dispatchRuntime.runSync(resolveServices);
  return { dispatchRuntime, services };
}

type ConnectionManagerService = Parameters<typeof peekLiveArm>[0];

const callerAgentIdFor = (
  manager: ConnectionManagerService,
  connId: ConnectionId,
): Effect.Effect<AgentId> =>
  peekLiveArm(manager, connId).pipe(
    Effect.flatMap((connection) =>
      connection._tag === "AgentConnection"
        ? Effect.succeed(connection.auth.agentId)
        : Effect.dieMessage(
            `requirement middleware: agent-gated requirement reached on ${connection._tag} arm`,
          ),
    ),
  );

const principalLayer = <Mw extends RpcMiddleware.TagClassAny>(
  mw: Mw,
  connId: ConnectionId,
  narrowAs: PrincipalRequirement,
  requireActiveAgent: boolean,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, ConnectionManagerTag> =>
  unsafeCoerce(
    Layer.effect(
      mw,
      Effect.gen(function* () {
        const manager = yield* ConnectionManagerTag;
        return () =>
          peekLiveArm(manager, connId).pipe(
            Effect.flatMap((connection) =>
              narrowByPolicy(requireActiveAgent, connection, narrowAs),
            ),
            Effect.asVoid,
            Effect.withSpan(`requirement.${mw.key}`),
          );
      }),
    ),
  );

const makeAuthenticatedAgentLayer = (connId: ConnectionId) =>
  principalLayer(AuthenticatedAgent, connId, AuthenticatedAgent, false);

const makeActiveAgentLayer = (connId: ConnectionId) =>
  principalLayer(ActiveAgent, connId, AuthenticatedAgent, true);

type MwEnv = ConversationServiceTag | MessageServiceTag;

interface MwOptions {
  readonly clientId: number;
  readonly rpc: { readonly _tag: string };
  readonly payload: unknown;
}

interface SendParams {
  readonly conversationId: ConversationId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSendParams = (payload: unknown): payload is SendParams =>
  isRecord(payload) && typeof payload.conversationId === "string";

function requirePayload<A>(
  payload: unknown,
  guard: (payload: unknown) => payload is A,
  requirement: string,
): Effect.Effect<A> {
  if (guard(payload)) {
    return Effect.succeed(payload);
  }
  return Effect.dieMessage(
    `requirement middleware ${requirement}: incompatible RPC payload`,
  );
}

const mwEnv = Effect.gen(function* () {
  const conversationService = yield* ConversationServiceTag;
  const messageService = yield* MessageServiceTag;
  const manager = yield* ConnectionManagerTag;
  return Context.empty().pipe(
    Context.add(ConversationServiceTag, conversationService),
    Context.add(MessageServiceTag, messageService),
    Context.add(ConnectionManagerTag, manager),
  );
});

type RequirementMiddlewareLayerR =
  | ConversationServiceTag
  | MessageServiceTag
  | ConnectionManagerTag;

type MiddlewareFailure<Mw extends RpcMiddleware.TagClassAny> =
  Context.Tag.Service<Mw> extends RpcMiddleware.RpcMiddleware<
    unknown,
    infer Failure
  >
    ? Failure
    : never;

const requirementMiddlewareLayerWithCaller = <
  Mw extends RpcMiddleware.TagClassAny,
  Value,
  In,
>(
  mw: Mw,
  connId: ConnectionId,
  derive: (payload: unknown, callerAgentId: AgentId) => Effect.Effect<In>,
  obtain: (input: In) => Effect.Effect<Value, MiddlewareFailure<Mw>, MwEnv>,
): Layer.Layer<
  Context.Tag.Identifier<Mw>,
  never,
  RequirementMiddlewareLayerR
> =>
  unsafeCoerce(
    Layer.effect(
      mw,
      Effect.map(
        mwEnv,
        (env) =>
          ({ payload }: MwOptions) =>
            Effect.gen(function* () {
              const callerAgentId = yield* callerAgentIdFor(
                Context.get(env, ConnectionManagerTag),
                connId,
              );
              const input = yield* derive(payload, callerAgentId);
              return yield* obtain(input);
            }).pipe(Effect.asVoid, Effect.provide(env)),
      ),
    ),
  );

const makeConversationSendAccessLayer = (connId: ConnectionId) =>
  requirementMiddlewareLayerWithCaller(
    ConversationSendAccess,
    connId,
    (payload, senderAgentId) =>
      requirePayload(payload, isSendParams, ConversationSendAccess.key).pipe(
        Effect.map((p) => ({
          conversationId: p.conversationId,
          senderAgentId,
        })),
      ),
    obtainConversationSendAccess,
  );

const makeRequirementMiddlewareLayers = (connId: ConnectionId) =>
  Layer.mergeAll(
    makeAuthenticatedAgentLayer(connId),
    makeActiveAgentLayer(connId),
    makeConversationSendAccessLayer(connId),
  );

const serverHandlers: ServerHandlers = {
  "agent/network/connect": connectAgent,
  "agent/identity/agents/list": agentsList,
  "agent/message/send": messagesSend,
  "agent/conversation/create": agentConversationCreate,
} as const;

const makeConnectionTagLayer = (
  connId: ConnectionId,
): Layer.Layer<ConnectionTag, never, ConnectionManagerTag> =>
  Layer.effect(
    ConnectionTag,
    ConnectionManagerTag.pipe(
      Effect.flatMap((manager) => peekLiveArm(manager, connId)),
    ),
  );

function makeMoltzapSocketHandler(options: {
  readonly services: ResolvedServices;
}) {
  const protocolServer = new MoltZapServer({
    handlers: serverHandlers,
    authLayer: makeRequirementMiddlewareLayers,
    connectionLayer: makeConnectionTagLayer,
    onOpen: (session) =>
      options.services.connections.addUnauthenticated(
        session.connId,
        session.originator,
      ),
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lifecycle callback is invoked after module initialization.
    onClose: (...[, session]) => closeSocketSession(session, options),
  });
  return (socket: EffectSocket) => protocolServer.handleSocket(socket);
}

const closeSocketSession = Effect.fn("socket.closeSession")(function* (
  session: MoltZapServerSession,
  options: {
    readonly services: ResolvedServices;
  },
) {
  const removed = yield* options.services.connections.removeAndReturn(
    session.connId,
  );
  if (removed !== undefined && removed._tag === "AgentConnection") {
    const authCtx = removed.auth;
    yield* options.services.agentEndpointResolver.remove(
      authCtx.agentId,
      session.connId,
    );
  }
});

function startStandaloneApp(
  bootPlan: StandaloneBootPlan,
  db: Db,
): StandaloneApp {
  const { dispatchRuntime, services } = makeStandaloneRuntime(db);
  const handleSocket = makeMoltzapSocketHandler({ services });
  const httpApp = makeCoreHttpApp({
    corsOrigins: bootPlan.corsOrigins,
    registrationSecret: bootPlan.registrationSecret,
    adminUserId: bootPlan.adminUserId,
    authService: services.authService,
    connections: services.connections,
    handleSocket,
  });
  const appScope = Effect.runSync(Scope.make());
  let actualPort = bootPlan.port;
  const startup = Effect.gen(function* () {
    const serverSvc = yield* NodeHttpServer.make(() => createServer(), {
      port: bootPlan.port,
      host: "0.0.0.0",
    });
    yield* serverSvc.serve(httpApp);
    const addr = serverSvc.address;
    actualPort = addr._tag === "TcpAddress" ? addr.port : bootPlan.port;
    yield* Effect.logInfo("MoltZap core server listening").pipe(
      Effect.annotateLogs({ port: actualPort }),
    );
  }).pipe(
    Effect.withSpan("startStandaloneApp.startup"),
    Scope.extend(appScope),
  );

  dispatchRuntime.runPromise(startup).catch((err: unknown) => {
    Effect.runFork(
      Effect.logError("Server startup failed").pipe(
        Effect.annotateLogs({ err }),
      ),
    );
  });

  return {
    get port() {
      return actualPort;
    },
  };
}

function logStandaloneStarted(app: StandaloneApp): Effect.Effect<void> {
  return Effect.logInfo("MoltZap server started (standalone mode)").pipe(
    Effect.annotateLogs({
      port: app.port,
      mode: "standalone",
      db: "pglite",
    }),
  );
}

// Auto-start when run directly (e.g. `node dist/standalone.js`,
// `tsx watch src/standalone.ts`). `bin/moltzap-server` calls
// `startServer()` explicitly via import, so its argv[1] doesn't match
// the standalone suffix and this guard skips.
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- entrypoint-detection: process.argv is the only way to check whether this file was loaded as the direct entry vs. imported by the bin script
const argv1 = process.argv[1];
if (
  argv1?.endsWith("standalone.js") === true ||
  argv1?.endsWith("standalone.ts") === true
) {
  startServer().catch((err: unknown) => {
    Effect.runFork(
      Effect.logError("Server startup failed").pipe(
        Effect.annotateLogs({ err }),
      ),
    );
    process.exit(1);
  });
}
