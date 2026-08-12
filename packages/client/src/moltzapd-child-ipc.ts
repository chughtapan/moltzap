import { Data, Effect } from "effect";

const READY_MESSAGE_TYPE = "moltzapd.ready";

interface MoltzapdReadyMessage {
  readonly type: typeof READY_MESSAGE_TYPE;
}

const readyMessage: MoltzapdReadyMessage = { type: READY_MESSAGE_TYPE };

/** Reports a failure to deliver readiness over the parent IPC channel. */
export class MoltzapdReadySignalError extends Data.TaggedError(
  "MoltzapdReadySignalError",
)<{
  readonly cause: unknown;
}> {}

/**
 * Whether an IPC payload is the daemon's post-acquisition readiness signal.
 * @param value Untrusted payload received from the child process.
 * @returns Whether the payload is the private readiness message.
 */
export const isMoltzapdReadyMessage = (
  value: unknown,
): value is MoltzapdReadyMessage =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === READY_MESSAGE_TYPE;

/**
 * Signals the supervising parent after this process acquires its daemon.
 * A directly launched daemon has no IPC parent and therefore needs no signal.
 */
export const signalMoltzapdReady: Effect.Effect<
  undefined,
  MoltzapdReadySignalError
> = Effect.async<undefined, MoltzapdReadySignalError>((resume) => {
  if (process.send === undefined) {
    resume(Effect.succeed(undefined));
    return;
  }
  process.send(readyMessage, (cause) => {
    resume(
      cause === null
        ? Effect.succeed(undefined)
        : Effect.fail(new MoltzapdReadySignalError({ cause })),
    );
  });
});
