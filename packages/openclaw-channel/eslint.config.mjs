import { packageEslintConfig } from "../../eslint.shared.mjs";

// `openclaw-entry.ts` is the single boot/factory file (~1100 lines) for
// the channel plugin; splitting along Spec D3's invariants would
// duplicate the wire-format constants. Cap raised to 1200 lines.
export default packageEslintConfig({
  maxLines: 1200,
  tsconfigRootDir: import.meta.dirname,
});
