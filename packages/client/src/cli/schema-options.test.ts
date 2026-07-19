import { Options, ValidationError } from "@effect/cli";
import { it as effectIt } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf } from "vitest";
import { TaskId } from "@moltzap/protocol/task";
import { parseCliOptions } from "../test-utils/cli-options.js";
import { optionsFromSchema } from "./schema-options.js";

const it = effectIt.effect;

const PageLimit = Schema.Number.pipe(Schema.int(), Schema.between(1, 200));
const INTEGER_USAGE_PLACEHOLDER = '"integer"';

describe("schema option presentation", () => {
  it("derives renamed and kebab-cased scalar options", () =>
    Effect.gen(function* () {
      const Params = Schema.Struct({
        taskId: TaskId,
        sessionKey: Schema.optional(Schema.String),
        limit: Schema.optional(PageLimit),
      });
      const options = optionsFromSchema(Params, {
        taskId: { name: "task", description: "Task id" },
      });
      expectTypeOf(options).toEqualTypeOf<
        Options.Options<Schema.Schema.Type<typeof Params>>
      >();
      expect(JSON.stringify(Options.getUsage(options))).toContain(
        INTEGER_USAGE_PLACEHOLDER,
      );

      const taskId = "00000000-0000-4000-8000-000000000001";
      const parsed = yield* parseCliOptions(options, [
        "--task",
        taskId,
        "--session-key",
        "demo",
        "--limit",
        "25",
      ]);
      expect(parsed).toEqual({
        rest: [],
        value: { taskId, sessionKey: "demo", limit: 25 },
      });
    }));
});

describe("schema option validation", () => {
  it("omits absent fields and retains whole-schema validation", () =>
    Effect.gen(function* () {
      const Params = Schema.Struct({
        taskId: TaskId,
        limit: Schema.optional(PageLimit),
      });
      const options = optionsFromSchema(Params, {
        taskId: { name: "task" },
      });
      const taskId = "00000000-0000-4000-8000-000000000002";

      const parsed = yield* parseCliOptions(options, ["--task", taskId]);
      expect(parsed.value).toEqual({ taskId });
      expect(parsed.value).not.toHaveProperty("limit");

      const invalidId = yield* Effect.flip(
        parseCliOptions(options, ["--task", "not-a-task-id"]),
      );
      expect(ValidationError.isInvalidValue(invalidId)).toBe(true);

      const invalidLimit = yield* Effect.flip(
        parseCliOptions(options, ["--task", taskId, "--limit", "201"]),
      );
      expect(ValidationError.isInvalidValue(invalidLimit)).toBe(true);
    }));
});

describe("schema option decoding", () => {
  it("applies schema transformations and defaults", () =>
    Effect.gen(function* () {
      const Params = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.int()),
        limit: Schema.optionalWith(PageLimit, { default: () => 10 }),
      });
      const options = optionsFromSchema(Params);

      const defaulted = yield* parseCliOptions(options, ["--count", "3"]);
      expect(defaulted.value).toEqual({ count: 3, limit: 10 });

      const explicit = yield* parseCliOptions(options, [
        "--count",
        "3",
        "--limit",
        "20",
      ]);
      expect(explicit.value).toEqual({ count: 3, limit: 20 });
    }));
});

describe("unsupported schema options", () => {
  it("fails fast outside the bounded scalar contract", () =>
    Effect.sync(() => {
      const nested = () =>
        optionsFromSchema(
          Schema.Struct({ nested: Schema.Struct({ value: Schema.String }) }),
        );
      const boolean = () =>
        optionsFromSchema(
          Schema.Struct({ enabled: Schema.optional(Schema.Boolean) }),
        );
      const array = () =>
        optionsFromSchema(
          Schema.Struct({ names: Schema.Array(Schema.String) }),
        );
      const empty = () => optionsFromSchema(Schema.Struct({}));
      const collision = () =>
        optionsFromSchema(
          Schema.Struct({ firstName: Schema.String, lastName: Schema.String }),
          { firstName: { name: "name" }, lastName: { name: "name" } },
        );

      expect(nested).toThrow(/only encoded string and number scalar fields/);
      expect(boolean).toThrow(/only encoded string and number scalar fields/);
      expect(array).toThrow(/only encoded string and number scalar fields/);
      expect(empty).toThrow(/empty Structs/);
      expect(collision).toThrow(/already in use/);
    }));
});
