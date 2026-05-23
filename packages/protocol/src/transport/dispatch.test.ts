import { describe, expect, it } from "vitest";
import { wireErrorFromInstance } from "./dispatch.js";
import { ConversationFullError, TaskRejectedError } from "../task/methods.js";

describe("wireErrorFromInstance", () => {
  it("falls back to the class static message when the instance message is empty", () => {
    // `Data.TaggedError` instances inherit `message: ""` from `Error`, so an
    // error constructed without an explicit message must still ship its
    // static default on the wire — not the empty string.
    const wire = wireErrorFromInstance(
      new TaskRejectedError({ data: { taskId: "t1" } }),
    );
    expect(wire).not.toBeNull();
    expect(wire?.code).toBe(TaskRejectedError.code);
    expect(wire?.message).toBe(TaskRejectedError.message);
    expect(wire?.message.length).toBeGreaterThan(0);
    expect(wire?.data).toEqual({ taskId: "t1" });
  });

  it("preserves an explicit instance message over the static default", () => {
    const explicit = `${ConversationFullError.message} — over capacity`;
    const wire = wireErrorFromInstance(
      new ConversationFullError({ message: explicit }),
    );
    expect(wire?.message).toBe(explicit);
    expect(wire?.message).not.toBe(ConversationFullError.message);
  });

  it("returns null for a value that is not a registered wire-error", () => {
    expect(wireErrorFromInstance(new Error("plain"))).toBeNull();
    expect(wireErrorFromInstance({ foo: "bar" })).toBeNull();
  });
});
