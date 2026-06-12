import { Either, ParseResult, Schema } from "effect";
import { stringEnum } from "#transport";

// ═══════════════════════════════════════════════════════════════════
// SHARED — manifest value types.
//
// The manifest hook map declares ONE policy per server→app gate
// (`dispatch_authorize`, `message_authorize`, `task_create`). Each policy is a
// required discriminated union, so a manifest cannot leave a gate unspecified.
// ═══════════════════════════════════════════════════════════════════

const AppManifestConversationSchema = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  participantFilter: Schema.optional(stringEnum(["all", "initiator", "none"])),
});

const HookTimeoutMsSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
);

/**
 * Receive-side admission policy. The app states ONE of:
 *
 * - `{ kind: "grant" }` — every recipient is admitted in-process, no
 *   moderator round-trip.
 * - `{ kind: "deny"; reason }` — every recipient is refused in-process
 *   with the stated reason.
 * - `{ kind: "hook"; timeoutMs }` — the server emits `dispatch/authorize`
 *   to the bound moderator and waits up to `timeoutMs` for the verdict;
 *   timeout / RPC failure collapses to a fail-closed deny.
 *
 * `reason` is required on the static `deny` arm: a policy that refuses
 * by configuration must state why. `timeoutMs` is required on the
 * `hook` arm so a moderated policy always carries its own TTL.
 */
const DispatchAuthorizePolicySchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("grant") }),
  Schema.Struct({ kind: Schema.Literal("deny"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("hook"),
    timeoutMs: HookTimeoutMsSchema,
  }),
);

/**
 * Send-side fan-out policy. The app states ONE of:
 *
 * - `{ kind: "forwardAllExceptSender" }` — every participant except the
 *   sender receives the message, computed in-process from the
 *   conversation's participant set.
 * - `{ kind: "deny"; reason }` — the message reaches no one but the
 *   sender's transcript, with the stated reason.
 * - `{ kind: "hook"; timeoutMs }` — the server emits `messages/authorize`
 *   to the bound TM for a `Forward { recipients } | Block { reason }`
 *   verdict; timeout / RPC failure collapses to a fail-closed Block.
 */
const MessageAuthorizePolicySchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("forwardAllExceptSender") }),
  Schema.Struct({ kind: Schema.Literal("deny"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("hook"),
    timeoutMs: HookTimeoutMsSchema,
  }),
);

/**
 * Task-creation policy. The app states ONE of:
 *
 * - `{ kind: "accept" }` — every requested task is admitted in-process,
 *   transitioning `waiting → active`.
 * - `{ kind: "reject"; reason }` — every requested task is refused
 *   in-process, transitioning `waiting → failed` with the stated reason.
 * - `{ kind: "hook"; timeoutMs }` — the server emits `task/create` to
 *   the bound TM for the accept/reject verdict; timeout / RPC failure
 *   collapses to a fail-closed reject.
 */
const TaskCreatePolicySchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("accept") }),
  Schema.Struct({ kind: Schema.Literal("reject"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("hook"),
    timeoutMs: HookTimeoutMsSchema,
  }),
);

/**
 * Manifest hook map. Three required policies, one per server→app gate:
 * `dispatch_authorize` (receive-side admission), `message_authorize`
 * (send-side fan-out), `task_create` (task-creation gate). Each is a
 * required discriminated union (see the per-policy schemas), so a
 * manifest cannot leave a gate unspecified: omitting a policy is a
 * compile error for an authored manifest and a decode rejection at the
 * wire boundary. "No policy" is unrepresentable — the only absence-of-
 * answer left is a runtime `hook` failure, which the server resolves to
 * a deterministic deny.
 */
const AppManifestHooksSchema = Schema.Struct({
  dispatch_authorize: DispatchAuthorizePolicySchema,
  message_authorize: MessageAuthorizePolicySchema,
  task_create: TaskCreatePolicySchema,
});

/**
 * App manifest. `hooks` is required: every app declares an explicit
 * policy for all three gates (see {@link AppManifestHooksSchema}). An
 * app that wants the open posture states it — `{ kind: "grant" }` /
 * `{ kind: "forwardAllExceptSender" }` / `{ kind: "accept" }` — rather
 * than relying on an omission default.
 */
const AppManifestSchema = Schema.Struct({
  appId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  limits: Schema.optional(
    Schema.Struct({
      maxParticipants: Schema.optional(Schema.Number.pipe(Schema.int())),
    }),
  ),
  conversations: Schema.optional(Schema.Array(AppManifestConversationSchema)),
  hooks: AppManifestHooksSchema,
});

export type AppManifest = Schema.Schema.Type<typeof AppManifestSchema>;

const decodeAppManifest = Schema.decodeUnknownEither(AppManifestSchema);

class AppManifestInvalid extends Schema.TaggedError<AppManifestInvalid>()(
  "AppManifestInvalid",
  { errors: Schema.Array(Schema.String) },
) {}

export type AppManifestValidationResult = Either.Either<
  AppManifest,
  AppManifestInvalid
>;

/**
 * Strict manifest validation. Decodes with `{ onExcessProperty: "error" }` so
 * an extra key rejects the manifest at this trust boundary (an app manifest is
 * operator-supplied configuration, not wire traffic). On failure surfaces every
 * `ParseError` leaf via `ParseResult.ArrayFormatter.formatErrorSync` (one issue
 * → one string).
 */
export function validateAppManifest(
  value: unknown,
): AppManifestValidationResult {
  return Either.mapLeft(
    decodeAppManifest(value, { onExcessProperty: "error" }),
    (parseError) => {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(parseError).map(
        (issue) => `${issue.path.join("/") || "/"} ${issue.message}`,
      );
      return new AppManifestInvalid({
        errors: issues.length > 0 ? issues : ["unknown validation failure"],
      });
    },
  );
}
