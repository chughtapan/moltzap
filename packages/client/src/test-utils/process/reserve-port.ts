import { Data, Effect } from "effect";
import { createServer } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

/** Reports a failure to reserve a loopback port for a test slot. */
class ReserveTestMcpPortError extends Data.TaggedError(
  "ReserveTestMcpPortError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Reserve a free loopback port for a test slot.
 *
 * The daemon binds exactly the port its slot names and never selects one, so a
 * test reserves the port here and writes it into the slot before starting the
 * child.
 */
export const reserveTestMcpPort = Effect.async<number, ReserveTestMcpPortError>(
  (resume) => {
    const server = createServer();
    const onError = (cause: Error): void => {
      resume(
        Effect.fail(
          new ReserveTestMcpPortError({ message: cause.message, cause }),
        ),
      );
    };
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        resume(
          Effect.fail(
            new ReserveTestMcpPortError({
              message: "reserved listener exposed no TCP port",
            }),
          ),
        );
        return;
      }
      server.close(() => {
        resume(Effect.succeed(address.port));
      });
    });
    return Effect.sync(() => {
      server.off("error", onError);
      if (server.listening) {
        server.close();
      }
    });
  },
);
