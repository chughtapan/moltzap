/**
 * `moltzap start &lt;name> &lt;participant>... [--message &lt;text>] [--app-id &lt;uuid>]`
 *
 * Spec D2 (#599) — single-command CLI composition over Spec D1's atomic
 * `TaskCreate({ appId, invitedAgentIds, initialConversation })` plus an
 * optional `MessagesSend`. Today's two-step workflow
 * (`conversations create` → `send conv:&lt;id> &lt;text>`) collapses into one
 * subcommand for the common case.
 *
 * Architect stub (sub-issue #643). NO function bodies, NO command
 * registration in `cli/index.ts`. Impl-staff lands both per the plan in
 * `packages/client/docs/architecture/09-moltzap-start-cli.md`.
 *
 * See also:
 *   - Spec D1 architect plan (#635) for `TaskCreate` / `DEFAULT_APP_ID` /
 *     `AppId` / `ParticipantNotAdmittedError` definitions on branch
 *     `architect/598-task-conversation`.
 *   - `packages/client/docs/architecture/09-moltzap-start-cli.md` for the
 *     command flow diagram, exit-code contract, and test alignment.
 *   - `packages/client/src/cli/commands/conversations.ts → createConversation`
 *     for the legacy two-step DM/Group create path D2 replaces.
 *   - `packages/client/src/cli/socket-client.ts → resolveParticipant` for
 *     the `agent:&lt;name>` / `agent:&lt;uuid>` token resolver this command
 *     re-uses (caller maps `.id` after resolution to get a bare `AgentId`).
 */
import { Args, Command, Options } from "@effect/cli";
import { Data, Effect, Option } from "effect";
import {
  runHandler,
  type Transport,
  type TransportError,
} from "../transport.js";

// ─── Exit-code contract (spec D2 Goal 5 + Goal 7) ─────────────────────────

/**
 * Exit-code table for the `moltzap start` command. Impl-staff re-
 * exports individual constants only as tests need them (knip flags
 * unused exports). At stub time these are documented here and used in
 * the help-text composition below.
 */
const EXIT_CODES = {
  /**
   * Full success: `TaskCreate` resolved AND, if `--message` was
   * supplied, `MessagesSend` resolved too. Stdout printed both lines.
   */
  SUCCESS: 0,

  /**
   * `TaskCreate` failed (transport or server-rejected). Stdout printed
   * nothing; stderr has the error. `--message` was never attempted.
   */
  TASK_CREATE_FAILED: 1,

  /**
   * Partial success: `TaskCreate` succeeded but the follow-up
   * `MessagesSend` failed. Stdout printed `Task started: ...` (the
   * task + conversation exist); stderr has `Error sending message:
   * ...`. The empty conversation is intentionally left in place
   * (Non-goal 3 — no rollback). User retries via
   * `moltzap send conv:&lt;id> &lt;text>`.
   */
  PARTIAL_SUCCESS: 2,

  /**
   * Client-side usage error: invalid `--app-id` UUID syntax OR an
   * unresolvable `agent:&lt;token>` participant. NO mutating RPCs were
   * made (Goal 7; note `AgentsLookupByName` is read-only — see
   * `UnresolvedParticipantError` docstring). Matches POSIX `EX_USAGE`
   * (sysexits.h).
   */
  USAGE_ERROR: 64,
} as const;

// ─── Tagged errors (CLI-local) ────────────────────────────────────────────

/**
 * `--app-id &lt;value>` failed syntactic UUID v4 validation before any RPC.
 * Maps to `EXIT_CODES.USAGE_ERROR`; stderr prints `Invalid --app-id:
 * not a UUID`.
 *
 * Internal at stub time; impl-staff re-exports if tests need the class
 * for `expect().toBeInstanceOf(...)`-style assertions.
 */
class InvalidAppIdError extends Data.TaggedError("InvalidAppIdError")<{
  readonly value: string;
}> {}

/**
 * An `agent:&lt;name>` or `agent:&lt;uuid>` participant token could not be
 * resolved (name not in the agent roster, or token mis-shaped). Maps
 * to `EXIT_CODES.USAGE_ERROR`; stderr names the unresolved token. The
 * resolver does call `AgentsLookupByName` (a server RPC) — which is
 * read-only and does not mutate server state, so the partial-failure
 * invariant is unaffected. The spec D2 AC clause "NO RPC calls" reads
 * as "NO mutating (TaskCreate/MessagesSend) calls" in this plan; see
 * §15 process-issues + per-flow doc §8.
 *
 * Internal at stub time; impl-staff re-exports if tests need the class.
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
 * shapes). Impl-staff handler must NOT reject empty `participants`.
 */
export interface StartCommandArgs {
  /** Conversation name (positional `&lt;name>`). */
  readonly name: string;

  /**
   * Raw participant tokens (positional `&lt;participant>...`), each
   * `agent:&lt;name>` or `agent:&lt;uuid>`. Resolution is per-token via
   * `resolveParticipant` (socket-client.ts); failures map to
   * `UnresolvedParticipantError` and exit 64 BEFORE `TaskCreate`.
   */
  readonly participants: readonly string[];

  /**
   * `--message &lt;text>`. When undefined, only `TaskCreate` runs and the
   * partial-success path (exit code 2) cannot trigger.
   */
  readonly message: string | undefined;

