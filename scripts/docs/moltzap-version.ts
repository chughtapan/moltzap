/**
 * @file The documentation reader of the MoltZap wire compatibility literal.
 *
 * `packages/identity/src/version.ts` owns the value. Documentation baking
 * reads it without executing the module, so the export must be a literal, and
 * the gate test that plants replacement values rewrites it with the same
 * pattern it is read with — a pattern that drifted between reader and planter
 * would let the plant become a silent no-op. The CommonJS architecture check
 * in `scripts/architecture/check-boundaries.js` carries the same pattern and
 * must keep matching it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Workspace-relative source of `MOLTZAP_VERSION`. */
export const MOLTZAP_VERSION_SOURCE = "packages/identity/src/version.ts";

/** Matches the literal export; group 1 is the value. */
export const MOLTZAP_VERSION_LITERAL =
  /export\s+const\s+MOLTZAP_VERSION\s*=\s*["']([^"']*)["']/;

/**
 * Read the literal from the workspace, or explain why it could not be read.
 * @param workspaceRoot Absolute workspace root.
 * @returns The trimmed literal, or an error message.
 */
export const readMoltzapVersion = (
  workspaceRoot: string,
): { readonly value: string } | { readonly error: string } => {
  const filePath = resolve(workspaceRoot, MOLTZAP_VERSION_SOURCE);
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (cause) {
    return {
      error: `could not read ${MOLTZAP_VERSION_SOURCE}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const match = MOLTZAP_VERSION_LITERAL.exec(source);
  if (match === null) {
    return {
      error: `expected \`export const MOLTZAP_VERSION = "..."\` in ${MOLTZAP_VERSION_SOURCE}`,
    };
  }
  const value = (match[1] ?? "").trim();
  return value.length === 0
    ? { error: `expected a nonempty version in ${MOLTZAP_VERSION_SOURCE}` }
    : { value };
};
