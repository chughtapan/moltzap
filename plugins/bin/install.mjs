#!/usr/bin/env node
/** @file Runs the installed enrollment command with private custody and fixed, credential-free diagnostics. */

import {
  NodeFileSystem,
  NodeHttpClient,
  NodeRuntime,
} from "@effect/platform-node";
import { Console, Effect } from "effect";
import { runInstaller } from "../dist/install/command.js";

runInstaller(process.argv.slice(2)).pipe(
  Effect.flatMap((result) => Console.log(JSON.stringify(result))),
  Effect.catchTag("InstallFailure", (error) =>
    Console.error(`Installer refused: ${error.reason}`).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = error.reason === "usage" ? 64 : 1;
        }),
      ),
    ),
  ),
  Effect.catchAllCause(() =>
    Console.error("Installer failed; private state is retained.").pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  Effect.provide(NodeFileSystem.layer),
  Effect.provide(NodeHttpClient.layer),
  NodeRuntime.runMain,
);
