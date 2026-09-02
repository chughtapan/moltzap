/** @file Effect SQL storage and resumable execution for evaluation reports. */

import type { SqlError } from "@effect/sql/SqlError";
import { FileSystem, Path } from "@effect/platform";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as Migrator from "@effect/sql/Migrator";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  type ParseResult,
  Ref,
  Schema,
} from "effect";
import {
  appendEvaluationAttempt,
  CompletedEvaluationReport,
  completeEvaluationReport,
  createEvaluationReport,
  evaluationPlanDigest,
  type EvaluationReport,
  evaluationReportId,
  type EvaluationReportId,
  EvaluationReportPlan,
  type EvaluationReportValidationError,
  type EvaluationSweepCell,
  InProgressEvaluationReport,
  remainingEvaluationCells,
  resumeEvaluationReport,
  terminalAttempt,
  type TerminalAttempt as TerminalAttemptType,
  validateEvaluationReport,
} from "./sweep.js";

const REPORT_FORMAT_VERSION = 3;
const RESULT_DIRECTORY_MODE = 0o700;
const RESULT_FILE_MODE = 0o600;
const EMPTY_DATABASE = new Uint8Array();

const evaluationReportPlanText = Schema.parseJson(EvaluationReportPlan);
const terminalAttemptText = Schema.parseJson(terminalAttempt);

const reportRow = Schema.Struct({
  reportId: evaluationReportId,
  formatVersion: Schema.Literal(REPORT_FORMAT_VERSION),
  planDigest: evaluationPlanDigest,
  planJson: Schema.String,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  completedAt: Schema.NullOr(Schema.DateTimeUtc),
});

const attemptRow = Schema.Struct({
  ordinal: Schema.Int.pipe(Schema.nonNegative()),
  attemptJson: Schema.String,
});

const reportIdentityRow = Schema.Struct({
  reportId: evaluationReportId,
});

const attemptIdentityRow = Schema.Struct({
  ordinal: Schema.Int.pipe(Schema.nonNegative()),
});

const reportInsert = Schema.Struct({
  reportId: evaluationReportId,
  formatVersion: Schema.Literal(REPORT_FORMAT_VERSION),
  planDigest: evaluationPlanDigest,
  planJson: Schema.String,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});

const attemptInsert = Schema.Struct({
  reportId: evaluationReportId,
  ordinal: Schema.Int.pipe(Schema.nonNegative()),
  terminalJson: Schema.String,
  updatedAt: Schema.DateTimeUtc,
});

const completionUpdate = Schema.Struct({
  reportId: evaluationReportId,
  completedAt: Schema.DateTimeUtc,
});

const leaseRow = Schema.Struct({
  ownerPid: Schema.Int,
});

const leaseInsert = Schema.Struct({
  ownerPid: Schema.Int,
  acquiredAt: Schema.DateTimeUtc,
});

const leaseTakeover = Schema.Struct({
  ownerPid: Schema.Int,
  previousOwnerPid: Schema.Int,
  acquiredAt: Schema.DateTimeUtc,
});

/** A result bundle already owns its single report identity. */
class EvaluationResultAlreadyExists extends Schema.TaggedError<EvaluationResultAlreadyExists>()(
  "EvaluationResultAlreadyExists",
  {
    reportId: evaluationReportId,
  },
) {}

/** The selected result bundle contains no report. */
class EvaluationResultNotFound extends Schema.TaggedError<EvaluationResultNotFound>()(
  "EvaluationResultNotFound",
  {
    databasePath: Schema.NonEmptyString,
  },
) {}

/** Durable state disagrees with the immutable transition being appended. */
class EvaluationResultConflict extends Schema.TaggedError<EvaluationResultConflict>()(
  "EvaluationResultConflict",
  {
    reportId: evaluationReportId,
    detail: Schema.NonEmptyString,
  },
) {}

/**
 * Another live process on this host holds the report open.
 *
 * Two sweeps over one report would each take a window of the same remaining
 * cells and submit them twice. The lease is a row naming the holder's process,
 * so a holder that died leaves a lease a later opener can tell is stale; a
 * holder on another host cannot be told apart from a live one, and report
 * bundles are local files.
 */
export class ReportLocked extends Schema.TaggedError<ReportLocked>()(
  "ReportLocked",
  {
    databasePath: Schema.NonEmptyString,
    ownerPid: Schema.Int,
  },
) {}

