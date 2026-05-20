/**
 * `moltzap start &lt;name> &lt;participant>... [--message &lt;text>] [--app-id &lt;uuid>]`
 *
 * Spec D2 (#599) — single-command CLI composition over Spec D1's atomic
 * `TaskCreate({ appId, invitedAgentIds, initialConversation })` plus an
 * optional `MessagesSend`. Today's two-step workflow
 * (`conversations create` -> `send conv:&lt;id> &lt;text>`) collapses into
 * one subcommand for the common case.
 *
 * See also:
 *   - `packages/protocol/src/task/tasks.ts -> TaskCreate` / `DEFAULT_APP_ID` /
 *     `AppId` — D1 (#598) wire surface this command composes.
 *   - `packages/client/docs/architecture/09-moltzap-start-cli.md` for the
 *     command flow diagram, exit-code contract, and test alignment.
 *   - `packages/client/src/cli/commands/conversations.ts -> createConversation`
 *     for the legacy two-step DM/Group create path D2 replaces. Untouched
 *     in D2; D3 (#600) deletes it.
 *   - `packages/client/src/cli/socket-client.ts -> resolveParticipant` —
 *     NOT reused by D2 because that helper goes via the daemon
 *     socket (`socket-client.ts -> request`), bypassing the CLI
 *     `Transport` service that `start.ts` uses for `TaskCreate` /
 *     `MessagesSend`. Mixing the two would make `--as`-mode name lookups
 *     hit the daemon (potentially absent) and would not be testable
 *     via `makeFakeTransport`. D2 introduces a local `resolveAgentToken`
 *     helper that goes through `transport.ts -> rpc` instead
 *     (see per-flow doc §6 + §"Why we don't reuse `resolveParticipant`").
 */
import { Args, Command, Options } from "@effect/cli";
import { Data, Effect, Either, Option } from "effect";
import {
  AgentsLookupByName,
  DEFAULT_APP_ID,
  MessagesSend,
  TaskConversationList,
  TaskCreate,
  type AgentId,
  type AppId,
  type Conversation,
  type Task,
  type TaskConversationListItem,
  type TaskId,
} from "@moltzap/protocol";
import type { ConversationId } from "@moltzap/protocol/task";
import { rpc, type Transport, type TransportError } from "../transport.js";

// ─── Exit-code contract (spec D2 Goal 5 + Goal 7) ─────────────────────────

/**
 * Exit-code table for the `moltzap start` command. Values are documented
 * in `Command.withDescription` help text below; the handler branches on
 * these via `runStartCommand` and inline `process.exit` in the
 * partial-success path.
 */
const EXIT_CODES = {
  SUCCESS: 0,
  TASK_CREATE_FAILED: 1,
  PARTIAL_SUCCESS: 2,
  USAGE_ERROR: 64,
} as const;

// ─── Tagged errors (CLI-local) ────────────────────────────────────────────

/**
 * `--app-id &lt;value>` failed syntactic UUID v4 validation before any RPC.
 * Maps to `EXIT_CODES.USAGE_ERROR`; stderr prints
 * `Invalid --app-id: not a UUID`. Local to this module — tests assert
 * by exit code + stderr text rather than `expect().toBeInstanceOf(...)`,
 * so the class stays unexported per the architect plan.
 */
class InvalidAppIdError extends Data.TaggedError("InvalidAppIdError")<{
  readonly value: string;
}> {}

/**
 * An `agent:&lt;name>` or `agent:&lt;uuid>` participant token could not be
 * resolved (name not in the agent roster, or token mis-shaped). Maps
 * to `EXIT_CODES.USAGE_ERROR`; stderr names the unresolved token.
 *
 * Resolver calls `AgentsLookupByName` (a server RPC) for name-shaped
 * tokens. That RPC is read-only and does not mutate server state, so
 * the partial-failure invariant is unaffected. The spec D2 AC clause
 * "NO RPC calls" reads as "NO mutating (TaskCreate / MessagesSend)
 * calls" in this plan; see per-flow doc §8 + plan §R5.
 */
