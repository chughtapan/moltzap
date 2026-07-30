import { describe, expect, it } from "vitest";
import { ReflectionKind } from "typedoc";
import { extractSignatureText, resolveExportDeclaration } from "../modules.js";
import type { TypeDocExport } from "../typedoc-load.js";

const mergedExport = (
  name: string,
  kind: number,
  sources: TypeDocExport["sources"],
): TypeDocExport => ({
  id: 1,
  name,
  kind,
  kindString: ReflectionKind[kind] ?? `Unknown(${kind})`,
  packageName: "@moltzap/example",
  sources,
  comment: null,
  signatureReturnTypeName: null,
});

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
      "export class AgentExists extends Context.Tag(",
      '  "@moltzap/protocol/AgentExists",',
      ")<AgentExists, AgentExistsValue>() {}",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Class);
    expect(sig).toBe(
      [
        "export class AgentExists extends Context.Tag(",
        '  "@moltzap/protocol/AgentExists",',
        ")<AgentExists, AgentExistsValue>() {}",
      ].join("\n"),
    );
  });

  it("keeps the full body of an interface declaration", () => {
    const source = [
      "export interface AgentExistsValue {",
      "  readonly agentId: AgentId;",
      "  readonly ownerUserId: UserId;",
      "}",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Interface);
    expect(sig).toBe(
      [
        "export interface AgentExistsValue {",
        "  readonly agentId: AgentId;",
        "  readonly ownerUserId: UserId;",
        "}",
      ].join("\n"),
    );
  });

  it("cuts a one-line type alias at its trailing semicolon", () => {
    const source = "export type Foo = string;\n";
    const sig = extractSignatureText(source, 1, ReflectionKind.TypeAlias);
    expect(sig).toBe("export type Foo = string;");
  });

  it("stops a bracket-free alias before the next declaration", () => {
    const source = [
      "export type Foo = Bar;",
      "",
      "export interface Baz {",
      "  readonly qux: string;",
      "}",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.TypeAlias);
    expect(sig).toBe("export type Foo = Bar;");
  });

  it("returns null when the line is out of range", () => {
    const source = "line one\nline two\n";
    expect(
      extractSignatureText(source, 99, ReflectionKind.Function),
    ).toBeNull();
    expect(extractSignatureText(source, 0, ReflectionKind.Function)).toBeNull();
  });

  it("keeps a class body containing a `>=` comparison intact", () => {
    const source = [
      "export class Counter {",
      "  n = 0;",
      "  bump() {",
      "    if (this.n >= 1) return;",
      "    this.n++;",
      "  }",
      "}",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Class);
    expect(sig).toBe(
      [
        "export class Counter {",
        "  n = 0;",
        "  bump() {",
        "    if (this.n >= 1) return;",
        "    this.n++;",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("keeps an interface body containing a `<=` comparison intact", () => {
    const source = [
      "export interface Bounds {",
      "  readonly check: (n: number) => boolean;",
      "  readonly min: number;",
      "}",
      "// guard: n <= max",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Interface);
    expect(sig).toBe(
      [
        "export interface Bounds {",
        "  readonly check: (n: number) => boolean;",
        "  readonly min: number;",
        "}",
      ].join("\n"),
    );
  });

  it("cuts a function signature whose default-arg uses `>=`", () => {
    const source = [
      "export function gate(n: number = 0): number {",
      "  return n >= 1 ? 1 : 0;",
      "}",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Function);
    expect(sig).toBe("export function gate(n: number = 0): number");
  });

  it("does not cut on punctuation inside string literals", () => {
    const source = [
      "export const greet = (name: string): string =>",
      "  `hello { ${name} } ; goodbye`;",
      "",
    ].join("\n");
    const sig = extractSignatureText(source, 1, ReflectionKind.Variable);
    expect(sig).toBe("export const greet = (name: string): string");
  });

  it("renders the type declaration from a Schema value/type pair", () => {
    const fileName = "v2/identity/src/identity-values.ts";
    const source = [
      "export const AgentId = Schema.String;",
      "export type AgentId = typeof AgentId.Type;",
      "",
    ].join("\n");
    const resolved = resolveExportDeclaration(
      mergedExport("AgentId", ReflectionKind.TypeAlias, [
        { fileName, line: 1, character: 13 },
        { fileName, line: 2, character: 12 },
      ]),
      new Map([[fileName, source]]),
    );

    expect(resolved).toEqual({
      source: { fileName, line: 2, character: 12 },
      signatureText: "export type AgentId = typeof AgentId.Type;",
    });
  });

  it("renders the value declaration from an interface/value pair", () => {
    const fileName = "v2/identity/src/agent-signing-authority.ts";
    const source = [
      "export interface AgentSigningAuthority {",
      '  readonly _brand: "AgentSigningAuthority";',
      "}",
      "export const AgentSigningAuthority = Object.freeze({",
      "  fromPkcs8,",
      "  publicKey,",
      "});",
      "",
    ].join("\n");
    const resolved = resolveExportDeclaration(
      mergedExport("AgentSigningAuthority", ReflectionKind.Variable, [
        { fileName, line: 1, character: 17 },
        { fileName, line: 4, character: 13 },
      ]),
      new Map([[fileName, source]]),
    );

    expect(resolved).toEqual({
      source: { fileName, line: 4, character: 13 },
      signatureText: [
        "export const AgentSigningAuthority = Object.freeze({",
        "  fromPkcs8,",
        "  publicKey,",
        "})",
      ].join("\n"),
    });
  });

  it("keeps the first public overload when declarations share a kind", () => {
    const fileName = "packages/server/src/example.ts";
    const source = [
      "export function send(value: string): string;",
      "export function send(value: number): number;",
      "export function send(value: string | number): string | number {",
      "  return value;",
      "}",
      "",
    ].join("\n");
    const resolved = resolveExportDeclaration(
      mergedExport("send", ReflectionKind.Function, [
        { fileName, line: 1, character: 16 },
        { fileName, line: 2, character: 16 },
        { fileName, line: 3, character: 16 },
      ]),
      new Map([[fileName, source]]),
    );

    expect(resolved).toEqual({
      source: { fileName, line: 1, character: 16 },
      signatureText: "export function send(value: string): string",
    });
  });
});