type ExecuteCell<E, R> = (
  cell: EvaluationSweepCell,
) => Effect.Effect<TerminalAttemptType, E, R>;

/** How wide one sweep submits cells. */
export interface EvaluationSweepOptions {
  /** Cells executed at once; one keeps the sequential behaviour. */
  readonly concurrency?: number;
}

interface EvaluationResultStoreService {
  readonly databasePath: string;
  readonly create: (
    report: InProgressEvaluationReport,
  ) => Effect.Effect<
    InProgressEvaluationReport,
    | EvaluationReportValidationError
    | EvaluationResultAlreadyExists
    | ParseResult.ParseError
    | SqlError
  >;
  readonly load: () => Effect.Effect<
    EvaluationReport,
    | EvaluationReportValidationError
    | EvaluationResultNotFound
    | ParseResult.ParseError
    | SqlError
  >;
  readonly advance: <E, R>(
    execute: ExecuteCell<E, R>,
    concurrency: number,
  ) => Effect.Effect<
    EvaluationReport,
    | E
    | EvaluationReportValidationError
    | EvaluationResultConflict
    | EvaluationResultNotFound
    | ParseResult.ParseError
    | SqlError,
    R
  >;
}

/** Report-local SQL repository used by execution, resume, and publication. */
class EvaluationResultStore extends Context.Tag(
  "@moltzap/evals/EvaluationResultStore",
)<EvaluationResultStore, EvaluationResultStoreService>() {}

const migrations = Migrator.fromRecord({
  "1_evaluation_results": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE evaluation_reports (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        report_id TEXT NOT NULL UNIQUE,
        format_version INTEGER NOT NULL,
        plan_digest TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT
    `;
    yield* sql`
      CREATE TABLE evaluation_attempts (
        report_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        terminal_json TEXT NOT NULL,
        FOREIGN KEY (report_id)
          REFERENCES evaluation_reports(report_id)
          ON DELETE CASCADE,
        PRIMARY KEY (report_id, ordinal)
      ) STRICT
    `;
  }),
  "2_report_lease": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE evaluation_report_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      ) STRICT
    `;
  }),
});

/**
 * Open one report-local SQLite bundle.
 *
 * The owning directory is private, SQLite WAL is enabled by the official
 * client, and migrations run before the repository becomes available.
 * @param databasePath Report-local SQLite file to create or reopen.
 * @returns A closed live layer that owns its platform and SQL resources.
 */
export function evaluationResultStoreLayer(databasePath: string) {
  const sqlLayer = SqliteClient.layer({ filename: databasePath });
  const storeLayer = Layer.scoped(
    EvaluationResultStore,
    makeStore(databasePath),
  ).pipe(Layer.provide(sqlLayer));
  return Layer.unwrapEffect(
    prepareResultBundle(databasePath).pipe(Effect.as(storeLayer)),
  );
}

/**
 * Execute missing cells in windows of the chosen width.
 *
 * Each window takes the next remaining cells in plan order, runs them at
 * once, and commits finished attempts as a prefix in that order, so the
 * durable report is always a plan-order prefix and resume needs no other
 * rule. Interruption or process failure loses at most the window's finished
 * but not yet committed cells, which the next resume runs again.
 * @param execute Customer cell execution policy.
 * @param options Window width; one cell at a time when omitted.
 * @returns The completed report Effect.
 */
export function runEvaluationSweep<E, R>(
  execute: ExecuteCell<E, R>,
  options: EvaluationSweepOptions = {},
) {
  const concurrency = options.concurrency ?? 1;
  return Effect.gen(function* () {
    const store = yield* EvaluationResultStore;
    while (true) {
      const report = yield* store.advance(execute, concurrency);
      if (report instanceof CompletedEvaluationReport) {
        return report;
      }
    }
  }).pipe(Effect.withSpan("evals.runEvaluationSweep"));
}

function conflict(
  reportId: EvaluationReportId,
  detail: string,
): EvaluationResultConflict {
  return EvaluationResultConflict.make({ reportId, detail });
}

