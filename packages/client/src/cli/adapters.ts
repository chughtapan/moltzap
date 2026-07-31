/**
 * Shared adapters between Effect schemas and the command-line interface.
 */
import { Options } from "@effect/cli";
import { Option, Schema, SchemaAST } from "effect";

interface SchemaOptionPresentation {
  readonly name?: string;
  readonly description?: string;
}

type SchemaOptionPresentations<I> = Partial<
  Record<Extract<keyof I, string>, SchemaOptionPresentation>
>;

class UnsupportedCliSchemaError extends Error {
  constructor(field: string, astTag: string, reason: string) {
    super(`Cannot generate CLI option for "${field}" (${astTag}): ${reason}`);
    this.name = "UnsupportedCliSchemaError";
  }
}

function unsupported(field: string, astTag: string, reason: string): never {
  throw new UnsupportedCliSchemaError(field, astTag, reason);
}

function kebabCase(value: string): string {
  return value
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    .replace(/^-/, "");
}

function withoutUndefined(ast: SchemaAST.AST): SchemaAST.AST {
  if (!SchemaAST.isUnion(ast)) return ast;
  const members = ast.types.filter(
    (member) => !SchemaAST.isUndefinedKeyword(member),
  );
  return SchemaAST.Union.make(members, ast.annotations);
}

function hasIntegerRefinement(ast: SchemaAST.AST): boolean {
  if (SchemaAST.isRefinement(ast)) {
    return (
      Option.contains(
        SchemaAST.getSchemaIdAnnotation(ast),
        Schema.IntSchemaId,
      ) || hasIntegerRefinement(ast.from)
    );
  }
  if (SchemaAST.isUnion(ast)) return ast.types.some(hasIntegerRefinement);
  if (SchemaAST.isTransformation(ast)) return hasIntegerRefinement(ast.to);
  return false;
}

function propertyName(property: SchemaAST.PropertySignature): string {
  return typeof property.name === "string"
    ? property.name
    : unsupported(
        String(property.name),
        property.type._tag,
        "symbol property keys are not supported",
      );
}

function closedProperties(
  ast: SchemaAST.AST,
  side: "encoded" | "type",
): ReadonlyArray<SchemaAST.PropertySignature> {
  if (!SchemaAST.isTypeLiteral(ast) || ast.indexSignatures.length > 0) {
    return unsupported(
      "<root>",
      ast._tag,
      `the top-level ${side} schema must be a closed Struct`,
    );
  }
  return ast.propertySignatures;
}

function scalarOption(
  field: string,
  name: string,
  encodedAst: SchemaAST.AST,
  validationAst: SchemaAST.AST,
): Options.Options<unknown> {
  if (SchemaAST.isStringKeyword(encodedAst)) return Options.text(name);
  if (SchemaAST.isNumberKeyword(encodedAst)) {
    return hasIntegerRefinement(validationAst)
      ? Options.integer(name)
      : Options.float(name);
  }
  return unsupported(
    field,
    encodedAst._tag,
    "only encoded string and number scalar fields are supported",
  );
}

function fragmentForProperty(
  property: SchemaAST.PropertySignature,
  validationProperty: SchemaAST.PropertySignature,
  presentation: SchemaOptionPresentation,
  claimedNames: Set<string>,
): Options.Options<Readonly<Record<string, unknown>>> {
  const field = propertyName(property);
  const name = presentation.name ?? kebabCase(field);
  if (claimedNames.has(name)) {
    return unsupported(
      field,
      "OptionNameCollision",
      `the option name "${name}" is already in use`,
    );
  }
  claimedNames.add(name);

  const encodedAst = property.isOptional
    ? withoutUndefined(property.type)
    : property.type;
  const validationAst = validationProperty.isOptional
    ? withoutUndefined(validationProperty.type)
    : validationProperty.type;
  const primitive = scalarOption(field, name, encodedAst, validationAst);
  const presented =
    presentation.description === undefined
      ? primitive
      : primitive.pipe(Options.withDescription(presentation.description));

  if (!property.isOptional) {
    return presented.pipe(Options.map((value) => ({ [field]: value })));
  }
  return presented.pipe(
    Options.optional,
    Options.map(
      Option.match({
        onNone: () => ({}),
        onSome: (value) => ({ [field]: value }),
      }),
    ),
  );
}

/**
 * Generates scalar named CLI options from a closed Effect Struct schema.
 * The assembled encoded object is decoded once through the complete schema,
 * keeping brands, transformations, refinements, and defaults authoritative.
 */
export const optionsFromSchema = <
  A extends Readonly<Record<string, unknown>>,
  I extends Readonly<Record<string, unknown>>,
>(
  schema: Schema.Schema<A, I, never>,
  presentations: SchemaOptionPresentations<I> = {},
): Options.Options<A> => {
  const properties = closedProperties(
    Schema.encodedSchema(schema).ast,
    "encoded",
  );
  if (properties.length === 0) {
    return unsupported(
      "<root>",
      "TypeLiteral",
      "empty Structs do not define any CLI options",
    );
  }

  const validationProperties = new Map(
    closedProperties(Schema.typeSchema(schema).ast, "type").map((property) => [
      propertyName(property),
      property,
    ]),
  );
  const presentationByField = new Map(Object.entries(presentations));
  const claimedNames = new Set<string>();
  const fragments = properties.map((property) => {
    const field = propertyName(property);
    const validationProperty = validationProperties.get(field);
    if (validationProperty === undefined) {
      return unsupported(
        field,
        "RenamedProperty",
        "encoded and type-side property names must match",
      );
    }
    return fragmentForProperty(
      property,
      validationProperty,
      presentationByField.get(field) ?? {},
      claimedNames,
    );
  });

  return Options.all(fragments).pipe(
    Options.map((parts): unknown => Object.assign({}, ...parts)),
    Options.withSchema(schema),
  );
};
