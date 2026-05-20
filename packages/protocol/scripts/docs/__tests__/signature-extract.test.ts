import { describe, expect, it } from "vitest";
import { ReflectionKind } from "typedoc";
import { extractSignatureText } from "../modules.js";

describe("extractSignatureText", () => {
  it("returns null on empty input", () => {
    expect(extractSignatureText("", 1, ReflectionKind.Function)).toBeNull();
    expect(
      extractSignatureText("hello\n", 5, ReflectionKind.Function),
    ).toBeNull();
  });

  it("cuts an arrow-function constant at the `=>`", () => {
    const source = [
      "export const obtainFoo = (",
      "  taskId: TaskId,",
      "): Effect<FooValue, FooError, FooTag> =>",
      "  Effect.gen(function* () {",
      "    return 42;",
      "  });",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Variable);
    expect(sig).toBe(
      [
        "export const obtainFoo = (",
        "  taskId: TaskId,",
        "): Effect<FooValue, FooError, FooTag>",
      ].join("\n"),
    );
  });

  it("cuts a function declaration before its body brace", () => {
    const source = [
      "export function bar(x: number): number {",
      "  return x + 1;",
      "}",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Function);
    expect(sig).toBe("export function bar(x: number): number");
  });

  it("keeps the full body of a class declaration", () => {
    const source = [
      "export class TmAuthority extends Context.Tag(",
      '  "@moltzap/protocol/TmAuthority",',
      ")<TmAuthority, TmAuthorityValue>() {}",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Class);
    expect(sig).toBe(
      [
        "export class TmAuthority extends Context.Tag(",
        '  "@moltzap/protocol/TmAuthority",',
        ")<TmAuthority, TmAuthorityValue>() {}",
      ].join("\n"),
    );
  });

  it("keeps the full body of an interface declaration", () => {
    const source = [
      "export interface AgentExistsValue {",
      "  readonly agentId: AgentId;",
      "  readonly ownerUserId: string | null;",
      "}",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Interface);
    expect(sig).toBe(
      [
        "export interface AgentExistsValue {",
        "  readonly agentId: AgentId;",
        "  readonly ownerUserId: string | null;",
        "}",
      ].join("\n"),
    );
  });

  it("cuts a one-line type alias at its trailing semicolon", () => {
    const source = "export type Foo = string;\n";
    const sig = extractSignatureText(source, 1, ReflectionKind.TypeAlias);
    expect(sig).toBe("export type Foo = string;");
  });

  it("returns null when the line is out of range", () => {
    const source = "line one\nline two\n";
    expect(
      extractSignatureText(source, 99, ReflectionKind.Function),
    ).toBeNull();
    expect(
      extractSignatureText(source, 0, ReflectionKind.Function),
    ).toBeNull();
  });

  it("does not cut on punctuation inside string literals", () => {
    const source = [
      "export const greet = (name: string): string =>",
      '  `hello { ${name} } ; goodbye`;',
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Variable);
    expect(sig).toBe("export const greet = (name: string): string");
  });
});