function makeQueries(sql: SqlClient.SqlClient) {
  return {
    insertReport: makeInsertReport(sql),
    selectReport: makeSelectReport(sql),
    selectAttempts: makeSelectAttempts(sql),
    insertAttempt: makeInsertAttempt(sql),
    updateAfterAttempt: makeUpdateAfterAttempt(sql),
    markCompleted: makeMarkCompleted(sql),
    acquireWrite: makeAcquireWrite(sql),
    selectLease: makeSelectLease(sql),
    insertLease: makeInsertLease(sql),
    takeOverLease: makeTakeOverLease(sql),
    releaseLease: makeReleaseLease(sql),
  };
}

function makeSelectLease(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: Schema.Void,
    Result: leaseRow,
    execute: () => sql`
      SELECT owner_pid AS "ownerPid"
      FROM evaluation_report_lease
      WHERE singleton = 1
    `,
  });
}

function makeInsertLease(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: leaseInsert,
    Result: leaseRow,
    execute: (request) => sql`
      INSERT INTO evaluation_report_lease (singleton, owner_pid, acquired_at)
      VALUES (1, ${request.ownerPid}, ${request.acquiredAt})
      ON CONFLICT (singleton) DO NOTHING
      RETURNING owner_pid AS "ownerPid"
    `,
  });
}

function makeTakeOverLease(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: leaseTakeover,
    Result: leaseRow,
    execute: (request) => sql`
      UPDATE evaluation_report_lease
      SET owner_pid = ${request.ownerPid}, acquired_at = ${request.acquiredAt}
      WHERE singleton = 1 AND owner_pid = ${request.previousOwnerPid}
      RETURNING owner_pid AS "ownerPid"
    `,
  });
}

function makeReleaseLease(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: leaseRow,
    Result: leaseRow,
    execute: (request) => sql`
      DELETE FROM evaluation_report_lease
      WHERE singleton = 1 AND owner_pid = ${request.ownerPid}
      RETURNING owner_pid AS "ownerPid"
    `,
  });
}

type ResultQueries = ReturnType<typeof makeQueries>;

function makeInsertReport(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: reportInsert,
    Result: reportIdentityRow,
    execute: (request) => sql`
      INSERT INTO evaluation_reports (
        singleton,
        report_id,
        format_version,
        plan_digest,
        plan_json,
        created_at,
        updated_at
      )
      VALUES (
        1,
        ${request.reportId},
        ${request.formatVersion},
        ${request.planDigest},
        ${request.planJson},
        ${request.createdAt},
        ${request.updatedAt}
      )
      ON CONFLICT (singleton) DO NOTHING
      RETURNING report_id AS "reportId"
    `,
  });
}

function makeSelectReport(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: Schema.Void,
    Result: reportRow,
    execute: () => sql`
      SELECT
        report_id AS "reportId",
        format_version AS "formatVersion",
        plan_digest AS "planDigest",
        plan_json AS "planJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM evaluation_reports
      WHERE singleton = 1
    `,
  });
}

function makeSelectAttempts(sql: SqlClient.SqlClient) {
  return SqlSchema.findAll({
    Request: Schema.Void,
    Result: attemptRow,
    execute: () => sql`
      SELECT
        ordinal,
        terminal_json AS "attemptJson"
      FROM evaluation_attempts
      ORDER BY ordinal
    `,
  });
}

function makeInsertAttempt(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: attemptInsert,
    Result: attemptIdentityRow,
    execute: (request) => sql`
      INSERT INTO evaluation_attempts (
        report_id,
        ordinal,
        terminal_json
      )
      VALUES (
        ${request.reportId},
        ${request.ordinal},
        ${request.terminalJson}
      )
      ON CONFLICT DO NOTHING
      RETURNING ordinal
    `,
  });
}

function makeUpdateAfterAttempt(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: attemptInsert,
    Result: reportIdentityRow,
    execute: (request) => sql`
      UPDATE evaluation_reports
      SET updated_at = ${request.updatedAt}
      WHERE singleton = 1
        AND report_id = ${request.reportId}
        AND completed_at IS NULL
      RETURNING report_id AS "reportId"
    `,
  });
}

function makeMarkCompleted(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: completionUpdate,
    Result: reportIdentityRow,
    execute: (request) => sql`
      UPDATE evaluation_reports
      SET
        updated_at = ${request.completedAt},
        completed_at = ${request.completedAt}
      WHERE singleton = 1
        AND report_id = ${request.reportId}
        AND completed_at IS NULL
      RETURNING report_id AS "reportId"
    `,
  });
}