class UnresolvedParticipantError extends Data.TaggedError(
  "UnresolvedParticipantError",
)<{
  readonly token: string;
  readonly reason: "shape" | "not-found";
}> {}

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Parsed CLI arguments for the `start` command. `@effect/cli`'s
 * `Args.repeated` admits zero participants — caller-only tasks are
 * permitted at the wire (Spec D1 per-flow doc 12) but not exercised by
 * spec D2 ACs (which cover `length === 1` DM and `length >= 2` group
 * shapes). Handler MUST NOT reject empty `participants`.
 */
export interface StartCommandArgs {
  readonly name: string;
  readonly participants: readonly string[];
  readonly message: string | undefined;
  readonly appId: string | undefined;
}

/**
 * Exhaustive error union for the start-command handler. The wrapping
 * `runStartCommand` adapter converts each tag to an exit code:
 *
 *   `InvalidAppIdError`           -> 64 (usage)
 *   `UnresolvedParticipantError`  -> 64 (usage)
 *   any other `TransportError`    -> 1  (rpc; from `TaskCreate`)
 *
 * The post-`TaskCreate` `MessagesSend` failure path exits 2 via inline
 * `process.exit` inside the handler body, NOT through `runStartCommand`
 * (see per-flow doc §"Partial-failure dispatcher").
 *
 * `TransportError` here is the union from `transport.ts -> TransportError`
 * which includes `TransportDecodeError`, `TransportRpcError`,
 * `ServiceUnreachableError`, `TransportTimeoutError`, and
 * `TransportConfigError`.
 */
type StartCommandError =
  | TransportError
  | InvalidAppIdError
  | UnresolvedParticipantError;

// ─── UUID validation ──────────────────────────────────────────────────────

/**
 * RFC 4122 UUID v4 regex per plan Invariant 7. The `4` in the third
 * group pins the version; the `[89ab]` in the fourth group pins the
 * variant. Pre-existing `socket-client.ts -> UUID_RE` accepts any UUID
 * version, which would let v3/v5/v7 tokens through; spec D2 Goal 7
 * requires v4-specific rejection at exit 64.
 */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validateAppId = (
  value: string,
): Effect.Effect<AppId, InvalidAppIdError> =>
  UUID_V4_RE.test(value)
    ? Effect.succeed(value as AppId)
    : Effect.fail(new InvalidAppIdError({ value }));

// ─── Participant token resolver ───────────────────────────────────────────

const AGENT_TOKEN_PREFIX = "agent:";

/**
 * Parse `agent:&lt;uuid>` (short-circuits client-side) or `agent:&lt;name>`
 * (routes through `transport.ts -> rpc(AgentsLookupByName, ...)`).
 * Returns bare `AgentId` matching `TaskCreate.params.invitedAgentIds:
 * Array(AgentId)` directly (no `.map(p => p.id)` step needed).
 *
 * Failure modes:
 *   - Token does not start with `agent:` -> `UnresolvedParticipantError({
 *     reason: "shape" })`.
 *   - Token is `agent:&lt;name>` and lookup returns zero agents ->
 *     `UnresolvedParticipantError({ reason: "not-found" })`.
 *
 * Architect plan §R1 explains why this is a local helper rather than
 * reusing `socket-client.ts -> resolveParticipant` (transport mismatch,
 * testability, wire-shape match).
 */
const resolveAgentToken = (
  token: string,
): Effect.Effect<
  AgentId,
  UnresolvedParticipantError | TransportError,
  Transport
> =>
  Effect.gen(function* () {
    if (!token.startsWith(AGENT_TOKEN_PREFIX)) {
      return yield* Effect.fail(
        new UnresolvedParticipantError({ token, reason: "shape" }),
      );
    }
    const rest = token.slice(AGENT_TOKEN_PREFIX.length);
    if (rest.length === 0) {
      return yield* Effect.fail(
        new UnresolvedParticipantError({ token, reason: "shape" }),
      );
    }
    if (UUID_V4_RE.test(rest)) {
      return rest as AgentId;
    }
    const result = yield* rpc(AgentsLookupByName, { names: [rest] });
    const firstAgent = result.agents[0];
    if (firstAgent === undefined) {
      return yield* Effect.fail(
        new UnresolvedParticipantError({ token, reason: "not-found" }),
      );
    }
    return firstAgent.id;
  });