  /**
   * `--app-id &lt;uuid>`. When undefined, the handler substitutes
   * `DEFAULT_APP_ID` from `@moltzap/protocol` (D1 surface). When set,
   * client validates UUID v4 syntax before any RPC; syntactic failure
   * maps to `InvalidAppIdError` and exit 64.
   */
  readonly appId: string | undefined;
}

/**
 * Exhaustive error union for the start-command handler. The wrapping
 * `Command.make` adapter converts each tag to an exit code via the
 * table documented at the top of this file:
 *
 *   `InvalidAppIdError`           → 64 (usage)
 *   `UnresolvedParticipantError`  → 64 (usage)
 *   `TransportError` from `TaskCreate`   → 1  (rpc)
 *   `TransportError` from `MessagesSend` → 2  (partial)
 *
 * The handler distinguishes the two `TransportError` cases by which
 * stage they arose in (TaskCreate vs MessagesSend) — see per-flow doc
 * §"Partial-failure dispatcher" for the impl-staff sketch.
 */
export type StartCommandError =
  | TransportError
  | InvalidAppIdError
  | UnresolvedParticipantError;

// ─── Handler signature ────────────────────────────────────────────────────

/**
 * `moltzap start &lt;name> &lt;participant>... [--message &lt;text>] [--app-id &lt;uuid>]`
 *
 * Flow (impl-staff fills the body — see per-flow doc 09 §"Implementation
 * sketch"):
 *
 *   1. Validate `args.appId` UUID v4 if set; else use `DEFAULT_APP_ID`.
 *      Failure → `InvalidAppIdError` → exit 64, no RPCs.
 *   2. Resolve every `args.participants[i]` via `resolveParticipant(...)`
 *      from `socket-client.ts`; map `.id` to get `AgentId`. Any token
 *      failing resolution → `UnresolvedParticipantError` → exit 64.
 *   3. Call `rpc(TaskCreate, { appId, invitedAgentIds, initialConversation:
 *      { name: args.name, participants: invitedAgentIds } })`. Failure →
 *      `TransportError` → exit 1, no stdout. On success, read
 *      `{ task, conversation }` directly from the response object (NO
 *      follow-up fetch) and print `Task started: ${task.id} (conversation:
 *      ${conversation.id})` to stdout. `conversation` is non-null here
 *      because `initialConversation` was supplied (D1 plan §R8 / canary _C5).
 *   4. If `args.message` is set, call `rpc(MessagesSend, { conversationId:
 *      conversation.id, parts: [{ type: "text", text: args.message }] })`.
 *      Success → print `Message sent: ${message.id}`, exit 0. Failure →
 *      print `Error sending message: ${err.message}` to stderr, exit 2.
 *      NO rollback.
 *
 * NB: D1 plan §R8 / Canary _C5 locks the wire result shape as `conversation:
 * Conversation | null`. The impl-staff handler asserts non-null when
 * `initialConversation` was sent — at runtime the field is always present
 * because D2 always sends `initialConversation`. The assertion narrows
 * TypeScript's union; a stale D1 build that returns `null` despite
 * `initialConversation` is treated as a `TransportDecodeError` (exit 1).
 * @throws — `process.exit` is called inside the wrapping
 * `Command.make` adapter, NOT here. This handler returns an Effect; the
 * `runHandler` analogue in `transport.ts` (or a partial-failure-aware
 * variant — see per-flow doc 09 §"Exit-code dispatcher") translates the
 * tag to an exit code.
 */
const startCommandHandler = (
  _args: StartCommandArgs,
): Effect.Effect<void, StartCommandError, Transport> =>
  Effect.fail(
    new InvalidAppIdError({
      value: "architect stub — body lands in impl-staff PR (spec D2 #599)",
    }),
  );

// ─── @effect/cli wiring (architect stub — handler delegates to impl-staff) ─

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
 * `moltzap start &lt;name> &lt;participant>... [--message &lt;text>] [--app-id &lt;uuid>]`
 *
 * Architect stub: the underlying `startCommandHandler` is a body that
 * fails fast; impl-staff lands the real body per
 * `packages/client/docs/architecture/09-moltzap-start-cli.md`. The
 * `Command.make` wrapper here exists so impl-staff inherits a complete
 * CLI shape (positional `&lt;name>`, repeated `&lt;participant>...`,
 * `--message`, `--app-id`) with the exact descriptions that will ship.
 */
export const startCommand = Command.make(
  "start",
  {
    name: nameArg,
    participants: participantsArg,
    message: messageOption,
    appId: appIdOption,
  },
  ({ name, participants, message, appId }) =>
    runHandler(
      startCommandHandler({
        name,
        participants,
        message: Option.getOrUndefined(message),
        appId: Option.getOrUndefined(appId),
      }),
    ),
).pipe(
  Command.withDescription(
    "Start a task with named participants and (optionally) send the " +
      "first message in one atomic step. Spec D2 #599 — composes Spec D1 " +
      "TaskCreate + MessagesSend.\n" +
      "\n" +
      "Exit codes:\n" +
      `  ${EXIT_CODES.SUCCESS}   success (TaskCreate + optional MessagesSend resolved)\n` +
      `  ${EXIT_CODES.TASK_CREATE_FAILED}   TaskCreate failed (stdout empty)\n` +
      `  ${EXIT_CODES.PARTIAL_SUCCESS}   TaskCreate OK, MessagesSend failed (no rollback)\n` +
      `  ${EXIT_CODES.USAGE_ERROR}  usage error (bad --app-id UUID or unresolvable agent token)`,
  ),
);