function makeAcquireWrite(sql: SqlClient.SqlClient) {
  return SqlSchema.findOne({
    Request: Schema.Void,
    Result: reportIdentityRow,
    execute: () => sql`
      UPDATE evaluation_reports
      SET updated_at = updated_at
      WHERE singleton = 1
      RETURNING report_id AS "reportId"
    `,
  });
}

const loadStoredReport = Effect.fn("evals.results.load")(function* (
  databasePath: string,
  queries: ResultQueries,
) {
  const row = yield* queries.selectReport(undefined);
  if (Option.isNone(row)) {
    return yield* Effect.fail(EvaluationResultNotFound.make({ databasePath }));
  }
  const plan = yield* Schema.decodeUnknown(evaluationReportPlanText)(
    row.value.planJson,
    { onExcessProperty: "error" },
  );
  const attemptRows = yield* queries.selectAttempts(undefined);
  const attempts = yield* Effect.forEach(
    attemptRows,
    (attempt) =>
      Schema.decodeUnknown(terminalAttemptText)(attempt.attemptJson, {
        onExcessProperty: "error",
      }),
    { concurrency: 1 },
  );
  const fields = {
    formatVersion: row.value.formatVersion,
    reportId: row.value.reportId,
    planDigest: row.value.planDigest,
    plan,
    createdAt: row.value.createdAt,
    updatedAt: row.value.updatedAt,
    attempts,
  };
  const report =
    row.value.completedAt === null
      ? InProgressEvaluationReport.make(fields)
      : CompletedEvaluationReport.make({
          ...fields,
          completedAt: row.value.completedAt,
        });
  return yield* validateEvaluationReport(report);
});

const createStoredReport = Effect.fn("evals.results.insert")(function* (
  queries: ResultQueries,
  report: InProgressEvaluationReport,
) {
  yield* validateEvaluationReport(report);
  const planJson = yield* Schema.encode(evaluationReportPlanText)(report.plan, {
    onExcessProperty: "error",
  });
  const inserted = yield* queries.insertReport({
    reportId: report.reportId,
    formatVersion: report.formatVersion,
    planDigest: report.planDigest,
    planJson,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  });
  if (Option.isNone(inserted)) {
    return yield* Effect.fail(
      EvaluationResultAlreadyExists.make({ reportId: report.reportId }),
    );
  }
  return report;
});

const appendStoredAttempt = Effect.fn("evals.results.append")(function* (
  queries: ResultQueries,
  current: InProgressEvaluationReport,
  attempt: TerminalAttemptType,
) {
  const next = yield* appendEvaluationAttempt(current, attempt);
  const ordinal = current.attempts.length;
  const terminalJson = yield* Schema.encode(terminalAttemptText)(attempt, {
    onExcessProperty: "error",
  });
  const request = {
    reportId: current.reportId,
    ordinal,
    terminalJson,
    updatedAt: next.updatedAt,
  };
  const inserted = yield* queries.insertAttempt(request);
  if (Option.isNone(inserted)) {
    return yield* Effect.fail(
      conflict(
        current.reportId,
        `attempt at ordinal ${ordinal} conflicts with durable state`,
      ),
    );
  }
  const updated = yield* queries.updateAfterAttempt(request);
  if (Option.isNone(updated)) {
    return yield* Effect.fail(
      conflict(
        current.reportId,
        "the report is missing, completed, or has another identity",
      ),
    );
  }
  return next;
});

function completeStoredReport(
  queries: ResultQueries,
  report: CompletedEvaluationReport,
) {
  return queries
    .markCompleted({
      reportId: report.reportId,
      completedAt: report.completedAt,
    })
    .pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              conflict(
                report.reportId,
                "the report cannot transition to completed",
              ),
            ),
          onSome: () => Effect.void,
        }),
      ),
    );
}

function acquireStoredReportWrite(
  databasePath: string,
  acquireWrite: ResultQueries["acquireWrite"],
) {
  return acquireWrite(undefined).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(EvaluationResultNotFound.make({ databasePath })),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function initializeStore(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* Migrator.make({})({
      loader: migrations,
      table: "evaluation_result_migrations",
    });
  });
}