// ─── Handler stages ───────────────────────────────────────────────────────

const resolveAppId = (
  raw: string | undefined,
): Effect.Effect<AppId, InvalidAppIdError> =>
  raw === undefined ? Effect.succeed(DEFAULT_APP_ID) : validateAppId(raw);

const printTaskCreated = (
  task: Task,
  conversation: Conversation,
): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(`Task started: ${task.id} (conversation: ${conversation.id})`);
  });

const printTaskReused = (
  task: Task,
  conversation: Conversation,
): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(
      `Task started: ${task.id} (reusing existing conversation: ${conversation.id})`,
    );
  });

const printTaskAlreadyClosed = (taskId: TaskId): Effect.Effect<void> =>
  Effect.sync(() => {
    // WHY this single message covers two distinct conditions:
    // (a) the existing task has no non-archived conversation, OR
    // (b) the dedup-lookup window (1000 rows) did not surface one.
    // (b) is rare per the activity-desc server ordering; if a heavy
    // user trips it on an active task, the spec D2 amendment N6
    // diagnostic is intentionally conservative ("closed") rather than
    // claiming false freshness. The follow-up `moltzap conversations
    // list` invocation surfaces the real state.
    console.error(`Task already exists but is closed: ${taskId}`);
  });

const printMessageSent = (messageId: string): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(`Message sent: ${messageId}`);
  });

const sendFirstMessage = (
  conversationId: ConversationId,
  text: string,
): Effect.Effect<void, never, Transport> =>
  Effect.either(
    rpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text }],
    }),
  ).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (err) =>
          Effect.sync(() => {
            console.error(`Error sending message: ${err.message}`);
            process.exit(EXIT_CODES.PARTIAL_SUCCESS);
          }),
        onRight: (ok) => printMessageSent(ok.message.id),
      }),
    ),
  );

/**
 * Outcome of the atomic `TaskCreate` call. The dedup branch fires when
 * `appId === DEFAULT_APP_ID` AND the caller already owns a task with
 * the exact same `{caller} ∪ invitedAgentIds` participant set (see
 * `packages/server/src/task/handlers/tasks.handlers.ts → maybeTaskCreateDedup`
 * and protocol per-flow doc 12 §3). The server returns
 * `{ task: existing, conversation: null }` even when
 * `initialConversation` was supplied — dedup is task-level, not
 * conversation-level — so the CLI MUST treat `conversation === null`
 * as a legitimate outcome rather than a decode error.
 */
type CreateTaskOutcome =
  | {
      readonly kind: "created";
      readonly task: Task;
      readonly conversation: Conversation;
    }
  | { readonly kind: "dedup"; readonly task: Task };

const createTaskAtomic = (
  appId: AppId,
  invitedAgentIds: readonly AgentId[],
  name: string,
): Effect.Effect<CreateTaskOutcome, TransportError, Transport> =>
  Effect.gen(function* () {
    // Defensive copies: TaskCreate's params type expects mutable arrays
    // (TypeBox's Static<Array> resolves to T[], not readonly T[]); pass
    // shallow clones so the caller's readonly contract isn't bypassed.
    //
    // Spec D2 (#599) amendment N7 (zero-participant carve-out):
    // `InitialConversationSchema.participants` is `Type.Optional(Type.Array(AgentId,
    // { minItems: 1 }))` — an EMPTY array fails server AJV. The
    // caller-only path (help text + plan §R4 + `start.test.ts →
    // zeroParticipants`) MUST omit `participants` entirely; the server
    // adds the caller to `conversation_participants` implicitly. See
    // `packages/protocol/src/task/tasks.ts → InitialConversationSchema`.
    const initialConversation =
      invitedAgentIds.length === 0
        ? { name }
        : { name, participants: [...invitedAgentIds] };
    const result = yield* rpc(TaskCreate, {
      appId,
      invitedAgentIds: [...invitedAgentIds],
      initialConversation,
    });
    if (result.conversation === null) {
      // Dedup hit (per `tasks.handlers.ts → maybeTaskCreateDedup`): the
      // server matched an existing task by `{caller} ∪ invitedAgentIds`
      // and returned it with `conversation: null`. Handler resolves a
      // reusable conversation via `findReusableConversation` instead of
      // failing.
      return { kind: "dedup", task: result.task } as const;
    }
    return {
      kind: "created",
      task: result.task,
      conversation: result.conversation,
    } as const;
  });

