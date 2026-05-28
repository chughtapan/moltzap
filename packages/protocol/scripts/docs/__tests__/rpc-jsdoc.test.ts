import { describe, expect, it } from "vitest";
import { parseErrorTag, parseJsDocText } from "../rpc-jsdoc.js";

describe("parseErrorTag", () => {
  it("returns null without ' when ' marker", () => {
    expect(parseErrorTag("ForbiddenError")).toBeNull();
  });

  it("rejects type names containing whitespace", () => {
    expect(parseErrorTag("Conflict Error when something happens")).toBeNull();
  });

  it("returns name + when prose for a valid tag", () => {
    expect(parseErrorTag("ConflictError when name already taken")).toEqual({
      name: "ConflictError",
      when: "name already taken",
    });
  });

  it("preserves prose that itself contains ' when '", () => {
    expect(parseErrorTag("AbortError when called when paused")).toEqual({
      name: "AbortError",
      when: "called when paused",
    });
  });
});

describe("parseJsDocText", () => {
  it("returns empty struct for an empty block", () => {
    const parsed = parseJsDocText("/** */");
    expect(parsed.description).toBeNull();
    expect(parsed.errors).toEqual([]);
  });

  it("lifts the description from the leading paragraph", () => {
    const text = `/**
 * Register a new agent and receive an API key.
 */`;
    expect(parseJsDocText(text).description).toBe(
      "Register a new agent and receive an API key.",
    );
  });

  it("splits description and body at the first blank line", () => {
    const text = `/**
 * First sentence only.
 *
 * Second paragraph body.
 */`;
    const parsed = parseJsDocText(text);
    expect(parsed.description).toBe("First sentence only.");
    expect(parsed.body).toBe("Second paragraph body.");
  });

  it("collects @returns", () => {
    const text = `/**
 * Summary.
 *
 * @returns The new ID.
 */`;
    expect(parseJsDocText(text).resultDescription).toBe("The new ID.");
  });

  it("collects multiple @error tags", () => {
    const text = `/**
 * Summary.
 *
 * @error ConflictError when name already taken
 * @error InvalidParamsError when name violates the pattern
 */`;
    expect(parseJsDocText(text).errors).toEqual([
      { name: "ConflictError", when: "name already taken" },
      {
        name: "InvalidParamsError",
        when: "name violates the pattern",
      },
    ]);
  });

  it("collects @relatedNotification and @triggeredBy", () => {
    const text = `/**
 * Summary.
 *
 * @relatedNotification messages/received
 * @triggeredBy messages/send
 */`;
    const parsed = parseJsDocText(text);
    expect(parsed.relatedNotifications).toEqual(["messages/received"]);
    expect(parsed.triggeredBy).toEqual(["messages/send"]);
  });

  it("ignores unknown tags", () => {
    const text = `/**
 * Summary.
 *
 * @author Someone
 */`;
    const parsed = parseJsDocText(text);
    expect(parsed.description).toBe("Summary.");
    expect(parsed.errors).toEqual([]);
  });
});