function makeStore(databasePath: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* initializeStore(sql);
    const queries = makeQueries(sql);
    yield* Effect.acquireRelease(
      acquireReportLease(databasePath, sql, queries),
      () => releaseReportLease(sql, queries),
    );
    return makeStoreService(databasePath, sql, queries);
  });
}

// A process the kernel no longer knows is dead; one it refuses to let this
// process signal is alive and someone else's. The lease names a process on
// this host, which is the only host a report bundle is opened from.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
}

function acquireReportLease(
  databasePath: string,
  sql: SqlClient.SqlClient,
  queries: ResultQueries,
) {
  const ownerPid = process.pid;
  return sql.withTransaction(
    Effect.gen(function* () {
      const acquiredAt = yield* DateTime.now;
      const held = yield* queries.selectLease(undefined);
      const taken = yield* Option.match(held, {
        onNone: () => queries.insertLease({ ownerPid, acquiredAt }),
        onSome: (lease) =>
          lease.ownerPid === ownerPid || processAlive(lease.ownerPid)
            ? Effect.succeed(Option.none<typeof leaseRow.Type>())
            : queries.takeOverLease({
                ownerPid,
                previousOwnerPid: lease.ownerPid,
                acquiredAt,
              }),
      });
      if (Option.isNone(taken)) {
        return yield* Effect.fail(
          ReportLocked.make({
            databasePath,
            ownerPid: Option.map(held, (lease) => lease.ownerPid).pipe(
              Option.getOrElse(() => ownerPid),
            ),
          }),
        );
      }
    }),
  );
}

function releaseReportLease(sql: SqlClient.SqlClient, queries: ResultQueries) {
  return sql
    .withTransaction(queries.releaseLease({ ownerPid: process.pid }))
    .pipe(Effect.ignore);
}

function prepareResultBundle(databasePath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(databasePath);
    yield* fileSystem.makeDirectory(directory, {
      recursive: true,
      mode: RESULT_DIRECTORY_MODE,
    });
    yield* fileSystem.chmod(directory, RESULT_DIRECTORY_MODE);
    yield* fileSystem.writeFile(databasePath, EMPTY_DATABASE, {
      flag: "a",
      mode: RESULT_FILE_MODE,
    });
    yield* fileSystem.chmod(databasePath, RESULT_FILE_MODE);
  });
}

/** Resolve the report-local SQLite bundle path. */
export const evaluationResultPath = Effect.fn("evals.evaluationResultPath")(
  function* (reportId: EvaluationReportId) {
    const path = yield* Path.Path;
    return path.join(".moltzap", "evals", "results", `${reportId}.sqlite`);
  },
);

/** Create the single report in the selected result bundle. */
export const createStoredEvaluationReport = Effect.fn("evals.results.create")(
  function* (reportId: EvaluationReportId, plan: EvaluationReportPlan) {
    const store = yield* EvaluationResultStore;
    const report = yield* createEvaluationReport(reportId, plan);
    return yield* store.create(report);
  },
);

/** Decode and validate the report in the selected result bundle. */
export const loadEvaluationReport = Effect.fn("evals.results.load")(
  function* () {
    const store = yield* EvaluationResultStore;
    return yield* store.load();
  },
);

/** Validate immutable resume inputs against the stored report. */
export const resumeStoredEvaluationReport = Effect.fn("evals.results.resume")(
  function* (expectedPlan: EvaluationReportPlan) {
    const report = yield* loadEvaluationReport();
    return yield* resumeEvaluationReport(report, expectedPlan);
  },
);

function persistCompletion(
  queries: ResultQueries,
  report: InProgressEvaluationReport,
) {
  return completeEvaluationReport(report).pipe(
    Effect.tap((completed) => completeStoredReport(queries, completed)),
  );
}

type WindowSelection =
  | { readonly _tag: "completed"; readonly report: CompletedEvaluationReport }
  | {
      readonly _tag: "window";
      readonly report: InProgressEvaluationReport;
      readonly cells: readonly EvaluationSweepCell[];
    };

function completedSelection(
  report: CompletedEvaluationReport,
): WindowSelection {
  return { _tag: "completed", report };
}

function windowSelection(
  report: InProgressEvaluationReport,
  cells: readonly EvaluationSweepCell[],
): WindowSelection {
  return { _tag: "window", report, cells };
}