// ─── Dedup-hit conversation lookup (spec D2 amendment N6) ─────────────────

/**
 * Page size + safety cap on `TaskConversationList` follow-up calls. The
 * dedup-hit conversation should appear in the first page for any
 * recently-touched task (server orders by activity desc, see
 * `packages/server/src/task/services/conversation/list-pagination.ts →
 * queryConversationListRows`). The cap protects against pathological
 * cases where the caller has a very long list and the target task is
 * older than the window can see — in which case we surface the closed-
 * task diagnostic rather than spin indefinitely.
 */
const DEDUP_LOOKUP_PAGE_SIZE = 100;
const DEDUP_LOOKUP_MAX_PAGES = 10;

/**
 * P2-A (spec D2 amendment N6) — locate a reusable conversation under a
 * dedup-hit task. Tie-break rule: "first match in server iteration
 * order" — server sorts by activity desc, so this is equivalent to
 * most-recently-active. WHY a small page-count cap: a freshly-touched
 * dedup-hit task lives near the top of the activity-sorted list; the
 * 1000-row ceiling protects against pathological lists where the
 * target is older than the lookup window can see (the closed-task
 * diagnostic is the correct fallback per spec D2 amendment N6).
 */

/**
 * Filter rule for the dedup-hit lookup: (a) the item's `taskId` must
 * match the existing task we are reusing (the list is caller-scoped
 * across ALL of the caller's tasks, not task-scoped); (b) the
 * conversation must be non-archived (server includes archived rows
 * unfiltered per `TaskConversationList`'s contract — clients filter
 * `archivedAt !== undefined` locally; archived strings are absent
 * on the wire when the row is active, never `null`, per
 * `ConversationSchema.archivedAt: Type.Optional(DateTimeString)`).
 */
const pickReusableFromPage = (
  items: ReadonlyArray<TaskConversationListItem>,
  taskId: TaskId,
): Conversation | null => {
  const match = items.find(
    (item) =>
      item.taskId === taskId && item.conversation.archivedAt === undefined,
  );
  return match === undefined ? null : match.conversation;
};

const findReusableConversation = (
  taskId: TaskId,
): Effect.Effect<Conversation | null, TransportError, Transport> =>
  Effect.gen(function* () {
    let cursor: string | undefined = undefined;
    for (let page = 0; page < DEDUP_LOOKUP_MAX_PAGES; page++) {
      const params: { limit: number; cursor?: string } = {
        limit: DEDUP_LOOKUP_PAGE_SIZE,
      };
      if (cursor !== undefined) params.cursor = cursor;
      const result = yield* rpc(TaskConversationList, params);
      const hit = pickReusableFromPage(result.items, taskId);
      if (hit !== null) return hit;
      if (result.nextCursor === undefined) return null;
      cursor = result.nextCursor;
    }
    return null;
  });

/**
 * Spec D2 amendment N6 — dedup-hit branch. `TaskConversationList`
 * wire failures are captured inline via `Effect.either` (same pattern
 * + same reason as `sendFirstMessage`'s partial-success handling)
 * because `TaskCreate` already succeeded server-side; routing the
 * list error through `runStartCommand`'s `catchAll` would print
 * `Failed: &lt;list-error>`, misleading the user into thinking the
 * create failed.
 */
const onReuseFound = (
  task: Task,
  reuse: Conversation,
  message: Option.Option<string>,
): Effect.Effect<void, never, Transport> =>
  Effect.zipRight(
    printTaskReused(task, reuse),
    Option.match(message, {
      onNone: () => Effect.void,
      onSome: (m) => sendFirstMessage(reuse.id, m),
    }),
  );

