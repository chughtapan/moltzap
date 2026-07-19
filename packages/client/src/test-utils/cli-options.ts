import { CliConfig, Options } from "@effect/cli";
import { NodeContext } from "@effect/platform-node";
import { Effect, Option } from "effect";

export const parseCliOptions = <A>(
  options: Options.Options<A>,
  argv: ReadonlyArray<string>,
) =>
  Options.processCommandLine(options, argv, CliConfig.defaultConfig).pipe(
    Effect.flatMap(([error, rest, value]) =>
      Option.match(error, {
        onNone: () => Effect.succeed({ rest, value }),
        onSome: Effect.fail,
      }),
    ),
    Effect.provide(NodeContext.layer),
  );
