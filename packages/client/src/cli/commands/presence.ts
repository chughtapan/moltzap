import { Args, Command } from "@effect/cli";
import { Effect, Option } from "effect";
import { request } from "../socket-client.js";

const statusArg = Args.text({ name: "status" }).pipe(
  Args.withDescription("Status to set: online, offline, or away"),
  Args.optional,
);

/**
 * `moltzap presence <status>` — pushes a presence update through the local
 * Unix socket. Status argument is optional; missing → prints usage. Unknown
 * values exit 1 after a stderr message.
 */
export const presenceCommand = Command.make(
  "presence",
  { status: statusArg },
  ({ status }) => {
    if (Option.isNone(status)) {
      return Effect.sync(() => {
        console.log("Usage: moltzap presence <online|offline|away>");
      });
    }
    const value = status.value;
    const valid = ["online", "offline", "away"];
    if (!valid.includes(value)) {
      return Effect.sync(() => {
        console.error(
          `Invalid status "${value}". Must be one of: ${valid.join(", ")}`,
        );
        process.exit(1);
      });
    }
    return request("presence/update", { status: value }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          console.log(`Presence set to ${value}.`);
        }),
      ),
      Effect.asVoid,
      Effect.catchAll((err) =>
        Effect.sync(() => {
          console.error(`Failed: ${err.message}`);
          process.exit(1);
        }),
      ),
    );
  },
).pipe(
  Command.withDescription(
    "Update or show presence status (online, offline, away)",
  ),
);
