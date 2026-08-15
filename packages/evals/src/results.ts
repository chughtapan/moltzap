/** @file Effect SQL storage and resumable execution for evaluation reports. */

import type { SqlError } from "@effect/sql/SqlError";
import { FileSystem, Path } from "@effect/platform";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as Migrator from "@effect/sql/Migrator";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import {
  Context,
  Effect,
  Layer,
  Option,
  type ParseResult,
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

type ExecuteCell<E, R> = (
  cell: EvaluationSweepCell,
) => Effect.Effect<TerminalAttemptType, E, R>;

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
  const storeLayer = Layer.effect(
    EvaluationResultStore,
    makeStore(databasePath),
  ).pipe(Layer.provide(sqlLayer));
  return Layer.unwrapEffect(
    prepareResultBundle(databasePath).pipe(Effect.as(storeLayer)),
  );
}

/**
 * Execute missing cells sequentially.
 *
 * A cell owns the report's SQLite write transaction from selection through
 * terminal-attempt commit. Process failure or interruption rolls that cell
 * back and releases ownership; earlier cells remain committed.
 * @param execute Customer cell execution policy.
 * @returns The completed report Effect.
 */
export function runEvaluationSweep<E, R>(execute: ExecuteCell<E, R>) {
  return Effect.gen(function* () {
    const store = yield* EvaluationResultStore;
    while (true) {
      const report = yield* store.advance(execute);
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
  };
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
    return makeStoreService(databasePath, sql, makeQueries(sql));
  });
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

interface CommitCellOptions<E, R> {
  readonly queries: ResultQueries;
  readonly report: InProgressEvaluationReport;
  readonly cell: EvaluationSweepCell;
  readonly lastCell: boolean;
  readonly execute: ExecuteCell<E, R>;
}

function persistCompletion(
  queries: ResultQueries,
  report: InProgressEvaluationReport,
) {
  return completeEvaluationReport(report).pipe(
    Effect.tap((completed) => completeStoredReport(queries, completed)),
  );
}

function commitCell<E, R>({
  queries,
  report,
  cell,
  lastCell,
  execute,
}: CommitCellOptions<E, R>) {
  return Effect.uninterruptibleMask((restore) =>
    restore(execute(cell)).pipe(
      Effect.flatMap((attempt) =>
        appendStoredAttempt(queries, report, attempt),
      ),
      Effect.flatMap((next) =>
        lastCell
          ? persistCompletion(queries, next).pipe(
              Effect.map((completed): EvaluationReport => completed),
            )
          : Effect.succeed<EvaluationReport>(next),
      ),
    ),
  );
}

function advanceStoredReportTransaction<E, R>(
  databasePath: string,
  queries: ResultQueries,
  execute: ExecuteCell<E, R>,
) {
  return Effect.gen(function* () {
    yield* acquireStoredReportWrite(databasePath, queries.acquireWrite);
    const current = yield* loadStoredReport(databasePath, queries);
    if (current instanceof CompletedEvaluationReport) {
      return current;
    }
    const remaining = yield* remainingEvaluationCells(current);
    const [cell] = remaining;
    return cell === undefined
      ? yield* persistCompletion(queries, current)
      : yield* commitCell({
          queries,
          report: current,
          cell,
          lastCell: remaining.length === 1,
          execute,
        });
  });
}

function makeStoreService(
  databasePath: string,
  sql: SqlClient.SqlClient,
  queries: ResultQueries,
): EvaluationResultStoreService {
  return {
    databasePath,
    create: (report) => createStoredReport(queries, report),
    load: () => sql.withTransaction(loadStoredReport(databasePath, queries)),
    advance: (execute) =>
      sql.withTransaction(
        advanceStoredReportTransaction(databasePath, queries, execute),
      ),
  };
}
