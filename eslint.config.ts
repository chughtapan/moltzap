/** @file Root ESLint configuration; packages carry their own. */
import { rootEslintConfig } from "./eslint.shared.js";

export default rootEslintConfig(import.meta.dirname);
