/**
 * @file Workspace writer for the generator-owned Mintlify navigation group.
 *
 * Mintlify resolves no file references inside `docs/docs.json`, so the
 * Modules group is written into that file in place: one entry per generated
 * MDX page, sorted, so the navigation and the pages it names come from the
 * same generator run and `docs:check:drift` catches either one moving alone.
 */
import { FileSystem } from "@effect/platform";
import { Effect, Schema, String as StringOps } from "effect";

const MODULES_GROUP = "Modules";

/** Every level keeps the keys the writer does not touch. */
const passthrough = { key: Schema.String, value: Schema.Unknown };

const navigationGroup = Schema.Struct(
  { group: Schema.String, pages: Schema.Array(Schema.Unknown) },
  passthrough,
);

/** The document as written, in source key order. */
const jsonRecord = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

const docsConfig = Schema.Struct(
  {
    navigation: Schema.Struct(
      {
        tabs: Schema.NonEmptyArray(
          Schema.Struct(
            { tab: Schema.String, groups: Schema.Array(navigationGroup) },
            passthrough,
          ),
        ),
      },
      passthrough,
    ),
  },
  passthrough,
);

/**
 * Write the Modules navigation group into the first tab of `docs.json`,
 * replacing an existing group of that name or appending one. Pages are
 * emitted sorted with a stable 2-space indent and LF endings so the file
 * stays diff-stable across runs.
 * @param docsJsonPath Absolute path of `docs/docs.json`.
 * @param pageSlugs Generated page slugs relative to `docs/modules/`.
 * @returns The write modules nav result.
 */
export const writeModulesNav = (
  docsJsonPath: string,
  pageSlugs: readonly string[],
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(docsJsonPath).pipe(Effect.orDie);
    const document = yield* Schema.decodeUnknown(jsonRecord)(source).pipe(
      Effect.orDie,
    );
    const config = yield* Schema.decodeUnknown(docsConfig)(document).pipe(
      Effect.orDie,
    );
    const modules = {
      group: MODULES_GROUP,
      pages: [...pageSlugs]
        .map((slug) => `modules/${slug}`)
        .sort((left, right) => StringOps.localeCompare(right)(left)),
    };
    const [firstTab, ...otherTabs] = config.navigation.tabs;
    const groups = firstTab.groups.some(
      (group) => group.group === MODULES_GROUP,
    )
      ? firstTab.groups.map((group) =>
          group.group === MODULES_GROUP ? modules : group,
        )
      : [...firstTab.groups, modules];
    const navigation = {
      ...config.navigation,
      tabs: [{ ...firstTab, groups }, ...otherTabs],
    };
    // A decoded struct lists its declared fields first; re-key from the
    // document so every other key keeps the position it was written in.
    const updated = Object.fromEntries(
      Object.keys(document).map((key) => [
        key,
        key === "navigation" ? navigation : document[key],
      ]),
    );
    const json = `${JSON.stringify(updated, null, 2)}\n`;
    if (json === source) {
      return;
    }
    const tmp = `${docsJsonPath}.tmp.${process.pid}`;
    yield* fs.writeFileString(tmp, json).pipe(Effect.orDie);
    yield* fs.rename(tmp, docsJsonPath).pipe(Effect.orDie);
  }).pipe(Effect.withSpan("writeModulesNav"));
