import { packageEslintConfig } from "../../eslint.shared.mjs";

// `service.ts` is the single MoltZapService class file (~1080 lines);
// further extraction would scatter the state Refs across multiple
// files. Cap raised to 1100 lines.
export default packageEslintConfig({
  maxLines: 1100,
  tsconfigRootDir: import.meta.dirname,
});
