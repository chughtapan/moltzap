import { Data, Effect } from "effect";

/**
 * Opt-in writer for the OpenClaw channel config file at
 * `~/.openclaw/openclaw.json`. Extracted from `cli/commands/register.ts`
 * so that `moltzap register` is runtime-agnostic by default.
 *
 * During implement-*, the in-line writer in `register.ts` is deleted and
 * replaced by a call to this module gated on an explicit `--openclaw` flag
 * on the register subcommand. If the flag is absent, no file is touched.
 *
 * Keeping the OpenClaw-specific bytes on disk behind an explicit flag
 * removes a silent side effect that tied `moltzap register` to one
 * channel adapter.
 */

/**
 * Channel account bytes written into
 * `config.channels.moltzap.accounts[0]`. Shape matches the existing
 * inline writer's payload so downstream callers do not need to change.
 */
export interface OpenClawAccount {
  readonly apiKey: string;
  readonly serverUrl: string;
  readonly agentName: string;
}

/**
 * Tagged error channel for `writeOpenClawChannelConfig`. Three disjoint
 * failure modes the caller must discriminate: parent directory not
 * writable, existing config file corrupt, or write fails at the final
 * step. No `throw`; every path returns an `Effect.fail`.
 */
export class OpenClawConfigError extends Data.TaggedError(
  "OpenClawConfigError",
)<{
  readonly cause:
    | { readonly _tag: "DirectoryNotWritable"; readonly path: string }
    | { readonly _tag: "ExistingFileCorrupt"; readonly path: string }
    | {
        readonly _tag: "WriteFailed";
        readonly path: string;
        readonly reason: string;
      };
}> {}

/**
 * Write or update `~/.openclaw/openclaw.json` so the OpenClaw channel
 * adapter picks up the freshly-registered MoltZap account on its next
 * file-watcher tick. Only the `channels.moltzap.accounts` entry is
 * rewritten; other channel keys are preserved.
 *
 * Callers: `register` subcommand, iff `--openclaw` is present. No other
 * call site in `@moltzap/client` may invoke this.
 */
export const writeOpenClawChannelConfig = (
  _account: OpenClawAccount,
): Effect.Effect<void, OpenClawConfigError> => {
  throw new Error("not implemented");
};