const onReuseNull = (task: Task): Effect.Effect<void, never, Transport> =>
  Effect.zipRight(
    printTaskAlreadyClosed(task.id),
    Effect.sync(() => {
      process.exit(EXIT_CODES.TASK_CREATE_FAILED);
    }),
  );

const handleDedupOutcome = (
  task: Task,
  message: Option.Option<string>,
): Effect.Effect<void, never, Transport> =>
  Effect.either(findReusableConversation(task.id)).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (err) =>
          Effect.sync(() => {
            console.error(
              `Task ${task.id} already exists but reusable-conversation lookup failed: ${err.message}`,
            );
            process.exit(EXIT_CODES.TASK_CREATE_FAILED);
          }),
        onRight: (reuse) =>
          reuse === null
            ? onReuseNull(task)
            : onReuseFound(task, reuse, message),
      }),
    ),
  );

// ─── Handler body ─────────────────────────────────────────────────────────

/**
 * `moltzap start` handler. Four stages (see per-flow doc 09 §6):
 *
 *   1. Validate `args.appId` UUID v4 if set; else use `DEFAULT_APP_ID`.
 *      Failure -> `InvalidAppIdError` -> exit 64 via `runStartCommand`.
 *   2. Resolve `args.participants` via `resolveAgentToken` (per-token,
 *      sequential via `Effect.all`). Any token failure ->
 *      `UnresolvedParticipantError` -> exit 64.
 *   3. `rpc(TaskCreate, { appId, invitedAgentIds, initialConversation })`
 *      where `initialConversation` carries `participants` ONLY when
 *      `invitedAgentIds.length > 0` (P2-B). Two success outcomes:
 *      - `created`: server returned a fresh `conversation`. Print
 *        `Task started: &lt;taskId> (conversation: &lt;convId>)`.
 *      - `dedup`: server returned `conversation: null` because
 *        `{caller} ∪ invitedAgentIds` already owned a task on this
 *        appId (P2-A). Auto-fetch the most-recently-active non-
 *        archived conversation under the existing task via
 *        `findReusableConversation` and print
 *        `Task started: &lt;taskId> (reusing existing conversation: &lt;convId>)`.
 *        If no usable conversation exists (closed task, all archived,
 *        or out of dedup-lookup window), print
 *        `Task already exists but is closed: &lt;taskId>` to stderr and
 *        exit 1.
 *      `TaskCreate` wire failure -> `TransportError` -> exit 1 via
 *      `runStartCommand`, no stdout.
 *   4. If `args.message` is set AND a conversation was produced (either
 *      kind), call `rpc(MessagesSend, { conversationId, parts: [{ type:
 *      "text", text }] })` wrapped in `Effect.either`. Success -> print
 *      `Message sent: &lt;msgId>`, exit 0. Failure -> print
 *      `Error sending message: &lt;err>` to stderr, exit 2 via inline
 *      `process.exit` (preserves the already-printed stdout line;
 *      cannot route through `runStartCommand`).
 */
const startCommandHandler = (
  args: StartCommandArgs,
): Effect.Effect<void, StartCommandError, Transport> =>
  Effect.gen(function* () {
    const appId = yield* resolveAppId(args.appId);
    const invitedAgentIds = yield* Effect.all(
      args.participants.map(resolveAgentToken),
    );
    const outcome = yield* createTaskAtomic(appId, invitedAgentIds, args.name);
    const messageOpt = Option.fromNullable(args.message);
    if (outcome.kind === "dedup") {
      yield* handleDedupOutcome(outcome.task, messageOpt);
      return;
    }
    yield* printTaskCreated(outcome.task, outcome.conversation);
    yield* Option.match(messageOpt, {
      onNone: () => Effect.void,
      onSome: (m) => sendFirstMessage(outcome.conversation.id, m),
    });
  }).pipe(Effect.withSpan("startCommandHandler"));

// ─── Exit-code dispatcher ─────────────────────────────────────────────────