// One short transaction: what the report holds now, and the next cells to
// run. Nothing executes while it is open.
function selectWindow(
  databasePath: string,
  queries: ResultQueries,
  concurrency: number,
) {
  return Effect.gen(function* () {
    yield* acquireStoredReportWrite(databasePath, queries.acquireWrite);
    const current = yield* loadStoredReport(databasePath, queries);
    if (current instanceof CompletedEvaluationReport) {
      return completedSelection(current);
    }
    const remaining = yield* remainingEvaluationCells(current);
    if (remaining.length === 0) {
      return completedSelection(yield* persistCompletion(queries, current));
    }
    return windowSelection(current, remaining.slice(0, concurrency));
  });
}

/** The store's connection and queries, threaded as one handle. */
interface StoreHandle {
  readonly databasePath: string;
  readonly sql: SqlClient.SqlClient;
  readonly queries: ResultQueries;
}

interface WindowCommitState {
  readonly gate: Effect.Semaphore;
  readonly report: Ref.Ref<InProgressEvaluationReport>;
  readonly next: Ref.Ref<number>;
  readonly finished: Map<number, TerminalAttemptType>;
}

// Finished attempts wait until every earlier cell of the window has
// committed, so the durable report grows only as a plan-order prefix. The
// commit itself is uninterruptible: an attempt that finished is not lost to
// an interrupt that lands between its execution and its row.
function commitPrefix(handle: StoreHandle, state: WindowCommitState) {
  return Effect.gen(function* () {
    for (;;) {
      const next = yield* Ref.get(state.next);
      const ready = state.finished.get(next);
      if (ready === undefined) {
        return;
      }
      const current = yield* Ref.get(state.report);
      const appended = yield* Effect.uninterruptible(
        handle.sql.withTransaction(
          acquireStoredReportWrite(
            handle.databasePath,
            handle.queries.acquireWrite,
          ).pipe(
            Effect.zipRight(
              appendStoredAttempt(handle.queries, current, ready),
            ),
          ),
        ),
      );
      yield* Ref.set(state.report, appended);
      state.finished.delete(next);
      yield* Ref.set(state.next, next + 1);
    }
  });
}

function commitFinished(
  handle: StoreHandle,
  state: WindowCommitState,
  index: number,
  attempt: TerminalAttemptType,
) {
  return state.gate.withPermits(1)(
    Effect.suspend(() => {
      state.finished.set(index, attempt);
      return commitPrefix(handle, state);
    }),
  );
}

function executeWindow<E, R>(
  handle: StoreHandle,
  selection: Extract<WindowSelection, { readonly _tag: "window" }>,
  execute: ExecuteCell<E, R>,
  concurrency: number,
) {
  return Effect.gen(function* () {
    const state: WindowCommitState = {
      gate: yield* Effect.makeSemaphore(1),
      report: yield* Ref.make(selection.report),
      next: yield* Ref.make(0),
      finished: new Map(),
    };
    yield* Effect.forEach(
      selection.cells,
      (cell, index) =>
        execute(cell).pipe(
          Effect.flatMap((attempt) =>
            commitFinished(handle, state, index, attempt),
          ),
        ),
      { concurrency, discard: true },
    );
    return yield* Ref.get(state.report);
  });
}

function advanceStoredReport<E, R>(
  handle: StoreHandle,
  execute: ExecuteCell<E, R>,
  concurrency: number,
) {
  return Effect.gen(function* () {
    const selection = yield* handle.sql.withTransaction(
      selectWindow(handle.databasePath, handle.queries, concurrency),
    );
    switch (selection._tag) {
      case "completed":
        return selection.report;
      case "window":
        return yield* executeWindow(handle, selection, execute, concurrency);
      default: {
        const exhaustive: never = selection;
        return exhaustive;
      }
    }
  });
}

function makeStoreService(
  databasePath: string,
  sql: SqlClient.SqlClient,
  queries: ResultQueries,
): EvaluationResultStoreService {
  const handle: StoreHandle = { databasePath, sql, queries };
  return {
    databasePath,
    create: (report) => createStoredReport(queries, report),
    load: () => sql.withTransaction(loadStoredReport(databasePath, queries)),
    advance: (execute, concurrency) =>
      advanceStoredReport(handle, execute, concurrency),
  };
}