/**
 * Outer adapter that replaces the shared `transport.ts -> runHandler`
 * (which collapses every error to exit 1) with a `_tag`-aware mapping
 * per the spec D2 exit-code contract:
 *
 *   `InvalidAppIdError`           -> 64 + stderr `Invalid --app-id: not a UUID`
 *   `UnresolvedParticipantError`  -> 64 + stderr `Cannot resolve "&lt;token>": &lt;reason>`
 *   any other `StartCommandError` -> 1  + stderr `Failed: &lt;err.message>`
 *
 * The exit-2 partial-success branch runs inline inside
 * `startCommandHandler` (after `Task started:` has been printed to
 * stdout) and never reaches this adapter — re-throwing the post-
 * `TaskCreate` error here would discard the already-printed stdout
 * line.
 */
const runStartCommand = (
  effect: Effect.Effect<void, StartCommandError, Transport>,
): Effect.Effect<void, never, Transport> =>
  effect.pipe(
    Effect.catchTag("InvalidAppIdError", () =>
      Effect.sync(() => {
        console.error("Invalid --app-id: not a UUID");
        process.exit(EXIT_CODES.USAGE_ERROR);
      }),
    ),
    Effect.catchTag("UnresolvedParticipantError", (err) =>
      Effect.sync(() => {
        console.error(`Cannot resolve "${err.token}": ${err.reason}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }),
    ),
    Effect.catchAll((err) =>
      Effect.sync(() => {
        const msg =
          err.message !== undefined && err.message !== ""
            ? err.message
            : err._tag;
        console.error(`Failed: ${msg}`);
        process.exit(EXIT_CODES.TASK_CREATE_FAILED);
      }),
    ),
  );

// ─── @effect/cli wiring ───────────────────────────────────────────────────

const nameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Conversation name"),
);

const participantsArg = Args.text({ name: "participant" }).pipe(
  Args.withDescription(
    "Participant token (e.g. agent:bob or agent:<uuid>). " +
      "Zero or more allowed; D2 ACs cover 1 (DM-shape) and >=2 (group-shape).",
  ),
  Args.repeated,
);

const messageOption = Options.text("message").pipe(
  Options.withDescription(
    "First message body. If supplied, MessagesSend runs after the atomic " +
      "TaskCreate (separate RPC, not server-atomic).",
  ),
  Options.optional,
);

const appIdOption = Options.text("app-id").pipe(
  Options.withDescription(
    "App UUID v4. Defaults to DEFAULT_APP_ID (D1 #635). Invalid syntax " +
      "exits 64 with NO RPC calls (Goal 7).",
  ),
  Options.optional,
);

/**
 * Test seam: invoke the handler directly with parsed args, bypassing
 * `@effect/cli`'s parser. Returns the same `Effect` the `Command.make`
 * wrapper would produce, including the `runStartCommand` exit-code
 * dispatcher. Tests `Effect.provideService(Transport, fake)` and assert
 * `process.exit` was called with the expected code.
 */
export const runStartHandler = (
  args: StartCommandArgs,
): Effect.Effect<void, never, Transport> =>
  runStartCommand(startCommandHandler(args));

export const startCommand = Command.make(
  "start",
  {
    name: nameArg,
    participants: participantsArg,
    message: messageOption,
    appId: appIdOption,
  },
  ({ name, participants, message, appId }) =>
    runStartHandler({
      name,
      participants,
      message: Option.getOrUndefined(message),
      appId: Option.getOrUndefined(appId),
    }),
).pipe(
  Command.withDescription(
    "Start a task with named participants and (optionally) send the " +
      "first message in one atomic step. Spec D2 #599 — composes Spec D1 " +
      "TaskCreate + MessagesSend.\n" +
      "\n" +
      "Zero participants creates a caller-only task (rare; usually you " +
      "will pass one or more `agent:<name>` tokens).\n" +
      "\n" +
      "Exit codes:\n" +
      `  ${EXIT_CODES.SUCCESS}   success (TaskCreate + optional MessagesSend resolved)\n` +
      `  ${EXIT_CODES.TASK_CREATE_FAILED}   TaskCreate failed (stdout empty)\n` +
      `  ${EXIT_CODES.PARTIAL_SUCCESS}   TaskCreate OK, MessagesSend failed (no rollback)\n` +
      `  ${EXIT_CODES.USAGE_ERROR}  usage error (bad --app-id UUID or unresolvable agent token)`,
  ),
);
